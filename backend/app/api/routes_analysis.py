"""Player analysis and the v3 source-video biomechanics replay."""

import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from app.analysis import compare, feedback
from app.analysis.biomechanics import compute_frame_biomechanics
from app.analysis.capture_quality import assess_capture
from app.analysis.metrics import compute_all, measurement_evidence
from app.analysis.phases import segment
from app.benchmarks.templates import (
    ACTIVE_TEMPLATE_ID,
    load_template,
    template_video_path,
)
from app.core.config import Settings, get_settings
from app.core.storage import analysis_lock, atomic_write as _atomic_write
from app.core.retention import media_expired
from app.core.video import AnalysisBusy, MAX_CLIP_DURATION_MS, inference_slot, validate_video
from app.pose import get_backend
from app.pose.ball_detector import track_window
from app.schemas.analysis import (
    AnalysisQuality,
    AnalysisResult,
    CaptureQuality,
    MetricValue,
)
from app.schemas.pose import ShotSequence
from app.schemas.template import (
    ReplayPayload,
    ReplaySync,
    ReplayWindow,
    SyncAnchor,
)

router = APIRouter()

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".webm"}
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
ANALYSIS_ID_RE = re.compile(r"^[a-f0-9]{12,32}$")

Cfg = Annotated[Settings, Depends(get_settings)]


def _ensure_dirs(cfg: Settings) -> None:
    for directory in (cfg.analyses_dir, cfg.uploads_dir, cfg.keypoints_dir):
        directory.mkdir(parents=True, exist_ok=True)


def _result_path(cfg: Settings, analysis_id: str) -> Path:
    if not ANALYSIS_ID_RE.fullmatch(analysis_id):
        raise HTTPException(404, f"no analysis '{analysis_id}'")
    return cfg.analyses_dir / f"{analysis_id}.json"


def _load_result(cfg: Settings, analysis_id: str) -> AnalysisResult:
    path = _result_path(cfg, analysis_id)
    if not path.is_file():
        raise HTTPException(404, f"no analysis '{analysis_id}'")
    result = AnalysisResult.model_validate(json.loads(path.read_text(encoding="utf-8")))
    if result.media_expires_at is None:
        result.media_expires_at = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) + timedelta(hours=cfg.media_ttl_hours)
    return result


def _resolve_template(cfg: Settings, template_id: str | None):
    requested = template_id or ACTIVE_TEMPLATE_ID
    if requested != ACTIVE_TEMPLATE_ID:
        raise HTTPException(
            410,
            f"template '{requested}' is retired; all comparisons use {ACTIVE_TEMPLATE_ID}",
        )
    try:
        return load_template(cfg, requested)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(503, f"curry_v3 reference is unavailable: {exc}")


def _quality(
    metrics: list[MetricValue], phases, capture: CaptureQuality | None
) -> AnalysisQuality:
    reliable = [
        metric for metric in metrics if metric.reliable and metric.value is not None
    ]
    missing = [
        metric.name for metric in metrics if not metric.reliable or metric.value is None
    ]
    degraded = [phase.phase for phase in phases if phase.degraded or phase.censored]
    expected = len(metrics)
    coverage = len(reliable) / max(expected, 1)
    reasons = []
    if missing:
        reasons.append(f"{len(missing)} of {expected} metrics lack reliable evidence")
    if degraded:
        reasons.append(
            "one or more shooting phases contain missing or clipped pose data"
        )
    if capture and capture.status != "pass":
        reasons.extend(capture.reasons)
    status = "valid"
    if len(reliable) < 3:
        status = "insufficient"
    elif missing or degraded or (capture and capture.status != "pass"):
        status = "degraded"
    return AnalysisQuality(
        status=status,
        coverage=round(coverage, 3),
        valid_metrics=len(reliable),
        expected_metrics=expected,
        missing_metrics=missing,
        degraded_phases=degraded,
        reasons=reasons,
    )


