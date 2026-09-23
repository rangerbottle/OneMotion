"""Temporal alignment suggestion for the compare domain.

Global offset only (no time warping, by V1 design): a coarse pose signal —
the mean vertical position of confident keypoints — is resampled to a fixed
grid and cross-correlated to propose the lag that best overlays clip B on
clip A. The proposal is advisory; the user confirms or overrides it.
"""

import numpy as np

from app.schemas.pose import ShotSequence

GRID_HZ = 100.0
MAX_LAG_S = 1.5
CONF_MIN = 0.5


def pose_signal(seq: ShotSequence) -> tuple[np.ndarray, np.ndarray]:
    """(t_ms, normalized mean-y of confident keypoints) with gaps interpolated."""
    t = np.array([frame.t_ms for frame in seq.frames], dtype=float)
    n = len(seq.frames)
    y = np.full(n, np.nan)
    for i, frame in enumerate(seq.frames):
        pts = [kp.y for kp in frame.keypoints if kp.confidence >= CONF_MIN]
        if pts:
            y[i] = float(np.mean(pts))
    valid = np.isfinite(y)
    if valid.sum() < 2:
        return t, np.zeros(n)
    y = np.interp(t, t[valid], y[valid])
    std = y.std()
    return t, (y - y.mean()) / (std if std > 1e-9 else 1.0)


def suggest_offset_ms(
    seq_a: ShotSequence, seq_b: ShotSequence
) -> tuple[int, int, float | None]:
    """Propose (offset_ms_a, offset_ms_b) and peak confidence in [0,1].

    Consumers map t_b = t_a − offset_a + offset_b, so a positive offset_b
    means B's action starts later in B's clip. The correlation finds
    lag = offset_a − offset_b; the difference is split onto the two anchors
    so neither is ever negative.
    """
    t_a, s_a = pose_signal(seq_a)
    t_b, s_b = pose_signal(seq_b)
    duration_a = t_a[-1] - t_a[0] if len(t_a) else 0.0
    duration_b = t_b[-1] - t_b[0] if len(t_b) else 0.0
    if min(duration_a, duration_b) < 1000.0:
        return 0, 0, None
    grid = np.arange(0.0, min(duration_a, duration_b) + 1e-6, 1000.0 / GRID_HZ)
    a = np.interp(grid, t_a - t_a[0], s_a)
    b = np.interp(grid, t_b - t_b[0], s_b)
    max_lag = int(MAX_LAG_S * GRID_HZ)
    a = a - a.mean()
    b = b - b.mean()
    # correlate a with shifted b: best_lag = offset_a − offset_b.
    best_lag, best_score = 0, -np.inf
    for lag in range(-max_lag, max_lag + 1):
        if lag >= 0:
            x, yv = a[lag:], b[: len(a) - lag]
        else:
            x, yv = a[: len(a) + lag], b[-lag:]
        if len(x) < GRID_HZ / 2:
            continue
        # Normalize by the overlap's own norms so short overlaps cannot win
        # by correlation length alone.
        denom = float(np.sqrt(np.sum(x**2) * np.sum(yv**2)))
        if denom <= 1e-12:
            continue
        score = float(np.dot(x, yv)) / denom
        if score > best_score:
            best_score, best_lag = score, lag
    if best_score <= 0:
        return 0, 0, None
    delta_ms = int(round(-best_lag * 1000.0 / GRID_HZ))  # = offset_b − offset_a
    if delta_ms >= 0:
        return 0, delta_ms, round(best_score, 3)
    return -delta_ms, 0, round(best_score, 3)
