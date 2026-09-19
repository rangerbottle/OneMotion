"""Biomechanical metrics from a segmented shot sequence (docs/PRD.md §6).

All angle math happens in pixel space (keypoints are normalized per-axis,
so x/y must be rescaled by frame size before computing angles — see
`app.analysis.series`). Heights are normalized by standing height or torso
length so they survive different camera distances.

Confidence gating: every metric checks the raw confidence of the keypoints
it reads at the measured frames (CONF_MIN). If they were not really tracked
(occlusion, scene cuts), the metric raises UnreliableData and `compute_all`
omits it — a missing metric is honest, an interpolated one is fiction.

`release_angle_deg` is the forearm (elbow→wrist) elevation above horizontal
at release — a proxy for ball launch angle. A wrist-*velocity* proxy reads
wrong here: in a one-motion shot the wrist joint is nearly stationary at
its apex while the forearm snap launches the ball, so hand velocity at
release ≈ 0 (or already descending). Forearm elevation is measurable,
meaningful, and comparable across players; the true ball angle needs a future
ball-tracking model, but both benchmark and player use the same proxy.
"""

import numpy as np

from app.analysis.phases import phase_of, raw_conf, shooting_side
from app.analysis.series import angle_abc, midpoint, series
from app.schemas.analysis import PhaseSegment
from app.schemas.pose import ShotSequence

HEAD_TOP_FACTOR = 1.08  # eyes → top of head ≈ 8% of eye-to-ankle height
CONF_MIN = 0.5


class UnreliableData(Exception):
    """Raised when the keypoints a metric needs were not really tracked."""


def _require(seq: ShotSequence, frames: list[int], names: list[str]) -> None:
    for i in frames:
        i = min(max(i, 0), len(seq.frames) - 1)
        for name in names:
            if raw_conf(seq, i, name) < CONF_MIN:
                raise UnreliableData(f"{name} untracked at frame {i}")


def _standing_height_px(seq: ShotSequence, phases: list[PhaseSegment]) -> float:
    """Eye-to-ankle distance at the most upright frame of the shot, scaled
    to full height. Measuring at a fixed stance frame underestimates when
    the player is already crouched there, so take the max over dip→release.
    """
    start = phase_of(phases, "dip").start_frame
    end = phase_of(phases, "release").start_frame
    le, re_ = series(seq, "left_eye"), series(seq, "right_eye")
    la, ra = series(seq, "left_ankle"), series(seq, "right_ankle")
    best = 0.0
    for i in range(start, end + 1):
        try:
            _require(seq, [i], ["left_eye", "right_eye", "left_ankle", "right_ankle"])
        except UnreliableData:
            continue
        eye = midpoint(le[i], re_[i])
        ankle = midpoint(la[i], ra[i])
        best = max(best, float(abs(ankle[1] - eye[1])))
    if best == 0.0:
        raise UnreliableData("no upright frame with tracked eyes and ankles")
    return best * HEAD_TOP_FACTOR


def _torso_len_px(seq: ShotSequence, frame: int) -> float:
    _require(seq, [frame], ["left_shoulder", "right_shoulder", "left_hip", "right_hip"])
    shoulder = midpoint(
        series(seq, "left_shoulder")[frame], series(seq, "right_shoulder")[frame]
    )
    hip = midpoint(series(seq, "left_hip")[frame], series(seq, "right_hip")[frame])
    return float(np.linalg.norm(shoulder - hip))


def release_angle_deg(seq: ShotSequence, phases: list[PhaseSegment]) -> float:
    """Forearm (elbow→wrist) elevation above horizontal at release."""
    side = shooting_side(seq)
    r = phase_of(phases, "release").start_frame
    _require(seq, [r], [f"{side}_elbow", f"{side}_wrist"])
    v = series(seq, f"{side}_wrist")[r] - series(seq, f"{side}_elbow")[r]
    return float(np.degrees(np.arctan2(-v[1], abs(v[0]) + 1e-9)))


