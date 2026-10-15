"""Player analysis and the v3 source-video biomechanics replay."""

import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from app.api.validation import StringDetailRoute
from app.analysis.biomechanics import compute_frame_biomechanics
from app.analysis.capture_quality import assess_capture
from app.analysis.metrics import compute_all, measurement_evidence
from app.analysis.phases import segment
from app.analysis.rating import rate_release_timing
from app.analysis.results import (
    MeasurementEvidence,
    apply_comparison_policy,
    build_comparison,
    measurement_inputs,
    migration_evidence,
)
from app.benchmarks.templates import (
    ACTIVE_TEMPLATE_ID,
    load_template,
    template_video_path,
    template_source_video_path,
)
from app.core.config import Settings, get_settings
from app.core.artifacts import verify_analysis_artifacts
from app.core.storage import analysis_lock, atomic_write as _atomic_write
from app.core.retention import media_expired
from app.core.media_import import prepare_upload
from app.core.video import AnalysisBusy, MAX_CLIP_DURATION_MS, inference_slot, validate_video
from app.pose import get_backend
from app.pose.ball_detector import track_window
from app.schemas.analysis import AnalysisResult
from app.schemas.benchmark import BenchmarkProfile
from app.schemas.pose import ShotSequence
from app.schemas.media_source import ClipImportRequest, parse_import_request
from app.schemas.template import (
    ReplayPayload,
    ReplaySync,
    ReplayWindow,
    SyncAnchor,
)

router = APIRouter(route_class=StringDetailRoute)

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".webm"}
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


def _resolve_template(cfg: Settings, template_id: str | None) -> BenchmarkProfile:
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


def _compare_result(
    cfg: Settings,
    base: AnalysisResult,
    template: BenchmarkProfile,
    player_metrics: dict[str, float],
    evidence: MeasurementEvidence,
) -> AnalysisResult:
    return build_comparison(base, template, player_metrics, evidence).model_copy(
        update={
            "template_video_url": (
                f"/api/v1/templates/{template.version}/video"
                if template_video_path(cfg, template)
                else None
            ),
            "template_source_video_url": (
                f"/api/v1/templates/{template.version}/source-video"
                if template_source_video_path(cfg, template) else None
            ),
        }
    )


@router.post("/analysis", response_model=AnalysisResult)
def create_analysis(
    video: UploadFile,
    cfg: Cfg,
    template_id: Annotated[str | None, Form()] = None,
    source: Annotated[str | None, Form()] = None,
) -> AnalysisResult:
    try:
        try:
            import_request = parse_import_request(source)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return _create_analysis(video, cfg, template_id, import_request)
    finally:
        video.file.close()


def _create_analysis(
    video: UploadFile,
    cfg: Settings,
    template_id: str | None,
    source: ClipImportRequest | None,
) -> AnalysisResult:
    ext = Path(video.filename or "clip.mp4").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(422, f"unsupported video type '{ext}' — use mp4/mov/webm")
    template = _resolve_template(cfg, template_id)
    failures = verify_analysis_artifacts(cfg)
    if failures:
        raise HTTPException(503, "analysis artifacts are unavailable: " + "; ".join(failures))

    _ensure_dirs(cfg)
    analysis_id = uuid.uuid4().hex
    video_path = None
    result_path = _result_path(cfg, analysis_id)
    keypoints_path = cfg.keypoints_dir / f"{analysis_id}.json"
    # Hold the same lock used by cleanup until the report commits or rollback completes.
    with analysis_lock(cfg.data_dir, analysis_id):
        try:
            video_path, media_source = prepare_upload(
                video, cfg.uploads_dir, analysis_id, source,
                concurrency=cfg.analysis_concurrency,
            )
            validate_video(video_path)
            # Take the concurrency slot only after the body is written and
            # validated — a slow client must not block other analyses' slots.
            with inference_slot(cfg.analysis_concurrency):
                backend = get_backend(cfg)
                if media_source and media_source.subject_roi is not None:
                    if backend.name != "yolo":
                        raise ValueError("subject ROI requires the YOLO pose backend")
                    sequence = backend.estimate_video(video_path, subject_roi=media_source.subject_roi)
                else:
                    sequence = backend.estimate_video(video_path)
                if not sequence.frames:
                    raise ValueError("video contains no decoded frames")
                if sequence.frames[-1].t_ms - sequence.frames[0].t_ms > MAX_CLIP_DURATION_MS:
                    raise ValueError("clip exceeds 12 seconds — upload one shot only")
                phases = segment(sequence)
                sequence.ball_track = track_window(cfg, video_path, phases)
                shot_rating = rate_release_timing(sequence, phases)
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
                    source=media_source,
                    shot_rating=shot_rating,
                    player_video_url=f"/api/v1/analysis/{analysis_id}/video",
                    media_expires_at=expires_at,
                )
                result = _compare_result(cfg, base, template, player_metrics, evidence)
                _atomic_write(keypoints_path, sequence.model_dump_json())
                _atomic_write(result_path, result.model_dump_json(indent=2))
                return result
        except BaseException as exc:
            for path in (video_path, keypoints_path, result_path):
                if path is not None:
                    path.unlink(missing_ok=True)
            if isinstance(exc, AnalysisBusy):
                raise HTTPException(429, str(exc), headers={"Retry-After": "5"}) from exc
            if isinstance(exc, (ValueError, RuntimeError)):
                raise HTTPException(422, str(exc)) from exc
            raise


