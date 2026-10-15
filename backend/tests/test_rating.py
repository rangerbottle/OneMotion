"""Release-timing rating ("shot meter") tests — synthetic jump sequences."""

import numpy as np

from app.analysis.rating import rate_release_timing
from app.schemas.analysis import PhaseSegment
from app.schemas.pose import COCO17_KEYPOINTS, Keypoint, PoseFrame, ShotSequence

FPS = 30
APEX = 10  # frame of jump apex
N = 24


def jump_sequence(jump_ratio: float = 0.15, ankle_conf: float = 0.9) -> ShotSequence:
    """Ankles rise from 0.9 to apex at frame APEX, then descend. Eyes fixed."""
    frames = []
    for i in range(N):
        shape = 1.0 - abs(i - APEX) / APEX  # triangle: 0 at 0, 1 at apex, back down
        ankle_y = 0.9 - 0.7 * jump_ratio * max(shape, 0.0)
        keypoints = []
        for name in COCO17_KEYPOINTS:
            if name.endswith("ankle"):
                keypoints.append(Keypoint(name=name, x=0.5, y=ankle_y, confidence=ankle_conf))
            elif name.endswith("eye"):
                keypoints.append(Keypoint(name=name, x=0.5, y=0.2, confidence=0.9))
            else:
                keypoints.append(Keypoint(name=name, x=0.5, y=0.5, confidence=0.9))
        frames.append(PoseFrame(frame_idx=i, t_ms=i * (1000 // FPS), keypoints=keypoints))
    return ShotSequence(clip_id="jump", fps=FPS, width=100, height=100, frames=frames)


def phases_for(release_offset: int, degraded: bool = False) -> list[PhaseSegment]:
    release = APEX + release_offset
    return [
        PhaseSegment(phase="dip", start_frame=0, end_frame=0, anchor_frame=0),
        PhaseSegment(phase="load", start_frame=0, end_frame=0, anchor_frame=0),
        PhaseSegment(phase="lift", start_frame=1, end_frame=release, anchor_frame=1),
        PhaseSegment(phase="release", start_frame=release, end_frame=release, anchor_frame=release, degraded=degraded),
        PhaseSegment(phase="follow_through", start_frame=release, end_frame=N - 1, anchor_frame=N - 1),
    ]


def test_perfect_release_at_apex():
    rating = rate_release_timing(jump_sequence(), phases_for(0))
    assert rating.verdict == "perfect" and rating.reliable
    assert rating.timing_delta_ms == 0


def test_early_and_late_release():
    frame_ms = 1000 // FPS  # 33 ms per frame
    early = rate_release_timing(jump_sequence(), phases_for(-3))
    assert early.verdict == "early" and early.timing_delta_ms == -3 * frame_ms
    late = rate_release_timing(jump_sequence(), phases_for(4))
    assert late.verdict == "late" and late.timing_delta_ms == 4 * frame_ms


def test_degraded_release_anchor_blocks_verdict():
    rating = rate_release_timing(jump_sequence(), phases_for(0, degraded=True))
    assert rating.verdict is None and not rating.reliable
    assert "release" in (rating.reason or "")


def test_untracked_ankles_block_verdict():
    rating = rate_release_timing(jump_sequence(ankle_conf=0.2), phases_for(0))
    assert rating.verdict is None and not rating.reliable
    assert "ankle" in (rating.reason or "")


def test_standstill_shot_has_no_timing_verdict():
    rating = rate_release_timing(jump_sequence(jump_ratio=0.005), phases_for(0))
    assert rating.verdict is None and not rating.reliable
    assert "jump" in (rating.reason or "")


def test_band_boundary_is_perfect():
    # ±60 ms band: 2 frames at 30 fps (66 ms) is outside, 1 frame is inside.
    inside = rate_release_timing(jump_sequence(), phases_for(1))
    assert inside.verdict == "perfect"
    outside = rate_release_timing(jump_sequence(), phases_for(2), perfect_band_ms=60)
    assert outside.verdict == "late"
