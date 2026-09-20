"""Analysis request/response models (see docs/ARCHITECTURE.md §6)."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.pose import ShotSequence

Phase = Literal["dip", "load", "lift", "release", "follow_through"]


class PhaseSegment(BaseModel):
    phase: Phase
    # Indices into ShotSequence.frames (not raw video frame numbers).
    start_frame: int
    end_frame: int
    start_ms: int = 0
    end_ms: int = 0
    degraded: bool = False  # True when keypoint confidence forced interpolation
    anchor_frame: int | None = None
    anchor_ms: int | None = None
    censored: bool = False


class MetricValue(BaseModel):
    name: str  # e.g. "release_angle_deg"
    value: float | None
    benchmark_median: float | None = None
    benchmark_range: tuple[float, float] | None = None  # acceptable IQR band
    delta: float | None = None
    delta_pct: float | None = None
    category: Literal["form", "timing"] = "form"
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    coverage: float = Field(default=1.0, ge=0.0, le=1.0)
    benchmark_sample_count: int | None = None
    robust_z_score: float | None = None
    reliable: bool = True
    unavailable_reason: str | None = None


class FeedbackItem(BaseModel):
    rank: int
    metric: str
    phase: Phase | None = None
    message: str  # plain-language observation, e.g. "Your release angle is 41°"
    cue: str  # drill cue, e.g. "Finish with your hand above your eye line"
    confidence: float = 1.0
    severity: float | None = None
    player_value: float | None = None
    benchmark_value: float | None = None
    benchmark_range: tuple[float, float] | None = None
    benchmark_sample_count: int | None = None


class AnalysisQuality(BaseModel):
    status: Literal["valid", "degraded", "insufficient"]
    coverage: float
    valid_metrics: int
    expected_metrics: int
    missing_metrics: list[str] = Field(default_factory=list)
    degraded_phases: list[Phase] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)


class CaptureQuality(BaseModel):
    """Multi-frame capture suitability without pretending to know exact yaw."""

    status: Literal["pass", "warn", "fail"]
    side_view_score: float = Field(ge=0.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)
    body_visibility: float = Field(ge=0.0, le=1.0)
    projected_body_width_ratio: float | None = None
    reasons: list[str] = Field(default_factory=list)
    guidance: list[str] = Field(default_factory=list)
    method: str = "pose_2d_side_likelihood_v1"


class AnalysisResult(BaseModel):
    analysis_id: str
    benchmark_version: str
    similarity_score: float | None  # 0-100; None means insufficient evidence
    form_score: float | None = None
    timing_score: float | None = None
    template_id: str | None = None
    template_name: str | None = None
    timing_mode: Literal["realtime", "slow_motion", "unknown"] = "unknown"
    timing_reliable: bool = False
    quality: AnalysisQuality | None = None
    capture_quality: CaptureQuality | None = None
    phases: list[PhaseSegment]
    metrics: list[MetricValue]
    feedback: list[FeedbackItem]  # top 3, priority ordered
    measurement_evidence: dict[str, dict[str, float | bool | str | None]] = Field(default_factory=dict)
    # Skeleton replay (FR-4.2): player sequence + benchmark canonical sequence.
    # Optional so analyses persisted before replay was added still load.
    player_sequence: ShotSequence | None = None
    benchmark_sequence: ShotSequence | None = None
    benchmark_phases: list[PhaseSegment] | None = None
    player_video_url: str | None = None
    template_video_url: str | None = None
    media_expires_at: datetime | None = None
