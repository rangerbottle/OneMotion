"""MediaPipe BlazePose backend — browser parity / future dev backend.

NOTE: mediapipe 1.x crashes on this project's macOS dev host
(DrishtiMetalHelper "Service is unavailable" — the pose graph initializes
Metal even with a CPU delegate), so the Python package is not a dependency
and the working dev backend is `app.pose.yolo_backend.YoloPoseBackend`.
This module is kept for parity with the in-browser MediaPipe preview and
imports mediapipe lazily.

Uses the MediaPipe Tasks `PoseLandmarker` (BlazePose-33) and maps landmarks
down to the canonical COCO-17 schema via `app.schemas.pose.BLAZEPOSE_TO_COCO17`
(docs/ARCHITECTURE.md §3). Model file (not committed):
    curl -L -o models/pose_landmarker_full.task \
      https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task
"""

from pathlib import Path

from app.core.config import REPO_ROOT
from app.schemas.pose import (
    BLAZEPOSE_TO_COCO17,
    Keypoint,
    PoseFrame,
    ShotSequence,
    empty_keypoints,
)

DEFAULT_MODEL = REPO_ROOT / "models" / "pose_landmarker_full.task"

# Landmarks below this visibility are reported but flagged low-confidence;
# analysis code interpolates over them (docs/ARCHITECTURE.md §3).
MIN_VISIBILITY = 0.5


class MediaPipePoseBackend:
    name = "mediapipe"

    def __init__(self, model_path: Path = DEFAULT_MODEL) -> None:
        if not model_path.exists():
            raise FileNotFoundError(
                f"pose landmarker model missing: {model_path} (see module docstring)"
            )
        from mediapipe.tasks.python import BaseOptions, vision

        self._vision = vision
        options = vision.PoseLandmarkerOptions(
            base_options=BaseOptions(
                model_asset_path=str(model_path),
                delegate=BaseOptions.Delegate.CPU,
            ),
            running_mode=vision.RunningMode.VIDEO,
            num_poses=1,
            min_pose_detection_confidence=0.5,
            min_pose_presence_confidence=0.5,
            min_tracking_confidence=0.5,
        )
        self._landmarker = vision.PoseLandmarker.create_from_options(options)

    def estimate_video(self, video_path: Path) -> ShotSequence:
        import cv2
        import mediapipe as mp

        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise ValueError(f"cannot open video: {video_path}")
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        frames: list[PoseFrame] = []
        idx = 0
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            t_ms = int(cap.get(cv2.CAP_PROP_POS_MSEC))
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = self._landmarker.detect_for_video(image, t_ms)
            keypoints = self._to_coco17(result)
            frames.append(
                PoseFrame(
                    frame_idx=idx,
                    t_ms=t_ms,
                    keypoints=keypoints or empty_keypoints(),
                )
            )
            idx += 1
        cap.release()

        if not frames:
            raise ValueError(f"no person detected in any frame: {video_path}")
        return ShotSequence(
            clip_id=video_path.stem, fps=fps, width=width, height=height, frames=frames
        )

    def estimate_frame(self, image_bytes: bytes) -> PoseFrame:
        import cv2
        import mediapipe as mp
        import numpy as np

        buf = np.frombuffer(image_bytes, dtype=np.uint8)
        bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        if bgr is None:
            raise ValueError("cannot decode image")
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = self._landmarker.detect_for_video(image, 0)
        keypoints = self._to_coco17(result)
        if not keypoints:
            raise ValueError("no person detected in frame")
        return PoseFrame(frame_idx=0, t_ms=0, keypoints=keypoints)

    @staticmethod
    def _to_coco17(result) -> list[Keypoint]:
        """Adapt BlazePose-33 landmarks to the canonical COCO-17 schema."""
        if not result.pose_landmarks:
            return []
        landmarks = result.pose_landmarks[0]
        keypoints = []
        for mp_idx, name in BLAZEPOSE_TO_COCO17.items():
            lm = landmarks[mp_idx]
            visibility = getattr(lm, "visibility", 1.0) or 0.0
            keypoints.append(
                Keypoint(
                    name=name,
                    x=min(max(lm.x, 0.0), 1.0),
                    y=min(max(lm.y, 0.0), 1.0),
                    confidence=visibility if visibility >= MIN_VISIBILITY else 0.0,
                )
            )
        return keypoints
