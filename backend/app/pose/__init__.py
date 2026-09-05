"""Pose estimation backends behind one cached interface."""

from functools import lru_cache
from pathlib import Path

from app.pose.base import PoseBackend


@lru_cache(maxsize=4)
def _build_backend(name: str, model_path: str, rf_api_key: str | None) -> PoseBackend:
    if name == "mediapipe":
        from app.pose.mediapipe_backend import MediaPipePoseBackend

        return MediaPipePoseBackend()

    if name == "yolo":
        from app.pose.yolo_backend import YoloPoseBackend

        return YoloPoseBackend(weights_path=Path(model_path))

    from app.pose.rfdetr_backend import RfDetrPoseBackend

    return RfDetrPoseBackend(rf_api_key)


def get_backend(cfg=None) -> PoseBackend:
    """Resolve and cache the configured backend so weights load once."""
    if cfg is None:
        from app.core.config import settings

        cfg = settings
    return _build_backend(cfg.pose_backend, str(cfg.model_path), cfg.rf_api_key)
