"""Frame-by-frame comparison API: players, action templates, clips, comparisons."""

import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, ValidationError

from app.api.validation import StringDetailRoute, validation_detail
from app.compare import store
from app.compare.alignment import (
    _match_pair,
    check_camera,
    fit_affine,
    person_mask,
    sample_frame_indices,
)
from app.compare.report import build_report, cleanup_report_files
from app.compare.signals import suggest_offset_ms
from app.core.config import Settings, get_settings
from app.core.media_import import prepare_upload
from app.core.video import AnalysisBusy, inference_slot, validate_video
from app.pose import get_backend
from app.schemas.compare import (
    ActionTemplate,
    ActionTemplateCreate,
    AffineTransform,
    ClipMeta,
    ComparisonCreate,
    ComparisonState,
    ComparisonUpdate,
    EventMarker,
    PhaseBoundary,
    Player,
    PlayerCreate,
    TemporalAlignment,
)
from app.schemas.pose import ShotSequence
from app.schemas.media_source import ClipImportRequest, parse_import_request


router = APIRouter(route_class=StringDetailRoute)

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".webm"}
ID_RE = re.compile(r"^[a-f0-9]{12,32}$")
REPORT_FILE_RE = re.compile(r"^kf_(?:[a-f0-9]{32}_)?\d+\.png$")

Cfg = Annotated[Settings, Depends(get_settings)]


def _new_id() -> str:
    return uuid.uuid4().hex


def _check_id(entity_id: str, what: str) -> None:
    if not ID_RE.fullmatch(entity_id):
        raise HTTPException(404, f"no {what} '{entity_id}'")


def _validated_body[Model: BaseModel](model: type[Model], body: Model | dict) -> Model:
    # Also validate direct route calls used by the model-free unit tests.
    try:
        return model.model_validate(body)
    except ValidationError as exc:
        raise HTTPException(422, validation_detail(exc.errors())) from exc


# ---------------------------------------------------------------------------
# players & templates
# ---------------------------------------------------------------------------

@router.post("/compare/players", response_model=Player, status_code=201)
def create_player(body: PlayerCreate, cfg: Cfg) -> Player:
    body = _validated_body(PlayerCreate, body)
    store.ensure_dirs(cfg)
    player = Player(player_id=_new_id(), name=body.name, created_at=datetime.now(timezone.utc))
    with store.lock(cfg, player.player_id):
        store.save_player(cfg, player)
    return player


@router.get("/compare/players")
def list_players(cfg: Cfg) -> list[Player]:
    return store.list_players(cfg)


@router.get("/compare/players/{player_id}")
def player_detail(player_id: str, cfg: Cfg) -> dict:
    _check_id(player_id, "player")
    try:
        player = store.load_player(cfg, player_id)
    except FileNotFoundError:
        raise HTTPException(404, f"no player '{player_id}'")
    templates = store.list_templates(cfg, player_id)
    clips = store.list_clip_metas(cfg, player_id)
    comparisons = store.list_comparisons(cfg, player_id)
    return {
        "player": player,
        "templates": templates,
        "clips": clips,
        "comparisons": [
            {"comparison_id": c.comparison_id, "template_id": c.template_id,
             "baseline_clip_id": c.baseline_clip_id, "comparison_clip_id": c.comparison_clip_id,
             "camera_status": c.camera_check.status, "created_at": c.created_at}
            for c in comparisons
        ],
    }


@router.delete("/compare/players/{player_id}", status_code=204)
def delete_player(player_id: str, cfg: Cfg) -> None:
    _check_id(player_id, "player")
    try:
        player = store.load_player(cfg, player_id)
    except FileNotFoundError:
        raise HTTPException(404, f"no player '{player_id}'")
    del player
    with store.lock(cfg, player_id):
        for template in store.list_templates(cfg, player_id):
            store.delete_template_file(cfg, template.template_id)
        for comparison in store.list_comparisons(cfg, player_id):
            store.delete_comparison_file(cfg, comparison.comparison_id)
            _remove_report_dir(cfg, comparison.comparison_id)
        for clip in store.list_clip_metas(cfg, player_id):
            # Serialize with create_comparison's clip locks so a clip can
            # never be deleted while a comparison is being built from it.
            with store.lock(cfg, clip.clip_id):
                store.delete_clip_files(cfg, clip)
        store.delete_player_file(cfg, player_id)


