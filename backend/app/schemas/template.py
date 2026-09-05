"""Public template registry and replay payloads."""

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.analysis import PhaseSegment
from app.schemas.pose import ShotSequence


class TemplateSummary(BaseModel):
    template_id: str
    display_name: str
    description: str
    timing_mode: Literal["realtime", "slow_motion", "unknown"]
    timing_reliable: bool
    time_scale_to_realtime: float | None = None
    template_kind: Literal["aggregate", "single_reference"]
    sample_count: int
    source_url: str | None = None
    clip_start_ms: int | None = None
    clip_end_ms: int | None = None
    video_url: str | None = None
    is_default: bool = False


class DerivedValue(BaseModel):
    value: float | None
    confidence: float = Field(ge=0.0, le=1.0)
    reliable: bool
    interpolated: bool = False
    unavailable_reason: str | None = None


class BiomechanicsFrame(BaseModel):
    frame_idx: int
    t_ms: int
    phase: str | None
    shooting_side: Literal["left", "right"]
    is_release_frame: bool = False
    elbow_flexion_deg: DerivedValue
    left_knee_flexion_deg: DerivedValue
    right_knee_flexion_deg: DerivedValue
    forearm_elevation_deg: DerivedValue
    release_angle_proxy_deg: DerivedValue
    trunk_lean_deg: DerivedValue
    wrist_vertical_velocity_height_s: DerivedValue


class ReplayWindow(BaseModel):
    start_ms: int
    end_ms: int
    duration_ms: int
    fps: float
    dip_anchor_ms: int
    release_anchor_ms: int


class SyncAnchor(BaseModel):
    name: Literal["dip", "release"]
    player_ms: int
    template_ms: int
    confidence: float = Field(ge=0.0, le=1.0)


class ReplaySync(BaseModel):
    available_modes: list[Literal["independent", "realtime_locked"]]
    default_mode: Literal["independent", "realtime_locked"] = "realtime_locked"
    default_anchor: Literal["dip", "release"] = "release"
    anchors: list[SyncAnchor]
    unavailable_reason: str | None = None


class ReplayPayload(BaseModel):
    analysis_id: str
    template_id: str
    timing_mode: Literal["realtime", "slow_motion", "unknown"]
    timing_reliable: bool
    player_sequence: ShotSequence
    player_phases: list[PhaseSegment]
    template_sequence: ShotSequence
    template_phases: list[PhaseSegment]
    player_video_url: str | None = None
    template_video_url: str | None = None
    player_window: ReplayWindow
    template_window: ReplayWindow
    sync: ReplaySync
    biomechanics_version: str = "biomechanics_v1"
    player_biomechanics: list[BiomechanicsFrame]
    template_biomechanics: list[BiomechanicsFrame]
