"""Release-timing rating ("shot meter") tests — synthetic jump sequences."""

from app.analysis.rating import rate_release_timing
from app.schemas.analysis import PhaseSegment
from app.schemas.pose import COCO17_KEYPOINTS, Keypoint, PoseFrame, ShotSequence

FPS = 30
APEX = 10  # frame of jump apex
N = 24


def jump_sequence(jump_ratio: float = 0.15, hip_conf: float = 0.9) -> ShotSequence:
    """Hips rise from 0.55 to apex at frame APEX, then descend. Eyes fixed."""
    frames = []
    for i in range(N):
        shape = 1.0 - abs(i - APEX) / APEX  # triangle: 0 at 0, 1 at apex, back down
        hip_y = 0.55 - 0.35 * jump_ratio * max(shape, 0.0)
        keypoints = []
        for name in COCO17_KEYPOINTS:
            if name.endswith("hip"):
                keypoints.append(Keypoint(name=name, x=0.5, y=hip_y, confidence=hip_conf))
            elif name.endswith("eye"):
                keypoints.append(Keypoint(name=name, x=0.5, y=0.2, confidence=0.9))
            elif name.endswith("ankle"):
                keypoints.append(Keypoint(name=name, x=0.5, y=0.9, confidence=0.9))
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


def test_untracked_hips_block_verdict():
    rating = rate_release_timing(jump_sequence(hip_conf=0.2), phases_for(0))
    assert rating.verdict is None and not rating.reliable
    assert "hip" in (rating.reason or "")


def test_standstill_shot_has_no_timing_verdict():
    rating = rate_release_timing(jump_sequence(jump_ratio=0.005), phases_for(0))
    assert rating.verdict is None and not rating.reliable
    assert "jump" in (rating.reason or "")


def test_setup_noise_before_load_cannot_win_the_apex():
    # Pose noise lifts the apparent hip height before the load phase, but the
    # apex search only covers the lift window, so the verdict follows the
    # real jump apex — and the baseline window does not see the noise either.
    import copy

    seq = copy.deepcopy(jump_sequence())
    for i in range(0, 3):
        for kp in seq.frames[i].keypoints:
            if kp.name.endswith("hip"):
                kp.y = 0.3  # absurdly high
                kp.confidence = 0.2  # below CONF_MIN — excluded from smoothing and apex
    release = APEX
    phases = [
        PhaseSegment(phase="dip", start_frame=3, end_frame=3, anchor_frame=3),
        PhaseSegment(phase="load", start_frame=3, end_frame=3, anchor_frame=3),
        PhaseSegment(phase="lift", start_frame=4, end_frame=release, anchor_frame=4),
        PhaseSegment(phase="release", start_frame=release, end_frame=release, anchor_frame=release),
        PhaseSegment(phase="follow_through", start_frame=release, end_frame=N - 1, anchor_frame=N - 1),
    ]
    rating = rate_release_timing(seq, phases)
    assert rating.verdict == "perfect"
    assert rating.timing_delta_ms == 0


def test_band_boundary_is_perfect():
    # ±60 ms band: 2 frames at 30 fps (66 ms) is outside, 1 frame is inside.
    inside = rate_release_timing(jump_sequence(), phases_for(1))
    assert inside.verdict == "perfect"
    outside = rate_release_timing(jump_sequence(), phases_for(2), perfect_band_ms=60)
    assert outside.verdict == "late"
