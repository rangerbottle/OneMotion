"""Limits shared by upload validation and the supported YOLO decoder."""

import math
import time
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
from threading import BoundedSemaphore

MAX_CLIP_DURATION_MS = 12_000
MAX_FRAMES = 1440
MAX_PIXELS = 3840 * 2160
MAX_FPS = 120


class AnalysisBusy(Exception):
    pass


@lru_cache(maxsize=4)
def _slots(count: int) -> BoundedSemaphore:
    return BoundedSemaphore(count)


@contextmanager
def inference_slot(count: int):
    slot = _slots(count)
    if not slot.acquire(blocking=False):
        raise AnalysisBusy("Analysis service is busy. Try again shortly.")
    try:
        yield
    finally:
        slot.release()


def validate_metadata(cap) -> tuple[float, int, int]:
    import cv2

    if not cap.isOpened():
        raise ValueError("cannot decode video — use a supported mp4/mov/webm clip")
    fps = cap.get(cv2.CAP_PROP_FPS)
    width, height = cap.get(cv2.CAP_PROP_FRAME_WIDTH), cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    if not all(math.isfinite(v) and v > 0 for v in (fps, width, height)):
        raise ValueError("video has invalid timing or dimensions")
    if width * height > MAX_PIXELS or fps > MAX_FPS:
        raise ValueError("video exceeds 4K pixel budget or 120 fps")
    count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    # Streaming WebM may not declare frame count. The decode loop still enforces limits.
    if math.isfinite(count) and count > 0:
        if count > MAX_FRAMES or count / fps * 1000 > MAX_CLIP_DURATION_MS + 1:
            raise ValueError("clip exceeds 12 seconds — upload one shot only")
    return fps, int(width), int(height)


def validate_video(path: Path) -> None:
    import cv2

    cap = cv2.VideoCapture(str(path))
    try:
        validate_metadata(cap)
    finally:
        cap.release()


def check_decode_budget(index: int, timestamp_ms: float, started: float, timeout_s: float) -> None:
    if index >= MAX_FRAMES or timestamp_ms >= MAX_CLIP_DURATION_MS:
        raise ValueError("clip exceeds the duration or decoded-frame limit")
    if time.monotonic() - started > timeout_s:
        raise ValueError("analysis time budget exceeded — use a shorter clip")
