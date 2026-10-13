"""Comparison report generation: keyframe screenshots + phase offset table.

Keyframes are the moments of maximum pose deviation between the two clips
(normalized keypoint distance at the temporally aligned frame), drawn with
both skeletons on clip A's frame (B transformed by the affine alignment).
"""

import logging
import uuid
from bisect import bisect_right
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from app.compare.store import load_clip_meta, load_clip_pose
from app.core.config import Settings
from app.core.storage import atomic_write
from app.schemas.compare import (
    AffineTransform,
    ComparisonState,
    KeyframeRef,
    PhaseOffset,
    ReportRef,
)
from app.schemas.pose import COCO17_KEYPOINTS, PoseFrame, ShotSequence

logger = logging.getLogger(__name__)

KEYFRAME_COUNT = 5
KEYFRAME_MIN_GAP_MS = 200
# (from, to) joint-name pairs, COCO-17 names.
SKELETON_EDGES: list[tuple[str, str]] = [
    ("nose", "left_shoulder"), ("nose", "right_shoulder"),
    ("left_shoulder", "left_elbow"), ("left_elbow", "left_wrist"),
    ("right_shoulder", "right_elbow"), ("right_elbow", "right_wrist"),
    ("left_shoulder", "left_hip"), ("right_shoulder", "right_hip"),
    ("left_hip", "left_knee"), ("left_knee", "left_ankle"),
    ("right_hip", "right_knee"), ("right_knee", "right_ankle"),
    ("left_shoulder", "right_shoulder"), ("left_hip", "right_hip"),
]
COLOR_A = (230, 140, 40)   # BGR — clip A skeleton
COLOR_B = (60, 130, 245)   # BGR — clip B skeleton (drawn through the affine)


def aligned_deviation(seq_a: ShotSequence, seq_b: ShotSequence, state: ComparisonState) -> list[tuple[int, float]]:
    """(aligned_ms, mean normalized keypoint distance) per aligned sample.

    B's keypoints are mapped through the spatial affine before the distance
    is measured, so the deviation reflects action difference rather than
    camera misalignment (the same convention the overlay view uses).
    """
    if not seq_a.frames or not seq_b.frames:
        return []
    times_a = np.array([frame.t_ms for frame in seq_a.frames])
    times_b = np.array([frame.t_ms for frame in seq_b.frames])
    aligned = times_a - state.temporal.offset_ms_a
    end = min(aligned[-1], times_b[-1] - state.temporal.offset_ms_b)
    valid_times = (aligned >= 0) & (aligned <= end)
    # Source-time floor, matching the workbench. Never borrow a future pose.
    b_indices = np.clip(np.searchsorted(times_b, aligned + state.temporal.offset_ms_b,
                                       side="right") - 1, 0, len(times_b) - 1)
    points_a, confidence_a = _pose_arrays(seq_a)
    points_b, confidence_b = _pose_arrays(seq_b)
    points_a *= (seq_a.width, seq_a.height)
    points_b *= (seq_b.width, seq_b.height)
    matrix = _affine_matrix(state.spatial)
    mapped_b = points_b @ matrix.T + (state.spatial.tx, state.spatial.ty)
    difference = (points_a - mapped_b[b_indices]) / (seq_a.width, seq_a.height)
    distances = np.linalg.norm(difference, axis=2)
    evidence = (confidence_a >= 0.5) & (confidence_b[b_indices] >= 0.5)
    counts = evidence.sum(axis=1)
    keep = valid_times & (counts >= 8)
    deviations = np.sum(np.where(evidence, distances, 0.0), axis=1) / np.maximum(counts, 1)
    return [(int(t), float(value)) for t, value in zip(aligned[keep], deviations[keep])]


def _pose_arrays(seq: ShotSequence) -> tuple[np.ndarray, np.ndarray]:
    """Index canonical joint names once; absent joints retain zero confidence."""
    names = {name: i for i, name in enumerate(COCO17_KEYPOINTS)}
    points = np.zeros((len(seq.frames), len(names), 2), dtype=float)
    confidence = np.zeros((len(seq.frames), len(names)), dtype=float)
    for frame_index, frame in enumerate(seq.frames):
        for point in frame.keypoints:
            joint = names.get(point.name)
            if joint is not None:
                points[frame_index, joint] = (point.x, point.y)
                confidence[frame_index, joint] = point.confidence
    return points, confidence