def _remove_report_dir(cfg: Settings, comparison_id: str) -> None:
    import shutil

    shutil.rmtree(cfg.compare_reports_dir / comparison_id, ignore_errors=True)


@router.post("/compare/players/{player_id}/templates", response_model=ActionTemplate, status_code=201)
def create_template(player_id: str, body: ActionTemplateCreate, cfg: Cfg) -> ActionTemplate:
    _check_id(player_id, "player")
    body = _validated_body(ActionTemplateCreate, body)
    try:
        store.load_player(cfg, player_id)
    except FileNotFoundError:
        raise HTTPException(404, f"no player '{player_id}'")
    store.ensure_dirs(cfg)
    template = ActionTemplate(
        template_id=_new_id(), player_id=player_id, name=body.name,
        default_phases=body.default_phases, created_at=datetime.now(timezone.utc),
    )
    with store.lock(cfg, template.template_id):
        store.save_template(cfg, template)
    return template


# ---------------------------------------------------------------------------
# clips
# ---------------------------------------------------------------------------

def _clip_video_path(cfg: Settings, clip_id: str) -> Path | None:
    matches = sorted(cfg.compare_videos_dir.glob(f"{clip_id}.*"))
    return matches[0] if matches else None


@router.post("/compare/players/{player_id}/clips", response_model=ClipMeta, status_code=201)
def upload_clip(
    player_id: str,
    cfg: Cfg,
    video: UploadFile,
    template_id: Annotated[str, Form()],
    kind: Annotated[str, Form()] = "comparison",
    source: Annotated[str | None, Form()] = None,
) -> ClipMeta:
    try:
        try:
            import_request = parse_import_request(source)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return _upload_clip(player_id, cfg, video, template_id, kind, import_request)
    finally:
        video.file.close()


