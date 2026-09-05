"""Per-frame geometry and capture-quality regression tests."""

import pytest

from app.analysis.biomechanics import compute_frame_biomechanics
from app.analysis.capture_quality import assess_capture
from app.schemas.analysis import PhaseSegment
from app.schemas.pose import COCO17_KEYPOINTS, Keypoint, PoseFrame, ShotSequence


def sequence() -> ShotSequence:
    positions = {
        "left_shoulder": (0.48, 0.30),
        "right_shoulder": (0.52, 0.30),
        "left_elbow": (0.48, 0.50),
        "right_elbow": (0.52, 0.50),
        "left_wrist": (0.48, 0.70),
        "right_wrist": (0.82, 0.50),
        "left_hip": (0.49, 0.55),
        "right_hip": (0.51, 0.55),
        "left_knee": (0.49, 0.72),
        "right_knee": (0.51, 0.72),
        "left_ankle": (0.66, 0.72),
        "right_ankle": (0.68, 0.72),
    }
    frames = []
    for frame_idx in range(3):
        keypoints = [
            Keypoint(
                name=name,
                x=positions.get(name, (0.5, 0.2))[0],
                y=positions.get(name, (0.5, 0.2))[1],
                confidence=0.95,
            )
            for name in COCO17_KEYPOINTS
        ]
        frames.append(PoseFrame(frame_idx=frame_idx, t_ms=frame_idx * 100, keypoints=keypoints))
    return ShotSequence(clip_id="fixture", fps=10, width=100, height=100, frames=frames)


def phases() -> list[PhaseSegment]:
    return [
        PhaseSegment(phase="dip", start_frame=0, end_frame=0, anchor_frame=0),
        PhaseSegment(phase="load", start_frame=0, end_frame=0, anchor_frame=0),
        PhaseSegment(phase="lift", start_frame=1, end_frame=1, anchor_frame=1),
        PhaseSegment(phase="release", start_frame=2, end_frame=2, anchor_frame=2),
        PhaseSegment(phase="follow_through", start_frame=2, end_frame=2, anchor_frame=2),
    ]


def test_biomechanics_has_one_record_per_frame_and_release_semantics() -> None:
    result = compute_frame_biomechanics(sequence(), phases())
    assert [item.frame_idx for item in result] == [0, 1, 2]
    assert result[0].elbow_flexion_deg.value == pytest.approx(180)
    assert result[0].right_knee_flexion_deg.value == pytest.approx(90)
    assert result[0].release_angle_proxy_deg.value is None
    assert result[2].is_release_frame is True
    assert result[2].release_angle_proxy_deg.value == result[2].forearm_elevation_deg.value


def test_untracked_joint_produces_null_not_fabricated_angle() -> None:
    seq = sequence()
    point = next(k for k in seq.frames[1].keypoints if k.name == "left_elbow")
    point.confidence = 0
    result = compute_frame_biomechanics(seq, phases())
    assert result[1].elbow_flexion_deg.value is None
    assert result[1].elbow_flexion_deg.reliable is False
    assert result[1].elbow_flexion_deg.unavailable_reason


def test_side_view_capture_quality_is_multi_frame_and_bounded() -> None:
    quality = assess_capture(sequence(), phases())
    assert quality.status in {"pass", "warn"}
    assert 0 <= quality.side_view_score <= 1
    assert quality.body_visibility == pytest.approx(1)