def _compare_result(
    cfg: Settings,
    base: AnalysisResult,
    template,
    player_metrics: dict[str, float],
    evidence: dict[str, dict[str, float | bool | str | None]],
) -> AnalysisResult:
    deltas = compare.metric_deltas(player_metrics, template, evidence)
    quality = _quality(deltas, base.phases, base.capture_quality)
    overall = compare.similarity_score(deltas)
    if quality.status == "insufficient":
        overall = None
    return base.model_copy(
        update={
            "benchmark_version": template.version,
            "template_id": template.version,
            "template_name": template.display_name or template.version,
            "timing_mode": template.timing_mode,
            "timing_reliable": template.timing_reliable,
            "similarity_score": overall,
            "form_score": compare.similarity_score(deltas, "form"),
            "timing_score": compare.similarity_score(deltas, "timing"),
            "quality": quality,
            "metrics": deltas,
            "measurement_evidence": evidence,
            "feedback": feedback.rank(deltas),
            "benchmark_sequence": None,
            "benchmark_phases": template.canonical_phases,
            "template_video_url": (
                f"/api/v1/templates/{template.version}/video"
                if template_video_path(cfg, template)
                else None
            ),
        }
    )


@router.post("/analysis", response_model=AnalysisResult)
def create_analysis(
    video: UploadFile,
    cfg: Cfg,
    template_id: Annotated[str | None, Form()] = None,
) -> AnalysisResult:
    ext = Path(video.filename or "clip.mp4").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(422, f"unsupported video type '{ext}' — use mp4/mov/webm")
    template = _resolve_template(cfg, template_id)

    _ensure_dirs(cfg)
    analysis_id = uuid.uuid4().hex
    video_path = cfg.uploads_dir / f"{analysis_id}{ext}"
    result_path = _result_path(cfg, analysis_id)
    keypoints_path = cfg.keypoints_dir / f"{analysis_id}.json"
    # Hold the same lock used by cleanup until the report commits or rollback completes.
    with analysis_lock(cfg.data_dir, analysis_id):
        try:
            with inference_slot(cfg.analysis_concurrency):
                written = 0
                with video_path.open("wb") as target:
                    while chunk := video.file.read(1024 * 1024):
                        written += len(chunk)
                        if written > MAX_UPLOAD_BYTES:
                            raise HTTPException(413, "clip exceeds 50 MB")
                        target.write(chunk)
                validate_video(video_path)
                sequence = get_backend(cfg).estimate_video(video_path)
                if not sequence.frames:
                    raise ValueError("video contains no decoded frames")
                if sequence.frames[-1].t_ms - sequence.frames[0].t_ms > MAX_CLIP_DURATION_MS:
                    raise ValueError("clip exceeds 12 seconds — upload one shot only")
                phases = segment(sequence)
                sequence.ball_track = track_window(cfg, video_path, phases)
                player_metrics = compute_all(sequence, phases)
                evidence = measurement_evidence(sequence, phases)
                capture_quality = assess_capture(sequence, phases)
                expires_at = datetime.now(timezone.utc) + timedelta(hours=cfg.media_ttl_hours)
                base = AnalysisResult(
                    analysis_id=analysis_id,
                    benchmark_version=template.version,
                    similarity_score=None,
                    phases=phases,
                    metrics=[],
                    feedback=[],
                    capture_quality=capture_quality,
                    player_video_url=f"/api/v1/analysis/{analysis_id}/video",
                    media_expires_at=expires_at,
                )
                result = _compare_result(cfg, base, template, player_metrics, evidence)
                _atomic_write(keypoints_path, sequence.model_dump_json())
                _atomic_write(result_path, result.model_dump_json(indent=2))
                return result
        except BaseException as exc:
            for path in (video_path, keypoints_path, result_path):
                path.unlink(missing_ok=True)
            if isinstance(exc, AnalysisBusy):
                raise HTTPException(429, str(exc), headers={"Retry-After": "5"}) from exc
            if isinstance(exc, (ValueError, RuntimeError)):
                raise HTTPException(422, str(exc)) from exc
            raise
        finally:
            video.file.close()


