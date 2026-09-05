"""Pluggable pose-estimation backend interface (docs/ARCHITECTURE.md §2-3)."""

from pathlib import Path
from typing import Protocol

from app.schemas.pose import PoseFrame, ShotSequence


class PoseBackend(Protocol):
    """A pose backend adapts a specific model to the canonical COCO-17 schema."""

    name: str

    def estimate_video(self, video_path: Path) -> ShotSequence:
        """Extract a full pose sequence from a video clip."""
        ...

    def estimate_frame(self, image_bytes: bytes) -> PoseFrame:
        """Extract the pose from a single image frame."""
        ...
