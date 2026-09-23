"""Frame-by-frame comparison domain (players / action templates / clips).

V1 constraints, by design: two clips only, same camera position, global
time offset only (no time warping). Phase boundaries are user-adjustable
frame ranges initialised from the action template — not auto-segmented.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


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
    tx: float = 0.0
    ty: float = 0.0
    scale: float = 1.0
    rotation_deg: float = 0.0


class ClipMeta(BaseModel):
    clip_id: str
    player_id: str
    template_id: str
    kind: Literal["baseline", "comparison"]
    filename: str
    fps: float = Field(gt=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    frame_count: int = Field(ge=0)
    duration_ms: int = Field(ge=0)
    camera: CameraCheckResult | None = None  # set when used as comparison side B
    created_at: datetime


class PhaseBoundary(BaseModel):
    phase: str
    start_frame: int = Field(ge=0)
    end_frame: int = Field(ge=0)


class EventMarker(BaseModel):
    marker_id: str
    side: Literal["a", "b", "both"] = "both"
    frame: int = Field(ge=0)  # frame in clip A's timeline; B maps through the offset
    t_ms: int = Field(ge=0)
    text: str = ""
    created_at: datetime


class TemporalAlignment(BaseModel):
    # "Action start" anchor picked per clip; playback maps t_b - offset_b + offset_a.
    offset_ms_a: int = Field(default=0, ge=0)
    offset_ms_b: int = Field(default=0, ge=0)
    suggested_offset_ms_b: int | None = None  # cross-correlation proposal
    suggestion_confidence: float | None = Field(default=None, ge=0.0, le=1.0)


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