def release_height_ratio(seq: ShotSequence, phases: list[PhaseSegment]) -> float:
    """Wrist height above the floor at release ÷ standing height.

    Ankles are read at the stance (dip start) frame, not at release — the
    player is airborne at release, so release-frame ankles would inflate the
    height by the jump.
    """
    r = phase_of(phases, "release").start_frame
    stance = phase_of(phases, "dip").start_frame
    side = shooting_side(seq)
    _require(seq, [r], [f"{side}_wrist"])
    _require(seq, [stance], ["left_ankle", "right_ankle"])
    wrist_y = series(seq, f"{side}_wrist")[r, 1]
    ankle_y = midpoint(
        series(seq, "left_ankle")[stance], series(seq, "right_ankle")[stance]
    )[1]
    height = _standing_height_px(seq, phases)
    return float((ankle_y - wrist_y) / max(height, 1e-6))


def shot_tempo_s(seq: ShotSequence, phases: list[PhaseSegment]) -> float:
    """Dip bottom (load) → release, seconds. The one-motion signature."""
    load_phase = phase_of(phases, "load")
    release_phase = phase_of(phases, "release")
    load = load_phase.anchor_frame if load_phase.anchor_frame is not None else load_phase.start_frame
    release = release_phase.anchor_frame if release_phase.anchor_frame is not None else release_phase.start_frame
    tempo = (seq.frames[release].t_ms - seq.frames[load].t_ms) / 1000.0
    if tempo <= 0:
        raise UnreliableData("release is not after the dip bottom — phase order inverted")
    return float(tempo)


def knee_flexion_deg(seq: ShotSequence, phases: list[PhaseSegment]) -> float:
    """Minimum hip–knee–ankle angle (mean of both legs) during load."""
    load = phase_of(phases, "load")
    legs = [f"{s}_{p}" for s in ("left", "right") for p in ("hip", "knee", "ankle")]
    angles = []
    for i in range(load.start_frame, load.end_frame + 1):
        try:
            _require(seq, [i], legs)
        except UnreliableData:
            continue
        per_leg = [
            angle_abc(
                series(seq, f"{side}_hip")[i],
                series(seq, f"{side}_knee")[i],
                series(seq, f"{side}_ankle")[i],
            )
            for side in ("left", "right")
        ]
        angles.append(sum(per_leg) / 2)
    if not angles:
        raise UnreliableData("legs untracked through the whole load phase")
    return float(min(angles))


def elbow_angle_at_release_deg(seq: ShotSequence, phases: list[PhaseSegment]) -> float:
    """Shoulder–elbow–wrist angle of the shooting arm at release."""
    r = phase_of(phases, "release").start_frame
    side = shooting_side(seq)
    _require(seq, [r], [f"{side}_shoulder", f"{side}_elbow", f"{side}_wrist"])
    return angle_abc(
        series(seq, f"{side}_shoulder")[r],
        series(seq, f"{side}_elbow")[r],
        series(seq, f"{side}_wrist")[r],
    )


def set_point_ratio(seq: ShotSequence, phases: list[PhaseSegment]) -> float:
    """Wrist height relative to the shoulder at lift start, in torso lengths.

    Positive = wrist above shoulder (a high, two-motion set point). A true
    one-motion shot keeps this low — the ball rises continuously from the dip.
    """
    lift = phase_of(phases, "lift").start_frame
    side = shooting_side(seq)
    _require(seq, [lift], [f"{side}_wrist", f"{side}_shoulder"])
    wrist_y = series(seq, f"{side}_wrist")[lift, 1]
    shoulder_y = series(seq, f"{side}_shoulder")[lift, 1]
    torso = _torso_len_px(seq, lift)
    return float((shoulder_y - wrist_y) / max(torso, 1e-6))


def hip_shoulder_offset_ratio(seq: ShotSequence, phases: list[PhaseSegment]) -> float:
    """Horizontal shoulder-vs-hip offset at release, in torso lengths (lean)."""
    r = phase_of(phases, "release").start_frame
    shoulder_x = midpoint(
        series(seq, "left_shoulder")[r], series(seq, "right_shoulder")[r]
    )[0]
    hip_x = midpoint(series(seq, "left_hip")[r], series(seq, "right_hip")[r])[0]
    torso = _torso_len_px(seq, r)
    return float(abs(shoulder_x - hip_x) / max(torso, 1e-6))