def _active_result(cfg: Settings, analysis_id: str) -> AnalysisResult:
    _result_path(cfg, analysis_id)
    with analysis_lock(cfg.data_dir, analysis_id):
        return _active_result_locked(cfg, analysis_id)


def _active_result_locked(cfg: Settings, analysis_id: str) -> AnalysisResult:
    base = _load_result(cfg, analysis_id)
    is_active = (base.template_id or base.benchmark_version) == ACTIVE_TEMPLATE_ID
    expired = media_expired(base.media_expires_at)
    keypoints_path = cfg.keypoints_dir / f"{analysis_id}.json"
    if expired and not is_active:
        # Expired legacy reports may still contain inline media. Strip it even
        # though their absent replay data prevents migration to the active template.
        if base.player_sequence is not None or base.benchmark_sequence is not None:
            stripped = base.model_copy(update={"player_sequence": None, "benchmark_sequence": None})
            _atomic_write(_result_path(cfg, analysis_id), stripped.model_dump_json(indent=2))
        raise HTTPException(410, "legacy analysis pose data has expired")
    if is_active:
        result = base
        if not expired and base.capture_quality is None and keypoints_path.is_file():
            sequence = ShotSequence.model_validate_json(keypoints_path.read_text(encoding="utf-8"))
            result = base.model_copy(update={"capture_quality": assess_capture(sequence, base.phases)})
        result = apply_comparison_policy(result)
        if expired:
            # Compact reports remain readable; replay and inline media do not.
            result = result.model_copy(update={"player_sequence": None, "benchmark_sequence": None})
    else:
        if not keypoints_path.is_file():
            raise HTTPException(
                410,
                "legacy analysis cannot be migrated because its pose data has expired",
            )
        sequence = ShotSequence.model_validate_json(keypoints_path.read_text(encoding="utf-8"))
        phases = segment(sequence)
        migrated_base = base.model_copy(update={
            "phases": phases,
            "capture_quality": assess_capture(sequence, phases),
        })
        result = _compare_result(
            cfg,
            migrated_base,
            _resolve_template(cfg, ACTIVE_TEMPLATE_ID),
            compute_all(sequence, phases),
            migration_evidence(base, measurement_evidence(sequence, phases)),
        )
    if result != base:
        _atomic_write(_result_path(cfg, analysis_id), result.model_dump_json(indent=2))
    return result


@router.get("/analysis/{analysis_id}", response_model=AnalysisResult)
def get_analysis(analysis_id: str, cfg: Cfg) -> AnalysisResult:
    result = _active_result(cfg, analysis_id)
    # Optional source media can be restored after a compact report was created.
    try:
        source = template_source_video_path(cfg, _resolve_template(cfg, result.template_id))
    except HTTPException:
        source = None
    return result.model_copy(update={"template_source_video_url": (
        f"/api/v1/templates/{ACTIVE_TEMPLATE_ID}/source-video" if source else None
    )})


@router.get("/analysis/{analysis_id}/comparison", response_model=AnalysisResult)
def compare_with_template(
    analysis_id: str, cfg: Cfg, template_id: str | None = None
) -> AnalysisResult:
    base = _active_result(cfg, analysis_id)
    template = _resolve_template(cfg, template_id)
    player_metrics, evidence = measurement_inputs(base)
    return _compare_result(cfg, base, template, player_metrics, evidence)


@router.get("/analysis/{analysis_id}/replay", response_model=ReplayPayload)
def replay(analysis_id: str, cfg: Cfg, template_id: str | None = None) -> ReplayPayload:
    base = _active_result(cfg, analysis_id)
    if media_expired(base.media_expires_at):
        raise HTTPException(410, "skeleton replay data has expired")
    template = _resolve_template(cfg, template_id)
    keypoints_path = cfg.keypoints_dir / f"{analysis_id}.json"
    # The retention sweep deletes keypoints while holding the non-blocking
    # lock, so read it under the same lock or the file can vanish mid-request.
    with analysis_lock(cfg.data_dir, analysis_id):
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
        player_biomechanics=compute_frame_biomechanics(
            player_sequence, base.phases,
            timing_reliable=base.source is None or base.source.timing_mode == "realtime",
        ),
        template_biomechanics=compute_frame_biomechanics(
            template.canonical_sequence, template.canonical_phases,
            timing_reliable=template.timing_reliable,
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
    # Resolve the path under the lock: the retention sweep and delete endpoint
    # unlink uploads under the same stripe, so this check cannot race them.
    # (The later open is lazy, but the residual window is one scheduler tick;
    # retention treats a failed unlink as skippable, not fatal.)
    with analysis_lock(cfg.data_dir, analysis_id):
        matches = [
            path
            for path in cfg.uploads_dir.glob(f"{analysis_id}.*")
            if path.suffix in ALLOWED_EXTENSIONS
        ]
        if not matches or not matches[0].is_file():
            raise HTTPException(410, "source video is no longer available")
        path = matches[0]
    return FileResponse(path, filename=path.name)


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