def _affine_matrix(spatial: AffineTransform) -> np.ndarray:
    rad = np.radians(spatial.rotation_deg)
    return spatial.scale * np.array([[np.cos(rad), -np.sin(rad)],
                                     [np.sin(rad), np.cos(rad)]])


def _frame_at(seq: ShotSequence, t_ms: float) -> PoseFrame | None:
    if not seq.frames:
        return None
    index = bisect_right(seq.frames, t_ms, key=lambda frame: frame.t_ms) - 1
    return seq.frames[max(index, 0)]


def pick_keyframes(deviation: list[tuple[int, float]]) -> list[tuple[int, float]]:
    picked: list[tuple[int, float]] = []
    for t_ms, value in sorted(deviation, key=lambda item: -item[1]):
        if all(abs(t_ms - t) >= KEYFRAME_MIN_GAP_MS for t, _ in picked):
            picked.append((t_ms, value))
        if len(picked) >= KEYFRAME_COUNT:
            break
    return sorted(picked)


@contextmanager
def _video_reader(video_path: Path):
    """Open each source once per report, even when several keyframes are picked."""
    import cv2

    capture = cv2.VideoCapture(str(video_path))
    try:
        yield capture
    finally:
        capture.release()


def _decode_frame(capture, frame_idx: int) -> np.ndarray | None:
    import cv2

    if not capture.isOpened():
        return None
    # Pose records map one-to-one to decoded frames. Millisecond seeking may
    # round into a future video frame, especially with unequal frame rates.
    capture.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
    ok, frame = capture.read()
    return frame if ok else None


def _draw_skeleton(canvas, keypoints, color, affine: AffineTransform | None, width: int, height: int):
    import cv2

    def px(kp):
        x, y = kp.x * width, kp.y * height
        if affine is not None:
            rad = np.radians(affine.rotation_deg)
            x, y = (
                affine.scale * (np.cos(rad) * x - np.sin(rad) * y) + affine.tx,
                affine.scale * (np.sin(rad) * x + np.cos(rad) * y) + affine.ty,
            )
        return int(round(x)), int(round(y))

    point_map = {kp.name: kp for kp in keypoints}
    for a, b in SKELETON_EDGES:
        ka, kb = point_map.get(a), point_map.get(b)
        if ka is None or kb is None:
            continue
        if ka.confidence < 0.5 or kb.confidence < 0.5:
            continue
        cv2.line(canvas, px(ka), px(kb), color, 2, cv2.LINE_AA)
    for kp in keypoints:
        if kp.confidence >= 0.5:
            cv2.circle(canvas, px(kp), 3, color, -1, cv2.LINE_AA)


def _phase_offsets(state: ComparisonState, seq_a: ShotSequence, seq_b: ShotSequence) -> list[PhaseOffset]:
    offsets = []
    starts_b = {p.phase: p.start_frame for p in state.phases_b}
    times_a = {frame.frame_idx: frame.t_ms for frame in seq_a.frames}
    times_b = {frame.frame_idx: frame.t_ms for frame in seq_b.frames}
    for phase in state.phases_a:
        if phase.phase not in starts_b:
            continue
        start_b = starts_b[phase.phase]
        if phase.start_frame not in times_a or start_b not in times_b:
            continue
        delta_frames = start_b - phase.start_frame
        # Average fps cannot recover presentation times in a variable-rate clip.
        delta_ms = times_b[start_b] - times_a[phase.start_frame]
        offsets.append(PhaseOffset(phase=phase.phase, delta_frames=delta_frames, delta_ms=int(delta_ms)))
    return offsets


