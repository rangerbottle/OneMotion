"""Benchmark profile model (docs/ARCHITECTURE.md §4, stage 5)."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.analysis import MetricValue, PhaseSegment
from app.schemas.pose import ShotSequence

SCHEMA_VERSION = 1


class MetricStats(BaseModel):
    """Aggregated stats for one metric across all benchmark clips."""

    median: float
    p25: float
    p75: float
    n: int


class PhaseTiming(BaseModel):
    """Median duration (seconds) of each shot phase across benchmark clips."""

    phase: Literal["dip", "load", "lift", "release", "follow_through"]
    median_duration_s: float


class BenchmarkProfile(BaseModel):
    version: str  # e.g. "curry_v1"
    created_at: datetime
    source_clips: list[str]  # clip ids that built this profile
    backend: str  # pose backend name, e.g. "mediapipe"
    schema_version: int = SCHEMA_VERSION
    metrics: dict[str, MetricStats]
    phase_timing: list[PhaseTiming]
    # The clip closest to the median profile — used for skeleton overlay replay.
    canonical_clip_id: str
    canonical_sequence: ShotSequence | None = None
    canonical_phases: list[PhaseSegment] = Field(default_factory=list)
    display_name: str | None = None
    description: str | None = None
    source_url: str | None = None
    clip_start_ms: int | None = None
    clip_end_ms: int | None = None
    timing_mode: Literal["realtime", "slow_motion", "unknown"] = "unknown"
    time_scale_to_realtime: float | None = None
    timing_reliable: bool = False
    template_kind: Literal["aggregate", "single_reference"] = "aggregate"
    canonical_video_filename: str | None = None
    provenance: dict = Field(default_factory=dict)

    def metric_value(
        self,
        name: str,
        player_value: float | None,
        *,
        confidence: float = 1.0,
        coverage: float = 1.0,
        reliable: bool = True,
        unavailable_reason: str | None = None,
    ) -> MetricValue:
        stats = self.metrics[name]
        delta = (
            player_value - stats.median
            if reliable and player_value is not None
            else None
        )
        iqr = stats.p75 - stats.p25
        return MetricValue(
            name=name,
            value=player_value,
            benchmark_median=stats.median,
            benchmark_range=(stats.p25, stats.p75),
            delta=delta,
            delta_pct=(100.0 * delta / abs(stats.median))
            if delta is not None and stats.median
            else None,
            category="timing"
            if name in {"shot_tempo_s", "follow_through_hold_s"}
            else "form",
            confidence=confidence,
            coverage=coverage,
            benchmark_sample_count=stats.n,
            robust_z_score=(delta / (iqr / 1.349))
            if delta is not None and iqr > 1e-9
            else None,
            reliable=reliable,
            unavailable_reason=unavailable_reason,
        )
