"""Frame-by-frame comparison domain (players / action templates / clips).

V1 constraints, by design: two clips only, same camera position, global
time offset only (no time warping). Phase boundaries are user-adjustable
frame ranges initialised from the action template — not auto-segmented.
"""

from datetime import datetime, timezone
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    BeforeValidator,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from app.schemas.media_source import MediaSource


def _integer_not_boolean(value):
    if isinstance(value, bool):
        raise ValueError("must be an integer, not a boolean")
    return value


NonBlankText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
EntityId = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{12,32}$")]
NonNegativeInt = Annotated[int, BeforeValidator(_integer_not_boolean), Field(ge=0)]


class PlayerCreate(BaseModel):
    name: NonBlankText


class ActionTemplateCreate(BaseModel):
    name: NonBlankText
    default_phases: list[NonBlankText] = Field(min_length=1)

    @field_validator("default_phases")
    @classmethod
    def unique_phases(cls, phases: list[str]) -> list[str]:
        if len(set(phases)) != len(phases):
            raise ValueError("phase names must be unique")
        return phases


class ComparisonCreate(BaseModel):
    player_id: EntityId
    template_id: EntityId
    baseline_clip_id: EntityId
    comparison_clip_id: EntityId

    @model_validator(mode="after")
    def distinct_clips(self) -> "ComparisonCreate":
        if self.baseline_clip_id == self.comparison_clip_id:
            raise ValueError("baseline and comparison clips must differ")
        return self


class Player(BaseModel):
    player_id: str
    name: str
    created_at: datetime


class ActionTemplate(BaseModel):
    template_id: str
    player_id: str
    name: str
    # Phase names in order, e.g. ["prep", "load", "drive", "release", "follow"].
    default_phases: list[str] = Field(min_length=1)
    created_at: datetime


class CameraCheckResult(BaseModel):
    status: Literal["match", "suspect", "mismatch"]
    inlier_ratio: float = Field(ge=0.0, le=1.0)
    matches: int = Field(ge=0)
    # 3x3 homography estimated on background features; None when too few matches.
    homography: list[list[float]] | None = None


class AffineTransform(BaseModel):
    # Origin-centered pixel transform mapping clip B onto clip A's frame
    # (x' = scale·R·x + t), in clip A's pixel resolution; both renderers
    # (frontend stage and report drawing) use this same convention.
    tx: float = Field(default=0.0, allow_inf_nan=False)
    ty: float = Field(default=0.0, allow_inf_nan=False)
    scale: float = Field(default=1.0, gt=0, allow_inf_nan=False)
    rotation_deg: float = Field(default=0.0, allow_inf_nan=False)


class ClipMeta(BaseModel):
    clip_id: str
    player_id: str
    template_id: str
    kind: Literal["baseline", "comparison"]
    filename: str
    fps: float = Field(gt=0, allow_inf_nan=False)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    frame_count: int = Field(ge=0)
    duration_ms: int = Field(ge=0)
    camera: CameraCheckResult | None = None  # set when used as comparison side B
    source: MediaSource | None = None
    created_at: datetime


class PhaseBoundary(BaseModel):
    phase: NonBlankText
    start_frame: NonNegativeInt
    end_frame: NonNegativeInt

    @model_validator(mode="after")
    def ordered_range(self) -> "PhaseBoundary":
        if self.start_frame > self.end_frame:
            raise ValueError("phase starts after it ends")
        return self


class EventMarker(BaseModel):
    marker_id: NonBlankText
    side: Literal["a", "b", "both"] = "both"
    frame: NonNegativeInt  # frame in clip A's timeline; B maps through the offset
    t_ms: NonNegativeInt
    text: str = ""
    created_at: datetime


class TemporalAlignment(BaseModel):
    # "Action start" anchor picked per clip; playback maps t_b - offset_b + offset_a.
    offset_ms_a: NonNegativeInt = 0
    offset_ms_b: NonNegativeInt = 0
    suggested_offset_ms_b: NonNegativeInt | None = None  # cross-correlation proposal
    suggestion_confidence: float | None = Field(default=None, ge=0.0, le=1.0, allow_inf_nan=False)


class TemporalAlignmentUpdate(BaseModel):
    # Omitted anchors retain the stored value; optional suggestion fields can be cleared.
    offset_ms_a: NonNegativeInt | None = None
    offset_ms_b: NonNegativeInt | None = None
    suggested_offset_ms_b: NonNegativeInt | None = None
    suggestion_confidence: float | None = Field(default=None, ge=0.0, le=1.0, allow_inf_nan=False)

    @model_validator(mode="before")
    @classmethod
    def anchors_cannot_be_null(cls, values):
        if isinstance(values, dict):
            for name in ("offset_ms_a", "offset_ms_b"):
                if name in values and values[name] is None:
                    raise ValueError(f"{name} cannot be null")
        return values


class EventMarkerInput(EventMarker):
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @field_validator("created_at", mode="before")
    @classmethod
    def default_creation_time(cls, value):
        return datetime.now(timezone.utc) if value is None else value


class ComparisonUpdate(BaseModel):
    # Explicit null is invalid for stored values; omission means no change.
    # Spatial keeps the existing replacement semantics (identity defaults).
    spatial: AffineTransform | None = None
    opacity_default: float | None = Field(default=None, ge=0.0, le=1.0, allow_inf_nan=False)
    temporal: TemporalAlignmentUpdate | None = None
    phases_a: list[PhaseBoundary] | None = Field(default=None, min_length=1)
    phases_b: list[PhaseBoundary] | None = Field(default=None, min_length=1)
    markers: list[EventMarkerInput] | None = None

    @model_validator(mode="before")
    @classmethod
    def stored_values_cannot_be_null(cls, values):
        if isinstance(values, dict):
            for name in cls.model_fields:
                if name in values and values[name] is None:
                    raise ValueError(f"{name} cannot be null")
        return values

    @field_validator("phases_a", "phases_b")
    @classmethod
    def unique_phases(cls, phases: list[PhaseBoundary] | None):
        if phases is not None and len({phase.phase for phase in phases}) != len(phases):
            raise ValueError("phase names must be unique")
        return phases

    @field_validator("markers")
    @classmethod
    def unique_markers(cls, markers: list[EventMarkerInput] | None):
        if markers is not None and len({marker.marker_id for marker in markers}) != len(markers):
            raise ValueError("marker IDs must be unique")
        return markers


class KeyframeRef(BaseModel):
    url: str
    t_ms_a: int
    t_ms_b: int
    deviation: float  # mean normalized keypoint distance at this frame


class PhaseOffset(BaseModel):
    phase: str
    delta_frames: int  # positive: B's phase starts later than A's
    delta_ms: int


class ReportRef(BaseModel):
    created_at: datetime
    keyframes: list[KeyframeRef]
    phase_offsets: list[PhaseOffset]
    summary_text: str


class ComparisonState(BaseModel):
    comparison_id: str
    player_id: str
    template_id: str
    baseline_clip_id: str
    comparison_clip_id: str
    spatial: AffineTransform  # maps clip B onto clip A
    opacity_default: float = Field(default=0.5, ge=0.0, le=1.0)
    temporal: TemporalAlignment
    phases_a: list[PhaseBoundary]
    phases_b: list[PhaseBoundary]
    markers: list[EventMarker] = []
    camera_check: CameraCheckResult
    report: ReportRef | None = None
    created_at: datetime
