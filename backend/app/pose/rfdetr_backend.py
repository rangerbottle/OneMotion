"""RF-DETR keypoint backend via Roboflow `inference` — accuracy path.

Implementation lands in M2 (docs/ARCHITECTURE.md §11). Requires
ONMOTION_POSE_BACKEND=rfdetr and ONMOTION_RF_API_KEY. Output is adapted to
the canonical COCO-17 schema before leaving this module.
"""

from pathlib import Path

from app.schemas.pose import PoseFrame, ShotSequence


class RfDetrPoseBackend:
    name = "rfdetr"

    def __init__(self, api_key: str | None) -> None:
        self._api_key = api_key

    def estimate_video(self, video_path: Path) -> ShotSequence:
        raise NotImplementedError("RF-DETR backend lands in milestone M2")

    def estimate_frame(self, image_bytes: bytes) -> PoseFrame:
        raise NotImplementedError("RF-DETR backend lands in milestone M2")
