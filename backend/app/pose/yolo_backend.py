"""Ultralytics YOLO-pose backend — working dev backend, pure CPU.

Outputs COCO-17 keypoints natively, so no schema mapping is needed
(docs/ARCHITECTURE.md §3). Weights auto-download on first use to
`models/yolo11n-pose.pt` (gitignored).

Multi-person frames: the largest bounding box is taken as the shooter.
"""

from pathlib import Path
import time

from app.core.video import check_decode_budget, validate_metadata

import cv2
import numpy as np

from app.core.config import REPO_ROOT
from app.schemas.pose import (
    COCO17_KEYPOINTS,
    Keypoint,
    PoseFrame,
    ShotSequence,
    empty_keypoints,
)

DEFAULT_WEIGHTS = REPO_ROOT / "models" / "yolo11n-pose.pt"


class YoloPoseBackend:
    name = "yolo"

    def __init__(self, weights_path: Path = DEFAULT_WEIGHTS, imgsz: int = 640, timeout_s: float = 120) -> None:
        from ultralytics import YOLO

        self._model = YOLO(str(weights_path))  # auto-downloads if missing
        self._imgsz = imgsz
        self._timeout_s = timeout_s

    def estimate_video(self, video_path: Path) -> ShotSequence:
        cap = cv2.VideoCapture(str(video_path))
        frames: list[PoseFrame] = []
        started = time.monotonic()
        try:
            fps, width, height = validate_metadata(cap)
            idx = 0
            previous_center: np.ndarray | None = None
            while True:
                ok, bgr = cap.read()
                if not ok:
                    break
                timestamp = cap.get(cv2.CAP_PROP_POS_MSEC)
                if not np.isfinite(timestamp) or timestamp < 0:
                    raise ValueError("invalid video timestamp")
                t_ms = int(timestamp)
                if frames and t_ms <= frames[-1].t_ms:
                    raise ValueError("video timestamps must strictly increase")
                check_decode_budget(idx, t_ms, started, self._timeout_s)
                keypoints, detected_center = self._estimate_bgr(bgr, previous_center)
                check_decode_budget(idx, t_ms, started, self._timeout_s)
                if detected_center is not None:
                    previous_center = detected_center
                frames.append(PoseFrame(frame_idx=idx, t_ms=t_ms, keypoints=keypoints or empty_keypoints()))
                idx += 1
        finally:
            cap.release()

        if not frames:
            raise ValueError(f"no person detected in any frame: {video_path}")
        return ShotSequence(
            clip_id=video_path.stem, fps=fps, width=width, height=height, frames=frames
        )

    def estimate_frame(self, image_bytes: bytes) -> PoseFrame:
        buf = np.frombuffer(image_bytes, dtype=np.uint8)
        bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        if bgr is None:
            raise ValueError("cannot decode image")
        keypoints, _ = self._estimate_bgr(bgr)
        if not keypoints:
            raise ValueError("no person detected in frame")
        return PoseFrame(frame_idx=0, t_ms=0, keypoints=keypoints)

    def _estimate_bgr(
        self,
        bgr: np.ndarray,
        previous_center: np.ndarray | None = None,
    ) -> tuple[list[Keypoint], np.ndarray | None]:
        h, w = bgr.shape[:2]
        results = self._model.predict(
            bgr, imgsz=self._imgsz, verbose=False, device="cpu"
        )
        result = results[0]
        if result.keypoints is None or result.keypoints.xy.shape[0] == 0:
            return [], None

        boxes = result.boxes.xywh.cpu().numpy()
        areas = boxes[:, 2] * boxes[:, 3]
        centers = boxes[:, :2]
        if previous_center is None:
            best = int(np.argmax(areas))
        else:
            distances = np.linalg.norm(centers - previous_center, axis=1)
            normalized = distances / max(float(np.hypot(w, h)), 1.0)
            close = np.where(normalized <= 0.25)[0]
            best = (
                int(close[np.argmin(normalized[close])])
                if len(close)
                else int(np.argmax(areas))
            )
        xy = result.keypoints.xy[best].cpu().numpy()  # (17, 2) pixels
        conf = (
            result.keypoints.conf[best].cpu().numpy()
            if result.keypoints.conf is not None
            else np.ones(17)
        )

        keypoints = [
            Keypoint(
                name=name,
                x=float(np.clip(xy[i, 0] / w, 0.0, 1.0)),
                y=float(np.clip(xy[i, 1] / h, 0.0, 1.0)),
                confidence=float(conf[i]),
            )
            for i, name in enumerate(COCO17_KEYPOINTS)
        ]
        return keypoints, centers[best]
