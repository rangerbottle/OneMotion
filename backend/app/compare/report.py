"""Comparison report generation: keyframe screenshots + phase offset table.

Keyframes are the moments of maximum pose deviation between the two clips
(normalized keypoint distance at the temporally aligned frame), drawn with
both skeletons on clip A's frame (B transformed by the affine alignment).
"""

from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from app.compare.store import load_clip_meta, load_clip_pose
from app.core.config import Settings
from app.schemas.compare import (
    AffineTransform,
    ComparisonState,
    KeyframeRef,
    PhaseOffset,
    ReportRef,
)
from app.schemas.pose import ShotSequence

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
    """(aligned_ms, mean normalized keypoint distance) per aligned sample."""
    conf_min = 0.5
    offset_a = state.temporal.offset_ms_a
    offset_b = state.temporal.offset_ms_b
    end = min(
        seq_a.frames[-1].t_ms - offset_a,
        seq_b.frames[-1].t_ms - offset_b,
    )
    results = []
    for frame_a in seq_a.frames:
        t_a = frame_a.t_ms
        aligned = t_a - offset_a
        if aligned < 0 or aligned > end:
            continue
        frame_b = _frame_at(seq_b, aligned + offset_b)
        if frame_b is None:
            continue
        dist = _kp_distance(frame_a, frame_b, conf_min)
        if dist is not None:
            results.append((aligned, dist))
    return results


def _frame_at(seq: ShotSequence, t_ms: float):
    frames = seq.frames
    lo, hi = 0, len(frames) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if frames[mid].t_ms < t_ms:
            lo = mid + 1
        else:
            hi = mid
    return frames[lo]


def _kp_distance(frame_a, frame_b, conf_min: float) -> float | None:
    b_map = {kp.name: kp for kp in frame_b.keypoints}
    total, count = 0.0, 0
    for kp_a in frame_a.keypoints:
        kp_b = b_map.get(kp_a.name)
        if kp_b is None or kp_a.confidence < conf_min or kp_b.confidence < conf_min:
            continue
        total += float(np.hypot(kp_a.x - kp_b.x, (kp_a.y - kp_b.y) * 1.0))
        count += 1
    return total / count if count >= 8 else None


def pick_keyframes(deviation: list[tuple[int, float]]) -> list[tuple[int, float]]:
    picked: list[tuple[int, float]] = []
    for t_ms, value in sorted(deviation, key=lambda item: -item[1]):
        if all(abs(t_ms - t) >= KEYFRAME_MIN_GAP_MS for t, _ in picked):
            picked.append((t_ms, value))
        if len(picked) >= KEYFRAME_COUNT:
            break
    return sorted(picked)


def _decode_frame(video_path: Path, t_ms: float) -> np.ndarray | None:
    import cv2

    cap = cv2.VideoCapture(str(video_path))
    try:
        if not cap.isOpened():
            return None
        cap.set(cv2.CAP_PROP_POS_MSEC, t_ms)
        ok, frame = cap.read()
        return frame if ok else None
    finally:
        cap.release()


def _draw_skeleton(canvas, keypoints, color, affine: AffineTransform | None, width: int):
    import cv2

    def px(kp):
        x, y = kp.x * width, kp.y * canvas.shape[0]
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


def _phase_offsets(state: ComparisonState, fps_a: float, fps_b: float) -> list[PhaseOffset]:
    offsets = []
    starts_b = {p.phase: p.start_frame for p in state.phases_b}
    for phase in state.phases_a:
        if phase.phase not in starts_b:
            continue
        delta_frames = starts_b[phase.phase] - phase.start_frame
        delta_ms = round(starts_b[phase.phase] / fps_b * 1000) - round(phase.start_frame / fps_a * 1000)
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
    refs: list[KeyframeRef] = []
    if video_a is not None and video_b is not None:
        for i, (aligned, value) in enumerate(keyframes):
            t_a = aligned + state.temporal.offset_ms_a
            t_b = aligned + state.temporal.offset_ms_b
            frame = _decode_frame(video_a, t_a)
            if frame is None:
                continue
            _draw_skeleton(frame, _frame_at(seq_a, t_a).keypoints, COLOR_A, None, frame.shape[1])
            frame_b = _decode_frame(video_b, t_b)
            if frame_b is None:
                continue
            _draw_skeleton(frame, _frame_at(seq_b, t_b).keypoints, COLOR_B, state.spatial, frame.shape[1])
            import cv2

            name = f"kf_{i}.png"
            cv2.imwrite(str(out_dir / name), frame)
            refs.append(
                KeyframeRef(
                    url=f"/api/v1/compare/reports/{state.comparison_id}/{name}",
                    t_ms_a=int(t_a),
                    t_ms_b=int(t_b),
                    deviation=round(value, 4),
                )
            )

    phase_offsets = _phase_offsets(state, clip_a.fps, clip_b.fps)
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
    return ReportRef(created_at=datetime.now(timezone.utc), keyframes=refs, phase_offsets=phase_offsets, summary_text=summary)
