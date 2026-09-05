"""Time-series helpers over ShotSequence: interpolation + smoothing.

Low-confidence keypoints (confidence == 0) are linearly interpolated from
valid neighbors (docs/ARCHITECTURE.md §3); coordinates are then smoothed
with a centered moving average to make velocity signals usable.
"""

import numpy as np

from app.schemas.pose import ShotSequence

CONF_MIN = 0.5


def keypoint_xy(seq: ShotSequence, frame_idx_in_seq: int, name: str) -> np.ndarray:
    """Pixel-space (x, y) of one keypoint in one frame."""
    kp = next(k for k in seq.frames[frame_idx_in_seq].keypoints if k.name == name)
    return np.array([kp.x * seq.width, kp.y * seq.height])


def series(seq: ShotSequence, name: str, smooth_window: int = 5) -> np.ndarray:
    """Smoothed pixel-space trajectory of one keypoint, shape (n_frames, 2)."""
    points = [
        next((k for k in frame.keypoints if k.name == name), None)
        for frame in seq.frames
    ]
    xy = np.array(
        [
            [point.x * seq.width, point.y * seq.height] if point else [0.0, 0.0]
            for point in points
        ],
        dtype=float,
    )
    conf = np.array([point.confidence if point else 0.0 for point in points])

    valid = conf >= CONF_MIN
    if valid.sum() < 2:
        return xy  # nothing to interpolate from; caller should mark degraded
    idx = np.arange(len(xy))
    for dim in (0, 1):
        xy[~valid, dim] = np.interp(idx[~valid], idx[valid], xy[valid, dim])

    if smooth_window > 1 and len(xy) >= smooth_window:
        kernel = np.ones(smooth_window) / smooth_window
        padded = np.pad(
            xy, ((smooth_window // 2, smooth_window // 2), (0, 0)), mode="edge"
        )
        xy = np.stack(
            [np.convolve(padded[:, dim], kernel, mode="valid") for dim in (0, 1)],
            axis=1,
        )
    return xy


def midpoint(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return (a + b) / 2.0


def angle_abc(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    """Angle at joint b (degrees), pixel-space points a-b-c."""
    ba, bc = a - b, c - b
    cos = np.dot(ba, bc) / (np.linalg.norm(ba) * np.linalg.norm(bc) + 1e-9)
    return float(np.degrees(np.arccos(np.clip(cos, -1.0, 1.0))))
