"""Quick shot rating: the "2K shot meter" — release timing vs. jump apex.

A jump shot should release at (or just before) the apex of the body's rise.
The verdict compares the release frame (elbow-extension anchor from phase
segmentation) against the jump apex, the highest hip position inside the
lift window:

    delta = t_release − t_apex     < 0: early ·  ≈0: perfect ·  > 0: late

The apex search is bounded to [load end, release + 0.5 s] — ankle/hip noise
during setup (dribbling, stepping) must not win over the actual jump.

Evidence gating follows the project convention: hips untracked through the
jump (<80% coverage), a degraded release anchor, or no measurable rise
(<3% of standing height) all yield verdict=None with a reason — never a
fabricated rating.
"""

import numpy as np

from app.analysis.metrics import UnreliableData, _standing_height_px
from app.analysis.phases import phase_of, raw_conf
from app.analysis.series import series as kp_series
from app.schemas.analysis import PhaseSegment, ShotRating
from app.schemas.pose import ShotSequence

CONF_MIN = 0.5
MIN_HIP_COVERAGE = 0.8
# The hips must rise by at least this share of standing height for an apex
# to be real; below it the "apex" is pose noise on a standstill shot.
MIN_JUMP_HEIGHT_RATIO = 0.03
PERFECT_BAND_MS = 60  # |delta| within this → perfect
POST_RELEASE_APEX_MS = 500  # an early release puts the apex just after release


def _hip_series(seq: ShotSequence, start: int, end: int) -> tuple[np.ndarray, np.ndarray]:
    """Per-frame hip midpoint height (pixel y, lower = higher) + confidence."""
    left = kp_series(seq, "left_hip")
    right = kp_series(seq, "right_hip")
    n = end - start + 1
    y = np.full(n, np.nan)
    conf = np.zeros(n)
    for i in range(start, end + 1):
        ys, cs = [], []
        for name, pts in (("left_hip", left), ("right_hip", right)):
            c = raw_conf(seq, i, name)
            if c >= CONF_MIN:
                ys.append(float(pts[i, 1]))
                cs.append(c)
        if ys:
            y[i - start] = float(np.mean(ys))
            conf[i - start] = min(cs)
    return y, conf


def rate_release_timing(
    seq: ShotSequence, phases: list[PhaseSegment], perfect_band_ms: int = PERFECT_BAND_MS
) -> ShotRating:
    release_phase = phase_of(phases, "release")
    dip = phase_of(phases, "dip")
    load = phase_of(phases, "load")
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
    release_ms = seq.frames[release].t_ms

    apex_end = phase_of(phases, "lift").end_frame
    # Extend past release so an early release's apex is still observable.
    while apex_end < follow.end_frame and seq.frames[apex_end].t_ms < release_ms + POST_RELEASE_APEX_MS:
        apex_end += 1

    y, conf = _hip_series(seq, 0, follow.end_frame)
    valid = np.isfinite(y)
    apex_window = y[load.end_frame : apex_end + 1]
    apex_valid = np.isfinite(apex_window)
    coverage = float(apex_valid.mean()) if len(apex_valid) else 0.0
    if coverage < MIN_HIP_COVERAGE:
        return ShotRating(
            verdict=None,
            timing_delta_ms=None,
            confidence=round(coverage, 3),
            reliable=False,
            reason="hips are not tracked through the jump — check that the whole body stays in frame",
        )

    baseline_end = max(load.end_frame, dip.start_frame)
    baseline_vals = y[dip.start_frame : baseline_end + 1]
    baseline_vals = baseline_vals[np.isfinite(baseline_vals)]
    if not len(baseline_vals):
        baseline_vals = y[np.isfinite(y)][:3]
    if not len(baseline_vals):
        return ShotRating(
            verdict=None, timing_delta_ms=None, confidence=0.0, reliable=False,
            reason="hips are not tracked before the jump — cannot establish a baseline",
        )
    baseline = float(np.median(baseline_vals))
    apex_offset = int(np.nanargmin(apex_window))
    apex_frame = load.end_frame + apex_offset

    try:
        standing_norm = _standing_height_px(seq, phases) / seq.height
    except UnreliableData:
        standing_norm = None
    if standing_norm is None:
        # Without a height normalization the amplitude gate cannot run —
        # a raw-frame apex is pose noise, so there is no honest verdict.
        return ShotRating(
            verdict=None,
            timing_delta_ms=None,
            confidence=round(float(conf.mean()), 3),
            reliable=False,
            reason="standing height could not be measured — jump amplitude is unknown",
        )
    jump_ratio = (baseline - y[apex_frame]) / seq.height / standing_norm
    if jump_ratio < MIN_JUMP_HEIGHT_RATIO:
        return ShotRating(
            verdict=None,
            timing_delta_ms=None,
            confidence=round(float(conf.mean()), 3),
            reliable=False,
            reason="no measurable jump — release timing is undefined for a standstill shot",
        )

    delta_ms = int(seq.frames[release].t_ms - seq.frames[apex_frame].t_ms)
    verdict = "perfect" if abs(delta_ms) <= perfect_band_ms else ("early" if delta_ms < 0 else "late")
    return ShotRating(
        verdict=verdict,
        timing_delta_ms=delta_ms,
        confidence=round(float(conf.mean()), 3),
        reliable=True,
        reason=None,
    )