def follow_through_hold_s(seq: ShotSequence, phases: list[PhaseSegment]) -> float:
    """Time the wrist stays high after release (the gooseneck hold)."""
    follow = phase_of(phases, "follow_through")
    if follow.censored:
        raise UnreliableData("follow-through remains held beyond the clip/window")
    release = phase_of(phases, "release").start_frame
    end = follow.end_frame
    return float((seq.frames[end].t_ms - seq.frames[release].t_ms) / 1000.0)


_METRIC_FNS = {
    "release_angle_deg": release_angle_deg,
    "release_height_ratio": release_height_ratio,
    "shot_tempo_s": shot_tempo_s,
    "knee_flexion_deg": knee_flexion_deg,
    "elbow_angle_at_release_deg": elbow_angle_at_release_deg,
    "set_point_ratio": set_point_ratio,
    "hip_shoulder_offset_ratio": hip_shoulder_offset_ratio,
    "follow_through_hold_s": follow_through_hold_s,
}


def measurement_evidence(
    seq: ShotSequence, phases: list[PhaseSegment]
) -> dict[str, dict[str, float | bool | str | None]]:
    """Return confidence and coverage behind every metric measurement."""
    side = shooting_side(seq)
    arm = [f"{side}_{joint}" for joint in ("shoulder", "elbow", "wrist")]
    torso = ["left_shoulder", "right_shoulder", "left_hip", "right_hip"]
    # Every dependent phase is gated separately: a missing anchor cannot be
    # averaged away by a long, well-tracked lift segment.
    requirements: dict[str, list[tuple[str, list[str]]]] = {
        "release_angle_deg": [("release", arm)],
        "release_height_ratio": [
            ("dip", ["left_ankle", "right_ankle"]),
            ("release", [f"{side}_wrist"]),
        ],
        "shot_tempo_s": [("load", [f"{side}_wrist"]), ("lift", [f"{side}_wrist"]), ("release", arm)],
        "knee_flexion_deg": [("load", [f"{s}_{p}" for s in ("left", "right") for p in ("hip", "knee", "ankle")])],
        "elbow_angle_at_release_deg": [("release", arm)],
        "set_point_ratio": [("lift", [f"{side}_wrist", *torso])],
        "hip_shoulder_offset_ratio": [("release", torso)],
        "follow_through_hold_s": [("release", arm), ("follow_through", [f"{side}_elbow", f"{side}_wrist"])],
    }
    evidence: dict[str, dict[str, float | bool | str | None]] = {}
    for name, dependencies in requirements.items():
        coverages, confidences = [], []
        reasons = []
        for phase_name, names in dependencies:
            phase = phase_of(phases, phase_name)
            samples = [raw_conf(seq, i, kp) for i in range(phase.start_frame, phase.end_frame + 1) for kp in names]
            coverage = sum(v >= CONF_MIN for v in samples) / max(len(samples), 1)
            confidence = float(np.mean(samples)) if samples else 0.0
            anchor = phase.anchor_frame if phase.anchor_frame is not None else phase.start_frame
            anchor_confidence = min((raw_conf(seq, anchor, kp) for kp in names), default=0.0)
            coverages.append(coverage)
            confidences.append(min(confidence, anchor_confidence))
            if phase.censored:
                reasons.append(f"{phase_name} phase extends beyond the available clip")
            elif phase.degraded:
                reasons.append(f"{phase_name} phase contains missing pose points")
            elif coverage < 0.75 or anchor_confidence < CONF_MIN:
                reasons.append(f"{phase_name} required joints or anchor are not reliably visible")
        if name == "release_height_ratio":
            try:
                _standing_height_px(seq, phases)
            except UnreliableData as exc:
                reasons.append(str(exc))
        evidence[name] = {
            "confidence": round(min(confidences, default=0.0), 3),
            "coverage": round(min(coverages, default=0.0), 3),
            "reliable": not reasons,
            "reason": "; ".join(reasons) or None,
        }
    return evidence


def compute_all(seq: ShotSequence, phases: list[PhaseSegment]) -> dict[str, float]:
    """All v1 metrics as a name → value dict; unreliable metrics are omitted."""
    results = {}
    for name, fn in _METRIC_FNS.items():
        try:
            results[name] = fn(seq, phases)
        except UnreliableData:
            continue
    return results