def _upload_clip(
    player_id: str,
    cfg: Settings,
    video: UploadFile,
    template_id: str,
    kind: str,
    source: ClipImportRequest | None,
) -> ClipMeta:
    _check_id(player_id, "player")
    _check_id(template_id, "template")
    if kind not in ("baseline", "comparison"):
        raise HTTPException(422, "kind must be 'baseline' or 'comparison'")
    try:
        store.load_player(cfg, player_id)
        template = store.load_template(cfg, template_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    if template.player_id != player_id:
        raise HTTPException(422, "action template must belong to the selected player")

    ext = Path(video.filename or "clip.mp4").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(422, f"unsupported video type '{ext}' — use mp4/mov/webm")

    store.ensure_dirs(cfg)
    clip_id = _new_id()
    video_path = None
    with store.lock(cfg, clip_id):
        try:
            video_path, media_source = prepare_upload(
                video, cfg.compare_videos_dir, clip_id, source,
                concurrency=cfg.analysis_concurrency,
            )
            validate_video(video_path)
            with inference_slot(cfg.analysis_concurrency):
                backend = get_backend(cfg)
                if media_source and media_source.subject_roi is not None:
                    if backend.name != "yolo":
                        raise ValueError("subject ROI requires the YOLO pose backend")
                    sequence = backend.estimate_video(video_path, subject_roi=media_source.subject_roi)
                else:
                    sequence = backend.estimate_video(video_path)
            if not sequence.frames or sequence.frames[0].t_ms < 0:
                raise ValueError("clip must contain pose frames with nonnegative timestamps")
            meta = ClipMeta(
                clip_id=clip_id,
                player_id=player_id,
                template_id=template_id,
                kind=kind,
                filename=video.filename or f"{clip_id}{ext}",
                fps=sequence.fps,
                width=sequence.width,
                height=sequence.height,
                frame_count=len(sequence.frames),
                duration_ms=sequence.frames[-1].t_ms,
                source=media_source,
                created_at=datetime.now(timezone.utc),
            )
            # The player/template may have been deleted mid-upload; re-check
            # inside the clip lock so no orphaned clip metadata can commit.
            try:
                store.load_player(cfg, player_id)
                store.load_template(cfg, template_id)
            except FileNotFoundError as exc:
                raise HTTPException(404, str(exc)) from exc
            store.save_clip_meta(cfg, meta)
            store.save_clip_pose(cfg, clip_id, sequence)
            return meta
        except BaseException as exc:
            if video_path is not None:
                video_path.unlink(missing_ok=True)
            store.clip_meta_path(cfg, clip_id).unlink(missing_ok=True)
            store.clip_pose_path(cfg, clip_id).unlink(missing_ok=True)
            if isinstance(exc, AnalysisBusy):
                raise HTTPException(429, str(exc), headers={"Retry-After": "5"}) from exc
            if isinstance(exc, (ValueError, RuntimeError)):
                raise HTTPException(422, str(exc)) from exc
            raise


@router.get("/compare/clips/{clip_id}")
def clip_detail(clip_id: str, cfg: Cfg) -> ClipMeta:
    _check_id(clip_id, "clip")
    try:
        return store.load_clip_meta(cfg, clip_id)
    except FileNotFoundError:
        raise HTTPException(404, f"no clip '{clip_id}'")


@router.get("/compare/clips/{clip_id}/pose", response_model=ShotSequence)
def clip_pose(clip_id: str, cfg: Cfg) -> ShotSequence:
    _check_id(clip_id, "clip")
    try:
        return store.load_clip_pose(cfg, clip_id)
    except FileNotFoundError:
        raise HTTPException(404, f"no clip '{clip_id}'")


@router.get("/compare/clips/{clip_id}/video")
def clip_video(clip_id: str, cfg: Cfg) -> FileResponse:
    _check_id(clip_id, "clip")
    try:
        store.load_clip_meta(cfg, clip_id)
    except FileNotFoundError:
        raise HTTPException(404, f"no clip '{clip_id}'")
    with store.lock(cfg, clip_id):
        path = _clip_video_path(cfg, clip_id)
        if path is None or not path.is_file():
            raise HTTPException(410, "clip video is no longer available")
    return FileResponse(path, filename=path.name)


@router.delete("/compare/clips/{clip_id}", status_code=204)
def delete_clip(clip_id: str, cfg: Cfg) -> None:
    _check_id(clip_id, "clip")
    try:
        meta = store.load_clip_meta(cfg, clip_id)
    except FileNotFoundError:
        raise HTTPException(404, f"no clip '{clip_id}'")
    referencing = [
        c
        for c in store.list_comparisons(cfg, meta.player_id)
        if clip_id in (c.baseline_clip_id, c.comparison_clip_id)
    ]
    if referencing:
        raise HTTPException(
            409,
            f"clip is used by {len(referencing)} comparison(s) — delete those first",
        )
    with store.lock(cfg, clip_id):
        store.delete_clip_files(cfg, meta)


# ---------------------------------------------------------------------------
# comparisons
# ---------------------------------------------------------------------------

def _decode_samples(video_path: Path, indices: list[int]) -> dict[int, "object"]:
    """Decode the given frame indices (sequential pass), keyed by index."""
    import cv2

    wanted = set(indices)
    frames: dict[int, object] = {}
    cap = cv2.VideoCapture(str(video_path))
    try:
        idx = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx in wanted:
                frames[idx] = frame
            if idx > max(wanted):
                break
            idx += 1
    finally:
        cap.release()
    return frames


def _default_phases(names: list[str], frame_count: int) -> list[PhaseBoundary]:
    count = len(names)
    last = max(frame_count - 1, 0)
    phases = []
    for i, name in enumerate(names):
        start = min(round(i * frame_count / count), last)
        end = min(round((i + 1) * frame_count / count) - 1, last)
        if end < start:
            end = start
        phases.append(PhaseBoundary(phase=name, start_frame=start, end_frame=end))
    return phases


@router.post("/compare/comparisons", response_model=ComparisonState, status_code=201)
def create_comparison(body: ComparisonCreate, cfg: Cfg) -> ComparisonState:
    body = _validated_body(ComparisonCreate, body)
    player_id = body.player_id
    template_id = body.template_id
    baseline_id = body.baseline_clip_id
    comparison_id_clip = body.comparison_clip_id
    try:
        store.load_player(cfg, player_id)
        clip_a = store.load_clip_meta(cfg, baseline_id)
        clip_b = store.load_clip_meta(cfg, comparison_id_clip)
        template = store.load_template(cfg, template_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    if clip_a.player_id != player_id or clip_b.player_id != player_id:
        raise HTTPException(422, "both clips must belong to the selected player")
    if template.player_id != player_id:
        raise HTTPException(422, "action template must belong to the selected player")
    if clip_a.template_id != template_id or clip_b.template_id != template_id:
        raise HTTPException(422, "both clips must use the selected action template")

    video_a = _clip_video_path(cfg, clip_a.clip_id)
    video_b = _clip_video_path(cfg, clip_b.clip_id)
    if video_a is None or video_b is None:
        raise HTTPException(410, "clip videos are no longer available")

    try:
        seq_a = store.load_clip_pose(cfg, clip_a.clip_id)
        seq_b = store.load_clip_pose(cfg, clip_b.clip_id)
    except FileNotFoundError:
        raise HTTPException(410, "clip pose data is no longer available") from None
    for clip, seq in ((clip_a, seq_a), (clip_b, seq_b)):
        if not seq.frames or len(seq.frames) != clip.frame_count:
            raise HTTPException(422, "clip pose data does not match the clip length")

    idx_a = sample_frame_indices(clip_a.frame_count)
    idx_b = sample_frame_indices(clip_b.frame_count)
    # Hold both clip locks (sorted to avoid ABBA) while computing and saving
    # the comparison: delete_clip must not complete mid-creation and leave a
    # comparison referencing a deleted clip.
    with store.lock(cfg, min(baseline_id, comparison_id_clip)):
        with store.lock(cfg, max(baseline_id, comparison_id_clip)):
            frames_a = _decode_samples(video_a, idx_a)
            frames_b = _decode_samples(video_b, idx_b)
            pairs = []
            for ia, ib in zip(idx_a, idx_b):
                if ia not in frames_a or ib not in frames_b:
                    continue
                mask_a = person_mask(frames_a[ia].shape[:2], seq_a.frames[ia].keypoints)
                mask_b = person_mask(frames_b[ib].shape[:2], seq_b.frames[ib].keypoints)
                pairs.append(_match_pair(frames_a[ia], frames_b[ib], mask_a, mask_b))
            camera = check_camera(pairs, cfg)
            spatial = fit_affine(pairs, clip_a.width, clip_a.height) or AffineTransform()
            offset_a, offset_b, confidence = suggest_offset_ms(seq_a, seq_b)

            state = ComparisonState(
                comparison_id=_new_id(),
                player_id=player_id,
                template_id=template_id,
                baseline_clip_id=clip_a.clip_id,
                comparison_clip_id=clip_b.clip_id,
                spatial=spatial,
                temporal={
                    "offset_ms_a": offset_a,
                    "offset_ms_b": offset_b,
                    "suggested_offset_ms_b": offset_b or None,
                    "suggestion_confidence": confidence,
                },
                phases_a=_default_phases(template.default_phases, clip_a.frame_count),
                phases_b=_default_phases(template.default_phases, clip_b.frame_count),
                markers=[],
                camera_check=camera,
                created_at=datetime.now(timezone.utc),
            )
            with store.lock(cfg, state.comparison_id):
                store.save_comparison(cfg, state)
    return state


@router.get("/compare/comparisons/{comparison_id}", response_model=ComparisonState)
def get_comparison(comparison_id: str, cfg: Cfg) -> ComparisonState:
    _check_id(comparison_id, "comparison")
    try:
        return store.load_comparison(cfg, comparison_id)
    except FileNotFoundError:
        raise HTTPException(404, f"no comparison '{comparison_id}'")


@router.patch("/compare/comparisons/{comparison_id}", response_model=ComparisonState)
def patch_comparison(comparison_id: str, body: ComparisonUpdate, cfg: Cfg) -> ComparisonState:
    _check_id(comparison_id, "comparison")
    body = _validated_body(ComparisonUpdate, body)
    with store.lock(cfg, comparison_id):
        try:
            state = store.load_comparison(cfg, comparison_id)
        except FileNotFoundError:
            raise HTTPException(404, f"no comparison '{comparison_id}'")
        try:
            clip_a = store.load_clip_meta(cfg, state.baseline_clip_id)
            clip_b = store.load_clip_meta(cfg, state.comparison_clip_id)
        except FileNotFoundError:
            raise HTTPException(410, "clip metadata is no longer available") from None
        updates = {}
        if body.spatial is not None:
            updates["spatial"] = body.spatial
        if body.opacity_default is not None:
            updates["opacity_default"] = body.opacity_default
        if body.temporal is not None:
            merged = TemporalAlignment.model_validate(
                {**state.temporal.model_dump(), **body.temporal.model_dump(exclude_unset=True)}
            )
            for key, clip in (("offset_ms_a", clip_a), ("offset_ms_b", clip_b)):
                if getattr(merged, key) > clip.duration_ms:
                    raise HTTPException(422, f"{key} exceeds the clip duration")
            if merged.suggested_offset_ms_b is not None and merged.suggested_offset_ms_b > clip_b.duration_ms:
                raise HTTPException(422, "suggested_offset_ms_b exceeds the clip duration")
            updates["temporal"] = merged
        for key, frame_count in (("phases_a", clip_a.frame_count), ("phases_b", clip_b.frame_count)):
            phases = getattr(body, key)
            if phases is not None:
                _validate_phases(phases, frame_count)
                updates[key] = phases
        if body.markers is not None:
            markers = [EventMarker.model_validate(marker.model_dump()) for marker in body.markers]
            for marker in markers:
                if marker.frame >= clip_a.frame_count:
                    raise HTTPException(422, f"marker frame {marker.frame} exceeds clip length")
                if marker.t_ms > clip_a.duration_ms:
                    raise HTTPException(422, f"marker time {marker.t_ms} exceeds clip duration")
            updates["markers"] = markers
        if any(key in updates and updates[key] != getattr(state, key)
               for key in ("spatial", "temporal", "phases_a", "phases_b")):
            updates["report"] = None
        state = state.model_copy(update=updates)
        store.save_comparison(cfg, state)
        return state


def _validate_phases(phases: list[PhaseBoundary], frame_count: int) -> None:
    if not phases:
        raise HTTPException(422, "at least one phase is required")
    for phase in phases:
        if phase.end_frame >= frame_count:
            raise HTTPException(422, f"phase '{phase.phase}' exceeds the clip length")


@router.get("/compare/comparisons/{comparison_id}/video/{side}")
def comparison_video(comparison_id: str, side: str, cfg: Cfg) -> FileResponse:
    _check_id(comparison_id, "comparison")
    if side not in ("a", "b"):
        raise HTTPException(404, f"unknown side '{side}'")
    try:
        state = store.load_comparison(cfg, comparison_id)
    except FileNotFoundError:
        raise HTTPException(404, f"no comparison '{comparison_id}'")
    clip_id = state.baseline_clip_id if side == "a" else state.comparison_clip_id
    with store.lock(cfg, clip_id):
        path = _clip_video_path(cfg, clip_id)
        if path is None or not path.is_file():
            raise HTTPException(410, "clip video is no longer available")
    return FileResponse(path, filename=path.name)


@router.delete("/compare/comparisons/{comparison_id}", status_code=204)
def delete_comparison(comparison_id: str, cfg: Cfg) -> None:
    _check_id(comparison_id, "comparison")
    try:
        store.load_comparison(cfg, comparison_id)
    except FileNotFoundError:
        raise HTTPException(404, f"no comparison '{comparison_id}'")
    with store.lock(cfg, comparison_id):
        store.delete_comparison_file(cfg, comparison_id)
        _remove_report_dir(cfg, comparison_id)


ANGLE_TRIPLES = {
    "left_elbow_deg": ("left_shoulder", "left_elbow", "left_wrist"),
    "right_elbow_deg": ("right_shoulder", "right_elbow", "right_wrist"),
    "left_knee_deg": ("left_hip", "left_knee", "left_ankle"),
    "right_knee_deg": ("right_hip", "right_knee", "right_ankle"),
}


@router.get("/compare/comparisons/{comparison_id}/metrics")
def comparison_metrics(comparison_id: str, cfg: Cfg) -> dict:
    _check_id(comparison_id, "comparison")
    try:
        state = store.load_comparison(cfg, comparison_id)
    except FileNotFoundError:
        raise HTTPException(404, f"no comparison '{comparison_id}'")
    try:
        seq_a = store.load_clip_pose(cfg, state.baseline_clip_id)
        seq_b = store.load_clip_pose(cfg, state.comparison_clip_id)
    except FileNotFoundError:
        raise HTTPException(410, "clip pose data is no longer available")
    return {"a": _angle_series(seq_a), "b": _angle_series(seq_b)}


def _angle_series(seq: ShotSequence) -> dict:
    from app.analysis.series import angle_abc, series as kp_series

    out: dict[str, list] = {}
    for name, triple in ANGLE_TRIPLES.items():
        try:
            points = [kp_series(seq, joint) for joint in triple]
        except Exception:
            continue
        values = []
        for i in range(len(seq.frames)):
            joint_confs = [
                next((kp.confidence for kp in seq.frames[i].keypoints if kp.name == joint), 0.0)
                for joint in triple
            ]
            conf = min(joint_confs)
            value = None
            if conf >= 0.5:
                try:
                    value = round(float(angle_abc(points[0][i], points[1][i], points[2][i])), 1)
                except Exception:
                    value = None
            values.append({"t_ms": seq.frames[i].t_ms, "value": value, "confidence": round(conf, 3)})
        out[name] = values
    return out


@router.post("/compare/comparisons/{comparison_id}/report", response_model=ComparisonState)
def generate_report(comparison_id: str, cfg: Cfg) -> ComparisonState:
    _check_id(comparison_id, "comparison")
    with store.lock(cfg, comparison_id):
        try:
            state = store.load_comparison(cfg, comparison_id)
        except FileNotFoundError:
            raise HTTPException(404, f"no comparison '{comparison_id}'")
        try:
            updated = state.model_copy(update={"report": build_report(cfg, state)})
            store.save_comparison(cfg, updated)
        except BaseException:
            cleanup_report_files(cfg, state)
            raise
        cleanup_report_files(cfg, updated)
        return updated


@router.get("/compare/reports/{comparison_id}/{filename}")
def report_file(comparison_id: str, filename: str, cfg: Cfg) -> FileResponse:
    _check_id(comparison_id, "comparison")
    try:
        state = store.load_comparison(cfg, comparison_id)
    except FileNotFoundError:
        raise HTTPException(404, "no such comparison")
    if not REPORT_FILE_RE.fullmatch(filename):
        raise HTTPException(404, "no such report file")
    if state.report is None:
        raise HTTPException(410, "report is out of date; generate it again")
    expected_url = f"/api/v1/compare/reports/{comparison_id}/{filename}"
    if not any(frame.url == expected_url for frame in state.report.keyframes):
        raise HTTPException(404, "no such report file")
    path = cfg.compare_reports_dir / comparison_id / filename
    if not path.is_file():
        raise HTTPException(404, "no such report file")
    return FileResponse(path, filename=path.name, headers={"Cache-Control": "no-store"})
