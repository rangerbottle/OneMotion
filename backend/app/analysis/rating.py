"""Quick shot rating: the "2K shot meter" — release timing vs. jump apex.

A one-motion jump shot should release at (or just before) the apex of the
jump. The verdict compares the release frame (elbow-extension anchor from
phase segmentation) against the jump apex (the lowest ankle height frame):

    delta = t_release − t_apex     < 0: early ·  ≈0: perfect ·  > 0: late

Evidence gating follows the project convention: occluded ankles, a missing
release anchor, or no measurable jump yield verdict=None with a reason —
never a fabricated rating.
"""

import numpy as np

from app.analysis.metrics import UnreliableData, _standing_height_px
from app.analysis.phases import phase_of, raw_conf
from app.analysis.series import series as kp_series
from app.schemas.analysis import PhaseSegment, ShotRating
from app.schemas.pose import ShotSequence

CONF_MIN = 0.5
MIN_ANKLE_COVERAGE = 0.8
# A jump must move the ankles by at least this share of standing height to be
# a jump; otherwise apex timing is noise.
MIN_JUMP_HEIGHT_RATIO = 0.03
PERFECT_BAND_MS = 60  # |delta| within this → perfect


def _ankle_series(seq: ShotSequence, start: int, end: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-frame ankle height (lower y = higher jump), validity and confidence."""
    n = end - start + 1
    y = np.full(n, np.nan)
    conf = np.zeros(n)
    for i in range(start, end + 1):
        ys, cs = [], []
        for name in ("left_ankle", "right_ankle"):
            c = raw_conf(seq, i, name)
            if c >= CONF_MIN:
                # series() returns pixel space; normalize by frame height so the
                # jump-amplitude ratio against standing height is unit-free.
                ys.append(float(kp_series(seq, name)[i, 1]) / seq.height)
                cs.append(c)
        if ys:
            y[i - start] = float(np.mean(ys))
            conf[i - start] = min(cs)
    return y, conf, np.isfinite(y)


def rate_release_timing(
    seq: ShotSequence, phases: list[PhaseSegment], perfect_band_ms: int = PERFECT_BAND_MS
) -> ShotRating:
    release_phase = phase_of(phases, "release")
    dip = phase_of(phases, "dip")
    follow = phase_of(phases, "follow_through")
    if release_phase.degraded or release_phase.censored:
        return ShotRating(
            verdict=None,
            timing_delta_ms=None,
            confidence=0.0,
            reliable=False,
            reason="release anchor is degraded — release timing cannot be judged",
        )
    release = release_phase.anchor_frame

    start, end = dip.start_frame, follow.end_frame
    y, conf, valid = _ankle_series(seq, start, end)
    coverage = float(valid.mean()) if len(valid) else 0.0
    if coverage < MIN_ANKLE_COVERAGE:
        return ShotRating(
            verdict=None,
            timing_delta_ms=None,
            confidence=round(coverage, 3),
            reliable=False,
            reason="ankles are not tracked through the jump — check that feet stay in frame",
        )
    y = np.interp(np.arange(len(y)), np.flatnonzero(valid), y[valid])

    # Jump amplitude: standing baseline (median ankle height before the dip)
    # minus the apex. Expressed as a share of standing height.
    baseline_y, baseline_conf, baseline_valid = _ankle_series(seq, 0, max(dip.start_frame, 0))
    if not baseline_valid.any():
        baseline_y = y[: max(1, dip.start_frame - start + 1)]
        baseline_conf = conf[: max(1, dip.start_frame - start + 1)]
    baseline = float(np.median(baseline_y))
    try:
        standing = _standing_height_px(seq, phases) / seq.height  # normalize to [0,1]
    except UnreliableData:
        standing = None
    apex_idx = int(np.argmin(y))
    apex_abs = start + apex_idx
    jump_ratio = None if standing is None else (baseline - y[apex_idx]) / standing
    if jump_ratio is not None and jump_ratio < MIN_JUMP_HEIGHT_RATIO:
        return ShotRating(
            verdict=None,
            timing_delta_ms=None,
            confidence=round(float(conf.mean()), 3),
            reliable=False,
            reason="no measurable jump — release timing is undefined for a standstill shot",
        )

    delta_ms = int(seq.frames[release].t_ms - seq.frames[apex_abs].t_ms)
    verdict = "perfect" if abs(delta_ms) <= perfect_band_ms else ("early" if delta_ms < 0 else "late")
    return ShotRating(
        verdict=verdict,
        timing_delta_ms=delta_ms,
        confidence=round(float(conf.mean()), 3),
        reliable=True,
        reason=None,
    )
