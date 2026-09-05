"""Player-vs-benchmark comparison: phase-anchored DTW + metric deltas.

The similarity score is a weighted mean of per-metric scores, where each
metric scores 1.0 at the benchmark median and decays linearly to 0 at
TOLERANCE distance (docs/ARCHITECTURE.md §5).
"""

import numpy as np

from app.analysis.phases import phase_of, shooting_side
from app.analysis.series import series
from app.schemas.analysis import MetricValue
from app.schemas.benchmark import BenchmarkProfile
from app.schemas.pose import ShotSequence

# (tolerance, weight) per metric: score hits 0 at |delta| == tolerance.
TOLERANCES: dict[str, tuple[float, float]] = {
    "release_angle_deg": (8.0, 1.5),
    "shot_tempo_s": (0.15, 1.5),
    "set_point_ratio": (0.20, 1.25),
    "knee_flexion_deg": (15.0, 1.0),
    "elbow_angle_at_release_deg": (15.0, 1.0),
    "release_height_ratio": (0.08, 1.0),
    "hip_shoulder_offset_ratio": (0.10, 0.75),
    "follow_through_hold_s": (0.20, 0.5),
}


def dtw_align(a: np.ndarray, b: np.ndarray) -> list[tuple[int, int]]:
    """Classic DTW alignment path between two 1-D series."""
    n, m = len(a), len(b)
    window = max(n, m) // 4 + 1
    cost = np.full((n + 1, m + 1), np.inf)
    cost[0, 0] = 0.0
    for i in range(1, n + 1):
        for j in range(max(1, i - window), min(m, i + window) + 1):
            cost[i, j] = abs(a[i - 1] - b[j - 1]) + min(
                cost[i - 1, j], cost[i, j - 1], cost[i - 1, j - 1]
            )
    path = []
    i, j = n, m
    while i > 0 and j > 0:
        path.append((i - 1, j - 1))
        step = np.argmin([cost[i - 1, j], cost[i, j - 1], cost[i - 1, j - 1]])
        i, j = [(i - 1, j), (i, j - 1), (i - 1, j - 1)][step]
    return path[::-1]


def align(player: ShotSequence, benchmark: ShotSequence) -> list[tuple[int, int]]:
    """Phase-anchored DTW on shooting-wrist height during the lift phase.

    Returns (player_frame_idx, benchmark_frame_idx) pairs, indices into each
    sequence's frames list. Used for skeleton overlay sync.
    """
    from app.analysis.phases import segment

    def lift_height(seq: ShotSequence) -> np.ndarray:
        phases = segment(seq)
        lift = phase_of(phases, "lift")
        wrist = series(seq, f"{shooting_side(seq)}_wrist")
        h = -wrist[lift.start_frame : lift.end_frame + 1, 1]
        return h

    return dtw_align(lift_height(player), lift_height(benchmark))


def metric_deltas(
    player_metrics: dict[str, float],
    benchmark: BenchmarkProfile,
    evidence: dict[str, dict[str, float | bool | str | None]] | None = None,
) -> list[MetricValue]:
    """Per-metric player value vs. benchmark median/acceptable range."""
    evidence = evidence or {}
    values: list[MetricValue] = []
    for name in benchmark.metrics:
        item = evidence.get(name, {})
        value = player_metrics.get(name)
        reliable = bool(item.get("reliable", value is not None))
        reason = item.get("reason")
        if value is None:
            reliable = False
            reason = reason or "metric could not be measured from this clip"
        if (
            name in {"shot_tempo_s", "follow_through_hold_s"}
            and not benchmark.timing_reliable
        ):
            reliable = False
            reason = "selected template is slow-motion; timing comparison is disabled"
        values.append(
            benchmark.metric_value(
                name,
                value,
                confidence=float(item.get("confidence", 0.0 if value is None else 1.0)),
                coverage=float(item.get("coverage", 0.0 if value is None else 1.0)),
                reliable=reliable,
                unavailable_reason=str(reason) if reason else None,
            )
        )
    return values


def similarity_score(
    deltas: list[MetricValue], category: str | None = None
) -> float | None:
    """Weighted 0–100 score across reliable metrics only."""
    total = weight = 0.0
    for d in deltas:
        if (
            d.name not in TOLERANCES
            or d.delta is None
            or not d.reliable
            or (category is not None and d.category != category)
        ):
            continue
        tol, w = TOLERANCES[d.name]
        evidence_weight = w * d.confidence * d.coverage
        total += evidence_weight * max(0.0, 1.0 - abs(d.delta) / tol)
        weight += evidence_weight
    return round(100.0 * total / weight, 1) if weight else None