def build_report(cfg: Settings, state: ComparisonState) -> ReportRef:
    clip_a = load_clip_meta(cfg, state.baseline_clip_id)
    clip_b = load_clip_meta(cfg, state.comparison_clip_id)
    seq_a = load_clip_pose(cfg, state.baseline_clip_id)
    seq_b = load_clip_pose(cfg, state.comparison_clip_id)
    deviation = aligned_deviation(seq_a, seq_b, state)
    keyframes = pick_keyframes(deviation)
    video_a = next(iter(sorted(cfg.compare_videos_dir.glob(f"{clip_a.clip_id}.*"))), None)
    video_b = next(iter(sorted(cfg.compare_videos_dir.glob(f"{clip_b.clip_id}.*"))), None)

    out_dir = cfg.compare_reports_dir / state.comparison_id
    out_dir.mkdir(parents=True, exist_ok=True)
    # Unique filenames preserve the previous release until metadata commits.
    generation = uuid.uuid4().hex
    refs: list[KeyframeRef] = []
    attempted: list[Path] = []
    try:
        if keyframes:
            if video_a is None or video_b is None:
                raise RuntimeError("comparison source videos are unavailable")
            with ExitStack() as resources:
                reader_a = resources.enter_context(_video_reader(video_a))
                reader_b = resources.enter_context(_video_reader(video_b))
                for i, (aligned, value) in enumerate(keyframes):
                    t_a = aligned + state.temporal.offset_ms_a
                    t_b = aligned + state.temporal.offset_ms_b
                    pose_a = _frame_at(seq_a, t_a)
                    pose_b = _frame_at(seq_b, t_b)
                    frame = _decode_frame(reader_a, pose_a.frame_idx)
                    frame_b = _decode_frame(reader_b, pose_b.frame_idx)
                    if frame is None or frame_b is None:
                        raise RuntimeError("could not decode comparison keyframe")
                    _draw_skeleton(frame, pose_a.keypoints, COLOR_A,
                                   None, seq_a.width, seq_a.height)
                    _draw_skeleton(frame, pose_b.keypoints, COLOR_B,
                                   state.spatial, seq_b.width, seq_b.height)
                    import cv2

                    ok, encoded = cv2.imencode(".png", frame)
                    if not ok:
                        raise RuntimeError("could not encode comparison keyframe")
                    name = f"kf_{generation}_{i}.png"
                    path = out_dir / name
                    attempted.append(path)
                    atomic_write(path, encoded.tobytes())
                    refs.append(KeyframeRef(
                        url=f"/api/v1/compare/reports/{state.comparison_id}/{name}",
                        t_ms_a=int(t_a), t_ms_b=int(t_b), deviation=round(value, 4),
                    ))
    except BaseException:
        for path in attempted:
            path.unlink(missing_ok=True)
        raise

    timing_reliable = all(clip.source is None or clip.source.timing_mode == "realtime"
                          for clip in (clip_a, clip_b))
    phase_offsets = _phase_offsets(state, seq_a, seq_b) if timing_reliable else []
    offset_lines = [
        f"{item.phase}: B starts {item.delta_frames:+d} frames ({item.delta_ms:+d} ms) vs A"
        for item in phase_offsets
    ]
    summary = (
        f"Camera check: {state.camera_check.status} "
        f"(inlier ratio {state.camera_check.inlier_ratio}). "
        f"Temporal offset: B action start at {state.temporal.offset_ms_b} ms. "
        + ("Phase offsets — " + "; ".join(offset_lines) if offset_lines else "No phase offsets recorded.")
    )
    if not timing_reliable:
        summary += " Source playback speed is unknown or slowed; phase timing comparison is disabled. Offsets refer to video playback only."
    return ReportRef(created_at=datetime.now(timezone.utc), keyframes=refs, phase_offsets=phase_offsets, summary_text=summary)


def cleanup_report_files(cfg: Settings, state: ComparisonState) -> None:
    """Called under the comparison lock after commit, or to roll back a failed commit."""
    keep = {Path(frame.url).name for frame in state.report.keyframes} if state.report else set()
    for path in (cfg.compare_reports_dir / state.comparison_id).glob("kf_*.png"):
        if path.name not in keep:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                # A cleanup failure must not turn a committed report into an API failure.
                # Unreferenced files remain inaccessible and can be removed on the next export.
                logger.warning("could not remove old comparison keyframe %s", path, exc_info=True)
