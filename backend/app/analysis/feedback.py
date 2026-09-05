"""Rule-based feedback engine (docs/ARCHITECTURE.md §5).

Rules are data: each maps a metric deviation (direction + severity, in units
of that metric's tolerance from `app.analysis.compare`) to a plain-language
observation and one drill cue. `rank` fires every matching rule, orders by
severity, and returns the top 3 — coaching logic is tuned here, not buried
in conditionals across the codebase.
"""

from app.analysis.compare import TOLERANCES
from app.schemas.analysis import FeedbackItem, MetricValue, Phase

TOP_N = 3


class _Rule:
    def __init__(
        self,
        metric: str,
        direction: str,  # "low" | "high"
        min_severity: float,  # fire when |delta| / tolerance exceeds this
        phase: Phase | None,
        message: str,
        cue: str,
        boost: float = 1.0,
    ) -> None:
        self.metric = metric
        self.direction = direction
        self.min_severity = min_severity
        self.phase = phase
        self.message = message
        self.cue = cue
        self.boost = boost


RULES: list[_Rule] = [
    _Rule(
        "shot_tempo_s",
        "high",
        0.25,
        "lift",
        "Your load-to-release takes {value:.2f}s — Curry gets it off in {median:.2f}s.",
        "Start your leg drive as the ball dips; the ball should already be rising when your hips extend. One motion, no pause.",
        boost=1.3,
    ),
    _Rule(
        "set_point_ratio",
        "high",
        0.25,
        "lift",
        "You raise the ball above your shoulder before lifting (set point {value:.2f} vs Curry's {median:.2f}) — a two-motion habit.",
        "Keep the ball below your chin and let it rise in one continuous push from the dip.",
        boost=1.2,
    ),
    _Rule(
        "release_angle_deg",
        "low",
        0.25,
        "release",
        "Your release path is flat ({value:.0f}° vs Curry's {median:.0f}° forearm-angle proxy).",
        "Snap the wrist up, not out — finish with your fingers pointing at the rim, elbow above your eye.",
    ),
    _Rule(
        "knee_flexion_deg",
        "high",
        0.25,
        "load",
        "You barely bend your legs at the bottom ({value:.0f}° vs Curry's {median:.0f}°).",
        "Sit into the shot: hips back, knees over toes — the power of a one-motion shot is all legs.",
    ),
    _Rule(
        "release_height_ratio",
        "low",
        0.5,
        "release",
        "Your release point is low ({value:.2f} of your height vs Curry's {median:.2f}).",
        "Extend fully — release off the toes with the arm reaching, not from your chest.",
    ),
    _Rule(
        "elbow_angle_at_release_deg",
        "low",
        0.25,
        "release",
        "Your elbow is still bent at release ({value:.0f}° vs Curry's {median:.0f}°).",
        "Extend through the elbow; the arm should be nearly straight as the ball leaves.",
    ),
    _Rule(
        "hip_shoulder_offset_ratio",
        "high",
        0.5,
        "release",
        "Your shoulders drift away from your hips at release (lean {value:.2f} vs {median:.2f}).",
        "Jump straight up and land where you took off — shoulders stacked over hips.",
    ),
    _Rule(
        "follow_through_hold_s",
        "low",
        0.5,
        "follow_through",
        "You drop your hand immediately ({value:.2f}s hold vs Curry's {median:.2f}s).",
        "Hold the gooseneck until the ball reaches the rim.",
        boost=0.8,
    ),
]


def rank(deltas: list[MetricValue]) -> list[FeedbackItem]:
    """Return the top-3 prioritized corrections for the largest deltas."""
    fired: list[tuple[float, FeedbackItem]] = []
    for d in deltas:
        if (
            d.delta is None
            or d.value is None
            or d.benchmark_median is None
            or d.name not in TOLERANCES
            or not d.reliable
        ):
            continue
        tol, _ = TOLERANCES[d.name]
        severity = abs(d.delta) / tol
        for rule in RULES:
            if rule.metric != d.name:
                continue
            direction = "low" if d.delta < 0 else "high"
            if direction != rule.direction or severity < rule.min_severity:
                continue
            item = FeedbackItem(
                rank=0,  # assigned after sorting
                metric=d.name,
                phase=rule.phase,
                message=rule.message.format(value=d.value, median=d.benchmark_median),
                cue=rule.cue,
                confidence=round(d.confidence * d.coverage, 3),
                severity=round(severity, 2),
                player_value=d.value,
                benchmark_value=d.benchmark_median,
                benchmark_range=d.benchmark_range,
                benchmark_sample_count=d.benchmark_sample_count,
            )
            fired.append((severity * rule.boost, item))

    fired.sort(key=lambda x: x[0], reverse=True)
    return [
        item.model_copy(update={"rank": i + 1})
        for i, (_, item) in enumerate(fired[:TOP_N])
    ]
