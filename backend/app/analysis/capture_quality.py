"""Conservative multi-frame checks for side-view shooting footage."""

from __future__ import annotations

import numpy as np

from app.analysis.phases import CONF_MIN, raw_conf
from app.analysis.series import midpoint, series
from app.schemas.analysis import CaptureQuality, PhaseSegment
from app.schemas.pose import ShotSequence


def assess_capture(seq: ShotSequence, phases: list[PhaseSegment]) -> CaptureQuality:
    start = phases[0].start_frame
    end = next(p for p in phases if p.phase == "release").end_frame
    required = [
        "left_shoulder",
        "right_shoulder",
        "left_hip",
        "right_hip",
        "left_knee",
        "right_knee",
        "left_ankle",
        "right_ankle",
    ]
    visible = [
        raw_conf(seq, frame, name) >= CONF_MIN
        for frame in range(start, end + 1)
        for name in required
    ]
    body_visibility = float(np.mean(visible)) if visible else 0.0

    shoulder_left = series(seq, "left_shoulder")
    shoulder_right = series(seq, "right_shoulder")
    hip_left = series(seq, "left_hip")
    hip_right = series(seq, "right_hip")
    ratios = []
    valid_frames = 0
    for frame in range(start, end + 1):
        confidences = [raw_conf(seq, frame, name) for name in required[:4]]
        if min(confidences, default=0.0) < CONF_MIN:
            continue
        shoulder_mid = midpoint(shoulder_left[frame], shoulder_right[frame])
        hip_mid = midpoint(hip_left[frame], hip_right[frame])
        torso = float(np.linalg.norm(shoulder_mid - hip_mid))
        if torso < 1.0:
            continue
        breadth = (
            float(np.linalg.norm(shoulder_left[frame] - shoulder_right[frame]))
            + float(np.linalg.norm(hip_left[frame] - hip_right[frame]))
        ) / 2.0
        ratios.append(breadth / torso)
        valid_frames += 1

    width_ratio = float(np.median(ratios)) if ratios else None
    if width_ratio is None:
        side_score = 0.0
    else:
        # A side-on body projects left/right shoulders and hips close together.
        # This is a likelihood, not a claimed camera-yaw measurement.
        side_score = float(np.clip(1.0 - max(width_ratio - 0.22, 0.0) / 0.7, 0.0, 1.0))
    frame_confidence = valid_frames / max(end - start + 1, 1)
    confidence = float(np.clip(min(body_visibility, frame_confidence), 0.0, 1.0))

    reasons: list[str] = []
    guidance: list[str] = []
    if body_visibility < 0.72:
        reasons.append("full-body joints are missing through the shot")
        guidance.append("Keep head, hips, knees, ankles, and the shooting arm in frame.")
    if side_score < 0.55:
        reasons.append("the body appears too frontal or rear-facing for a Curry comparison")
        guidance.append("Move the camera to the shooting-hand side, perpendicular to the rim.")
    elif side_score < 0.75:
        reasons.append("the view is somewhat oblique rather than a clean side view")
        guidance.append("Rotate the camera closer to a 90° side-on position.")

    status = "pass"
    if body_visibility < 0.5 or confidence < 0.35:
        status = "fail"
    elif reasons:
        status = "warn"
    return CaptureQuality(
        status=status,
        side_view_score=round(side_score, 3),
        confidence=round(confidence, 3),
        body_visibility=round(body_visibility, 3),
        projected_body_width_ratio=round(width_ratio, 3) if width_ratio is not None else None,
        reasons=reasons,
        guidance=guidance,
    )
