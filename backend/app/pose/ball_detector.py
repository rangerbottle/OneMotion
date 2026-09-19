"""Basketball detection over the lift → release window.

Uses a COCO-pretrained Ultralytics detection model (`models/yolo11n.pt`,
gitignored); the pose model cannot see the ball. Only frames inside the
phase-derived window are decoded and inferred to stay within the CPU budget.

Missed detections stay None — never interpolated — so the overlay reflects
actual evidence (docs/ARCHITECTURE.md confidence gating).
"""

from functools import lru_cache
from pathlib import Path
import time

import numpy as np

from app.core.config import Settings
from app.schemas.pose import BallDetection, BallTrack

SPORTS_BALL_CLASS = 32


class BallDetector:
    def __init__(self, weights_path: Path, min_conf: float = 0.25, imgsz: int = 640) -> None:
        from ultralytics import YOLO

        self._model = YOLO(str(weights_path))
        self._min_conf = min_conf
        self._imgsz = imgsz

    def detect_window(
        self, video_path: Path, start_frame: int, end_frame: int, timeout_s: float = 120
    ) -> BallTrack:
        import cv2

        from app.core.video import check_decode_budget

        cap = cv2.VideoCapture(str(video_path))
        frames: list[BallDetection] = []
        started = time.monotonic()
        try:
            if not cap.isOpened():
                raise ValueError(f"cannot decode video: {video_path}")
            fps = cap.get(cv2.CAP_PROP_FPS)
            if not np.isfinite(fps) or fps <= 0:
                fps = 30.0  # clips with broken metadata fall back to nominal timing
            idx = self._seek(cap, start_frame)
            while idx <= end_frame:
                ok, bgr = cap.read()
                if not ok:
                    break
                timestamp = cap.get(cv2.CAP_PROP_POS_MSEC)
                if not np.isfinite(timestamp) or timestamp < 0:
                    timestamp = idx * 1000.0 / fps
                t_ms = int(timestamp)
                check_decode_budget(idx, t_ms, started, timeout_s)
                frames.append(self._detect_bgr(bgr, idx, t_ms))
                idx += 1
        finally:
            cap.release()
        if not frames:
            return BallTrack(
                available=False,
                reason="no decodable frames in the lift→release window",
                start_frame=start_frame,
                end_frame=end_frame,
            )
        return BallTrack(
            available=True,
            start_frame=start_frame,
            end_frame=end_frame,
            frames=frames,
        )

    @staticmethod
    def _seek(cap, start_frame: int) -> int:
        """Position the capture at start_frame; return the real frame index.

        POS_FRAMES seeks are codec-dependent, so verify the landing spot and
        fall back to a sequential walk — otherwise every detection would be
        mislabeled by the seek offset.
        """
        import cv2

        if start_frame <= 0:
            return 0
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
        landed = int(cap.get(cv2.CAP_PROP_POS_FRAMES))
        if landed == start_frame:
            return landed
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        idx = 0
        while idx < start_frame:
            ok, _ = cap.read()
            if not ok:
                break
            idx += 1
        return idx

    def _detect_bgr(self, bgr: np.ndarray, frame_idx: int, t_ms: int) -> BallDetection:
        h, w = bgr.shape[:2]
        results = self._model.predict(
            bgr, imgsz=self._imgsz, verbose=False, device="cpu"
        )
        boxes = results[0].boxes
        if boxes is None or len(boxes) == 0:
            return self._missed(frame_idx, t_ms)
        cls = boxes.cls.cpu().numpy()
        conf = boxes.conf.cpu().numpy()
        mask = (cls == SPORTS_BALL_CLASS) & (conf >= self._min_conf)
        if not mask.any():
            return self._missed(frame_idx, t_ms)
        xyxy = boxes.xyxy.cpu().numpy()[mask]
        conf = conf[mask]
        best = int(np.argmax(conf))
        x1, y1, x2, y2 = xyxy[best]
        cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
        radius = (x2 - x1 + y2 - y1) / 4.0 / w
        return BallDetection(
            frame_idx=frame_idx,
            t_ms=t_ms,
            x=float(np.clip(cx / w, 0.0, 1.0)),
            y=float(np.clip(cy / h, 0.0, 1.0)),
            confidence=float(conf[best]),
            radius=float(radius),
        )

    @staticmethod
    def _missed(frame_idx: int, t_ms: int) -> BallDetection:
        return BallDetection(
            frame_idx=frame_idx, t_ms=t_ms, x=None, y=None, confidence=0.0, radius=None
        )


@lru_cache
def _build_detector(weights_path: str, min_conf: float) -> BallDetector | None:
    path = Path(weights_path)
    if not path.is_file():
        return None
    return BallDetector(path, min_conf)


def get_ball_detector(cfg: Settings) -> BallDetector | None:
    """None when the ball model is not installed; analysis degrades gracefully."""
    return _build_detector(str(cfg.ball_model_path), cfg.ball_min_conf)


def unavailable_track(start_frame: int, end_frame: int, reason: str) -> BallTrack:
    return BallTrack(
        available=False,
        reason=reason,
        start_frame=start_frame,
        end_frame=end_frame,
    )


def track_window(cfg: Settings, video_path: Path, phases) -> BallTrack:
    """Ball track over the lift → release window; never raises into analysis."""
    try:
        lift = next(phase for phase in phases if phase.phase == "lift")
        release = next(phase for phase in phases if phase.phase == "release")
    except StopIteration:
        return unavailable_track(0, 0, "phase segmentation lacks lift/release")
    start_frame, end_frame = lift.start_frame, release.anchor_frame
    detector = get_ball_detector(cfg)
    if detector is None:
        return unavailable_track(
            start_frame, end_frame, "ball model not installed (models/yolo11n.pt)"
        )
    try:
        return detector.detect_window(
            video_path, start_frame, end_frame, timeout_s=cfg.analysis_timeout_s
        )
    except Exception as exc:  # detection must not fail the analysis
        return unavailable_track(start_frame, end_frame, f"ball detection failed: {exc}")