def _active_result(cfg: Settings, analysis_id: str) -> AnalysisResult:
    _result_path(cfg, analysis_id)
    with analysis_lock(cfg.data_dir, analysis_id):
        return _active_result_locked(cfg, analysis_id)


def _active_result_locked(cfg: Settings, analysis_id: str) -> AnalysisResult:
    base = _load_result(cfg, analysis_id)
    is_active = (base.template_id or base.benchmark_version) == ACTIVE_TEMPLATE_ID
    if media_expired(base.media_expires_at):
        # Old reports may contain inline pose data. Never return expired media in JSON.
        if base.player_sequence is not None or base.benchmark_sequence is not None:
            base = base.model_copy(update={"player_sequence": None, "benchmark_sequence": None})
            _atomic_write(_result_path(cfg, analysis_id), base.model_dump_json(indent=2))
        if not is_active:
            raise HTTPException(410, "legacy analysis pose data has expired")
        return base
    if is_active and base.capture_quality is not None:
        return base
    keypoints_path = cfg.keypoints_dir / f"{analysis_id}.json"
    if not keypoints_path.is_file():
        if is_active:
            return base
        raise HTTPException(
            410,
            "legacy analysis cannot be migrated because its pose data has expired",
        )
    sequence = ShotSequence.model_validate_json(keypoints_path.read_text(encoding="utf-8"))
    if is_active:
        result = base.model_copy(
            update={"capture_quality": assess_capture(sequence, base.phases)}
        )
        _atomic_write(_result_path(cfg, analysis_id), result.model_dump_json(indent=2))
        return result
    phases = segment(sequence)
    capture_quality = assess_capture(sequence, phases)
    migrated_base = base.model_copy(
        update={"phases": phases, "capture_quality": capture_quality}
    )
    result = _compare_result(
        cfg,
        migrated_base,
        _resolve_template(cfg, ACTIVE_TEMPLATE_ID),
        compute_all(sequence, phases),
        measurement_evidence(sequence, phases),
    )
    _atomic_write(_result_path(cfg, analysis_id), result.model_dump_json(indent=2))
    return result


@router.get("/analysis/{analysis_id}", response_model=AnalysisResult)
def get_analysis(analysis_id: str, cfg: Cfg) -> AnalysisResult:
    return _active_result(cfg, analysis_id)


@router.get("/analysis/{analysis_id}/comparison", response_model=AnalysisResult)
def compare_with_template(
    analysis_id: str, cfg: Cfg, template_id: str | None = None
) -> AnalysisResult:
    base = _active_result(cfg, analysis_id)
    template = _resolve_template(cfg, template_id)
    player_metrics = {
        metric.name: metric.value for metric in base.metrics if metric.value is not None
    }
    evidence = base.measurement_evidence or {
        metric.name: {
            "confidence": metric.confidence,
            "coverage": metric.coverage,
            "reliable": metric.reliable,
            "reason": metric.unavailable_reason,
        }
        for metric in base.metrics
    }
    return _compare_result(cfg, base, template, player_metrics, evidence)


