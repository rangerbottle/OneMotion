"""Canonical pose interchange schema shared by all backends and analysis code."""

from pydantic import BaseModel, Field, model_validator

# Canonical keypoint schema (docs/ARCHITECTURE.md §3). All backends adapt to this.
COCO17_KEYPOINTS: list[str] = [
    "nose",
    "left_eye",
    "right_eye",
    "left_ear",
    "right_ear",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
]

# BlazePose-33 -> COCO-17 name mapping (used by MediaPipe backends).
BLAZEPOSE_TO_COCO17: dict[int, str] = {
    0: "nose",
    2: "left_eye",
    5: "right_eye",
    7: "left_ear",
    8: "right_ear",
    11: "left_shoulder",
    12: "right_shoulder",
    13: "left_elbow",
    14: "right_elbow",
    15: "left_wrist",
    16: "right_wrist",
    23: "left_hip",
    24: "right_hip",
    25: "left_knee",
    26: "right_knee",
    27: "left_ankle",
    28: "right_ankle",
}


class Keypoint(BaseModel):
    name: str  # one of COCO17_KEYPOINTS
    x: float = Field(ge=0.0, le=1.0)  # normalized image space [0, 1]
    y: float = Field(ge=0.0, le=1.0)  # normalized image space [0, 1]
    confidence: float = Field(ge=0.0, le=1.0)


class PoseFrame(BaseModel):
    frame_idx: int
    t_ms: int
    keypoints: list[Keypoint]


class BallDetection(BaseModel):
    """Ball position for one video frame; x/y stay None when not detected."""

    frame_idx: int
    t_ms: int
    x: float | None = Field(default=None, ge=0.0, le=1.0)
    y: float | None = Field(default=None, ge=0.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)
    # Bounding-box radius normalized by frame width, for overlay rendering.
    radius: float | None = Field(default=None, ge=0.0)


class BallTrack(BaseModel):
    """Per-frame ball positions over the lift → release window."""

    available: bool
    reason: str | None = None
    start_frame: int
    end_frame: int
    frames: list[BallDetection] = []


class ShotSequence(BaseModel):
    clip_id: str
    fps: float = Field(gt=0)
    # Frame size in pixels; needed to denormalize keypoints before any
    # angle math (x and y are normalized independently).
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    frames: list[PoseFrame]
    ball_track: BallTrack | None = None

    @model_validator(mode="after")
    def validate_timeline(self) -> "ShotSequence":
        timestamps = [frame.t_ms for frame in self.frames]
        if timestamps != sorted(timestamps):
            raise ValueError("pose frame timestamps must be monotonic")
        return self


def empty_keypoints() -> list[Keypoint]:
    """A complete schema-shaped frame for a missed person detection."""
    return [
        Keypoint(name=name, x=0.0, y=0.0, confidence=0.0) for name in COCO17_KEYPOINTS
    ]
