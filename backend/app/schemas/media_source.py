"""User-declared provenance for a single shot selected from an exported video.

Playback timing here is a declaration, not independent verification of speed.
The ROI identifies the shooter in the original full frame; it is not a crop.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

TimingMode = Literal["unknown", "realtime", "slow_motion"]


class SubjectROI(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=0, le=1, strict=True, allow_inf_nan=False)
    y: float = Field(ge=0, le=1, strict=True, allow_inf_nan=False)
    width: float = Field(gt=0, le=1, strict=True, allow_inf_nan=False)
    height: float = Field(gt=0, le=1, strict=True, allow_inf_nan=False)

    @model_validator(mode="after")
    def fits_frame(self) -> "SubjectROI":
        if self.x + self.width > 1 + 1e-9 or self.y + self.height > 1 + 1e-9:
            raise ValueError("subject ROI must fit within the full video frame")
        return self


class ClipImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Literal["homecourt"] = "homecourt"
    start_ms: int = Field(ge=0, le=600_000, strict=True)
    end_ms: int = Field(gt=0, le=600_000, strict=True)
    recorded_at: datetime | None = None
    camera_label: str | None = Field(default=None, min_length=1, max_length=120)
    timing_mode: TimingMode = "unknown"
    subject_roi: SubjectROI | None = None

    @model_validator(mode="after")
    def single_shot_window(self) -> "ClipImportRequest":
        if not 0 < self.end_ms - self.start_ms <= 12_000:
            raise ValueError("select a positive shot window of at most 12 seconds")
        if self.camera_label is not None:
            self.camera_label = self.camera_label.strip()
            if not self.camera_label:
                raise ValueError("camera label must not be blank")
        return self


class MediaSource(ClipImportRequest):
    original_filename: str
    original_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    selected_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    # Present when selection was expanded to original decoded frame boundaries.
    # start/end above always describe the actual source timeline in the output.
    requested_start_ms: int | None = Field(default=None, ge=0, le=600_000, strict=True)
    requested_end_ms: int | None = Field(default=None, gt=0, le=600_000, strict=True)


def parse_import_request(source: str | None) -> ClipImportRequest | None:
    """None retains normal upload; an explicitly invalid JSON source is rejected."""
    if source is None:
        return None
    try:
        return ClipImportRequest.model_validate_json(source)
    except ValidationError as exc:
        detail = "; ".join(
            f"{'.'.join(str(part) for part in error['loc']) or 'source'}: {error['msg']}"
            for error in exc.errors()
        )
        raise ValueError(detail) from exc
