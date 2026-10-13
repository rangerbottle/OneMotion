"""Pluggable pose-estimation backend interface (docs/ARCHITECTURE.md §2-3)."""

from pathlib import Path
from typing import Protocol

from app.schemas.pose import PoseFrame, ShotSequence
from app.schemas.media_source import SubjectROI


class PoseBackend(Protocol):
    """A pose backend adapts a specific model to the canonical COCO-17 schema."""

    name: str

    def estimate_video(self, video_path: Path, *, subject_roi: SubjectROI | None = None) -> ShotSequence:
        """Extract a full pose sequence from a video clip."""
        ...

    def estimate_frame(self, image_bytes: bytes) -> PoseFrame:
        """Extract the pose from a single image frame."""
        ...