@router.get("/analysis/{analysis_id}/replay", response_model=ReplayPayload)
def replay(analysis_id: str, cfg: Cfg, template_id: str | None = None) -> ReplayPayload:
    base = _active_result(cfg, analysis_id)
    if media_expired(base.media_expires_at):
        raise HTTPException(410, "skeleton replay data has expired")
    template = _resolve_template(cfg, template_id)
    keypoints_path = cfg.keypoints_dir / f"{analysis_id}.json"
    if keypoints_path.is_file():
        player_sequence = ShotSequence.model_validate_json(keypoints_path.read_text(encoding="utf-8"))
    elif base.player_sequence is not None:
        player_sequence = base.player_sequence
    else:
        raise HTTPException(410, "skeleton replay data has expired")
    if template.canonical_sequence is None:
        raise HTTPException(404, f"template '{template.version}' has no skeleton data")
    player_window = _replay_window(player_sequence, base.phases)
    template_window = _replay_window(
        template.canonical_sequence, template.canonical_phases
    )
    anchors = []
    for name in ("dip", "release"):
        player_phase = next(phase for phase in base.phases if phase.phase == name)
        template_phase = next(
            phase for phase in template.canonical_phases if phase.phase == name
        )
        anchors.append(
            SyncAnchor(
                name=name,
                player_ms=player_phase.anchor_ms or player_phase.start_ms,
                template_ms=template_phase.anchor_ms or template_phase.start_ms,
                confidence=(
                    0.4
                    if player_phase.degraded
                    or template_phase.degraded
                    or player_phase.censored
                    or template_phase.censored
                    else 1.0
                ),
            )
        )
    sync_reason = (
        "one or more alignment anchors have low-confidence pose evidence"
        if any(anchor.confidence < 0.75 for anchor in anchors)
        else None
    )
    return ReplayPayload(
        analysis_id=analysis_id,
        template_id=template.version,
        timing_mode=template.timing_mode,
        timing_reliable=template.timing_reliable,
        player_sequence=player_sequence,
        player_phases=base.phases,
        template_sequence=template.canonical_sequence,
        template_phases=template.canonical_phases,
        player_video_url=base.player_video_url,
        template_video_url=(
            f"/api/v1/templates/{template.version}/video"
            if template_video_path(cfg, template)
            else None
        ),
        player_window=player_window,
        template_window=template_window,
        sync=ReplaySync(
            available_modes=["independent", "realtime_locked"],
            anchors=anchors,
            unavailable_reason=sync_reason,
        ),
        player_biomechanics=compute_frame_biomechanics(player_sequence, base.phases),
        template_biomechanics=compute_frame_biomechanics(
            template.canonical_sequence, template.canonical_phases
        ),
    )


def _replay_window(
    sequence: ShotSequence, phases
) -> ReplayWindow:
    dip = next(phase for phase in phases if phase.phase == "dip")
    release = next(phase for phase in phases if phase.phase == "release")
    start_ms = phases[0].start_ms
    end_ms = phases[-1].end_ms
    return ReplayWindow(
        start_ms=start_ms,
        end_ms=end_ms,
        duration_ms=max(end_ms - start_ms, 1),
        fps=sequence.fps,
        dip_anchor_ms=dip.anchor_ms or dip.start_ms,
        release_anchor_ms=release.anchor_ms or release.start_ms,
    )


@router.get("/analysis/{analysis_id}/video")
def analysis_video(analysis_id: str, cfg: Cfg) -> FileResponse:
    result = _load_result(cfg, analysis_id)
    if media_expired(result.media_expires_at):
        raise HTTPException(410, "source video has expired")
    matches = [
        path
        for path in cfg.uploads_dir.glob(f"{analysis_id}.*")
        if path.suffix in ALLOWED_EXTENSIONS
    ]
    if not matches:
        raise HTTPException(410, "source video is no longer available")
    return FileResponse(matches[0], filename=matches[0].name)


@router.delete("/analysis/{analysis_id}", status_code=204)
def delete_analysis(analysis_id: str, cfg: Cfg) -> Response:
    result_path = _result_path(cfg, analysis_id)
    with analysis_lock(cfg.data_dir, analysis_id):
        if not result_path.exists():
            raise HTTPException(404, f"no analysis '{analysis_id}'")
        # Delete the report last, so interrupted deletion remains discoverable by cleanup.
        (cfg.keypoints_dir / f"{analysis_id}.json").unlink(missing_ok=True)
        for path in cfg.uploads_dir.glob(f"{analysis_id}.*"):
            if path.suffix in ALLOWED_EXTENSIONS:
                path.unlink(missing_ok=True)
        result_path.unlink()
    return Response(status_code=204)
