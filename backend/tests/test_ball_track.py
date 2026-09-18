"""Ball-track detection over the lift → release window; no real model required."""

from unittest.mock import Mock

import cv2
import numpy as np
import pytest
import torch

from app.core.config import Settings
from app.pose.ball_detector import (
    SPORTS_BALL_CLASS,
    BallDetector,
    track_window,
)
from app.schemas.pose import BallTrack
from test_biomechanics import phases


class FakeBoxes:
    def __init__(self, cls, conf, xyxy):
        self.cls = torch.tensor(cls, dtype=torch.float32)
        self.conf = torch.tensor(conf, dtype=torch.float32)
        self.xyxy = torch.tensor(xyxy, dtype=torch.float32)

    def __len__(self):
        return self.conf.shape[0]


def fake_detector(detections_in_order):
    """BallDetector with a stub model; one entry per decoded frame (None = no boxes)."""
    detector = object.__new__(BallDetector)
    detector._min_conf = 0.25
    detector._imgsz = 640
    calls = iter(detections_in_order)

    def predict(bgr, **kwargs):
        box = next(calls)
        if box is None:
            return [Mock(boxes=None)]
        return [Mock(boxes=FakeBoxes(*box))]

    detector._model = Mock(predict=predict)
    return detector


def write_clip(path, frames=6, size=(64, 48)):
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 30.0, size)
    for i in range(frames):
        writer.write(np.full((size[1], size[0], 3), i * 30, dtype=np.uint8))
    writer.release()


def test_detect_window_filters_to_sports_ball_and_normalizes(tmp_path):
    clip = tmp_path / "clip.mp4"
    write_clip(clip)
    detector = fake_detector([
        ([SPORTS_BALL_CLASS], [0.9], [[8.0, 6.0, 24.0, 22.0]]),                     # frame 1: hit
        ([0], [0.9], [[8.0, 6.0, 24.0, 22.0]]),                                      # frame 2: wrong class
        ([SPORTS_BALL_CLASS], [0.1], [[8.0, 6.0, 24.0, 22.0]]),                     # frame 3: low conf
        ([SPORTS_BALL_CLASS, 0], [0.4, 0.9], [[32.0, 12.0, 48.0, 28.0], [0.0, 0.0, 4.0, 4.0]]),
    ])
    track = detector.detect_window(clip, 1, 4)
    assert isinstance(track, BallTrack) and track.available
    assert (track.start_frame, track.end_frame) == (1, 4)
    assert len(track.frames) == 4
    hit = track.frames[0]
    assert (hit.frame_idx, round(hit.x, 3), round(hit.y, 3)) == (1, 0.25, 0.292)
    assert hit.confidence == pytest.approx(0.9) and hit.radius is not None
    for missed in track.frames[1:3]:
        assert missed.x is None and missed.y is None and missed.confidence == 0.0
    multi = track.frames[3]
    assert multi.frame_idx == 4 and multi.confidence == pytest.approx(0.4)
    assert round(multi.x, 3) == 0.625 and round(multi.y, 3) == 0.417


def test_track_window_degrades_without_model(tmp_path):
    cfg = Settings(data_dir=tmp_path, ball_model_path=tmp_path / "missing.pt")
    segments = phases()
    track = track_window(cfg, tmp_path / "clip.mp4", segments)
    assert not track.available and "not installed" in track.reason
    assert (track.start_frame, track.end_frame) == (1, 2)  # lift start → release anchor


def test_track_window_survives_detection_errors(tmp_path, monkeypatch):
    cfg = Settings(data_dir=tmp_path)
    monkeypatch.setattr(
        "app.pose.ball_detector.get_ball_detector",
        lambda _: Mock(detect_window=Mock(side_effect=RuntimeError("decode exploded"))),
    )
    track = track_window(cfg, tmp_path / "clip.mp4", phases())
    assert not track.available and "decode exploded" in track.reason
