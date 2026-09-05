"""Confidence-gated biomechanical values for every decoded pose frame."""

from __future__ import annotations

import math

import numpy as np

from app.analysis.phases import CONF_MIN, phase_of, raw_conf, shooting_side
from app.analysis.series import midpoint, series
from app.schemas.analysis import PhaseSegment
from app.schemas.pose import ShotSequence
from app.schemas.template import BiomechanicsFrame, DerivedValue


def _derived(
    value: float | None,
    confidences: list[float],
    *,
    reason: str = "required joints are not reliably visible",
) -> DerivedValue:
    confidence = min(confidences, default=0.0)
    reliable = value is not None and math.isfinite(value) and confidence >= CONF_MIN
    return DerivedValue(
        value=round(float(value), 3) if reliable else None,
        confidence=round(float(confidence), 3),
        reliable=reliable,
        interpolated=0.0 < confidence < CONF_MIN,
        unavailable_reason=None if reliable else reason,
    )


def _angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float | None:
    ba, bc = a - b, c - b
    denominator = float(np.linalg.norm(ba) * np.linalg.norm(bc))
    if denominator < 1e-6:
        return None
    cosine = float(np.dot(ba, bc) / denominator)
    return float(np.degrees(np.arccos(np.clip(cosine, -1.0, 1.0))))


def _phase_at(phases: list[PhaseSegment], frame: int) -> str | None:
    # Release wins at shared boundaries so the scored anchor is unmistakable.
    release = phase_of(phases, "release")
    if release.start_frame <= frame <= release.end_frame:
        return "release"
    for phase in phases:
        if phase.start_frame <= frame <= phase.end_frame:
            return phase.phase
    return None


def compute_frame_biomechanics(
    seq: ShotSequence, phases: list[PhaseSegment]
) -> list[BiomechanicsFrame]:
    """Return one annotation for every pose frame, aligned by frame_idx/t_ms."""
    side = shooting_side(seq)
    release_frame = phase_of(phases, "release").anchor_frame
    if release_frame is None:
        release_frame = phase_of(phases, "release").start_frame

    trajectories = {
        name: series(seq, name)
        for name in (
            "left_shoulder",
            "right_shoulder",
            "left_elbow",
            "right_elbow",
            "left_wrist",
            "right_wrist",
            "left_hip",
            "right_hip",
            "left_knee",
            "right_knee",
            "left_ankle",
            "right_ankle",
        )
    }

    # Velocity uses raw adjacent samples; interpolated neighbors must not be
    # advertised as measurements. The body scale has its own confidence gate.
    scale_names = ("left_ankle", "right_ankle", "left_shoulder", "right_shoulder")
    raw = {name: series(seq, name, smooth_window=1) for name in (*scale_names, f"{side}_wrist")}
    height_samples, scale_confidences = [], []
    for i in range(len(seq.frames)):
        conf = min(raw_conf(seq, i, name) for name in scale_names)
        if conf < CONF_MIN:
            continue
        ankle = midpoint(raw["left_ankle"][i], raw["right_ankle"][i])
        shoulder = midpoint(raw["left_shoulder"][i], raw["right_shoulder"][i])
        height = abs(float(ankle[1] - shoulder[1])) * 1.45
        if height > 1:
            height_samples.append(height)
            scale_confidences.append(conf)
    enough_scale = len(height_samples) >= max(2, math.ceil(len(seq.frames) * 0.75))
    body_height = float(np.median(height_samples)) if enough_scale else None
    scale_confidence = min(scale_confidences, default=0.0) if enough_scale else 0.0
    wrist_y = raw[f"{side}_wrist"][:, 1]
    times = np.array([frame.t_ms for frame in seq.frames], dtype=float) / 1000.0

    output: list[BiomechanicsFrame] = []
    for i, frame in enumerate(seq.frames):
        def confidences(*names: str) -> list[float]:
            return [raw_conf(seq, i, name) for name in names]

        elbow_names = (f"{side}_shoulder", f"{side}_elbow", f"{side}_wrist")
        elbow = _derived(
            _angle(*(trajectories[name][i] for name in elbow_names)),
            confidences(*elbow_names),
        )

        knees = {}
        for leg in ("left", "right"):
            names = (f"{leg}_hip", f"{leg}_knee", f"{leg}_ankle")
            knees[leg] = _derived(
                _angle(*(trajectories[name][i] for name in names)),
                confidences(*names),
            )

        forearm_names = (f"{side}_elbow", f"{side}_wrist")
        vector = trajectories[forearm_names[1]][i] - trajectories[forearm_names[0]][i]
        forearm_value = float(
            np.degrees(np.arctan2(-vector[1], abs(vector[0]) + 1e-9))
        )
        forearm = _derived(forearm_value, confidences(*forearm_names))

        trunk_names = ("left_shoulder", "right_shoulder", "left_hip", "right_hip")
        shoulder_mid = midpoint(
            trajectories["left_shoulder"][i], trajectories["right_shoulder"][i]
        )
        hip_mid = midpoint(trajectories["left_hip"][i], trajectories["right_hip"][i])
        trunk_vector = shoulder_mid - hip_mid
        trunk_value = float(
            np.degrees(np.arctan2(trunk_vector[0], -trunk_vector[1] + 1e-9))
        )
        trunk = _derived(trunk_value, confidences(*trunk_names))

        lo, hi = max(0, i - 1), min(len(seq.frames) - 1, i + 1)
        neighbor_confidences = [raw_conf(seq, j, f"{side}_wrist") for j in range(lo, hi + 1)]
        valid_times = hi > lo and all(times[j + 1] > times[j] for j in range(lo, hi))
        velocity = None
        if body_height is not None and valid_times:
            velocity = -float(np.gradient(wrist_y[lo:hi + 1], times[lo:hi + 1])[i - lo]) / body_height
        wrist_velocity = _derived(
            velocity, [scale_confidence, *neighbor_confidences],
            reason="body scale, adjacent wrist samples, or timestamps are unreliable",
        )
        is_release = i == release_frame
        release_value = (
            forearm
            if is_release
            else DerivedValue(
                value=None,
                confidence=forearm.confidence,
                reliable=False,
                interpolated=forearm.interpolated,
                unavailable_reason="defined only at the release anchor",
            )
        )
        output.append(
            BiomechanicsFrame(
                frame_idx=frame.frame_idx,
                t_ms=frame.t_ms,
                phase=_phase_at(phases, i),
                shooting_side=side,
                is_release_frame=is_release,
                elbow_flexion_deg=elbow,
                left_knee_flexion_deg=knees["left"],
                right_knee_flexion_deg=knees["right"],
                forearm_elevation_deg=forearm,
                release_angle_proxy_deg=release_value,
                trunk_lean_deg=trunk,
                wrist_vertical_velocity_height_s=wrist_velocity,
            )
        )
    return output
