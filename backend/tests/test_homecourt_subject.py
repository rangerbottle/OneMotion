"""Shooter selection and source-clock gating without model weights."""

from types import SimpleNamespace

import numpy as np
import pytest

from app.analysis.biomechanics import compute_frame_biomechanics
from app.pose.yolo_backend import YoloPoseBackend
from app.schemas.media_source import SubjectROI
from test_biomechanics import phases, sequence


class Tensor:
    def __init__(self, values):
        self.values = np.asarray(values)
        self.shape = self.values.shape

    def cpu(self):
        return self

    def numpy(self):
        return self.values

    def __getitem__(self, index):
        return Tensor(self.values[index])


def backend():
    subject = np.tile([20, 50], (17, 1))
    rebounder = np.tile([75, 50], (17, 1))
    detection = SimpleNamespace(
        boxes=SimpleNamespace(xywh=Tensor([[20, 50, 15, 40], [75, 50, 40, 90]])),
        keypoints=SimpleNamespace(xy=Tensor([subject, rebounder]), conf=Tensor(np.ones((2, 17)))),
    )
    instance = YoloPoseBackend.__new__(YoloPoseBackend)
    instance._imgsz = 640
    instance._model = SimpleNamespace(predict=lambda *args, **kwargs: [detection])
    return instance


def test_roi_selects_shooter_instead_of_larger_rebounder_and_keeps_canvas_coordinates():
    instance = backend()
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    default, _ = instance._estimate_bgr(frame)
    assert default[0].x == pytest.approx(.75)
    roi = SubjectROI(x=.1, y=.1, width=.3, height=.8)
    selected, center = instance._estimate_bgr(frame, subject_roi=roi)
    assert selected[0].x == pytest.approx(.2)
    assert selected[0].y == pytest.approx(.5)
    assert center.tolist() == [20, 50]
    # Even a previous identity outside the ROI cannot override selection.
    tracked, _ = instance._estimate_bgr(frame, np.array([75, 50]), roi)
    assert tracked[0].x == pytest.approx(.2)


def test_empty_roi_never_falls_back_to_someone_else():
    points, center = backend()._estimate_bgr(
        np.zeros((100, 100, 3), dtype=np.uint8),
        subject_roi=SubjectROI(x=0., y=0., width=.1, height=.1),
    )
    assert points == [] and center is None


def test_unknown_source_clock_removes_velocity_without_hiding_measurable_angles():
    frames = compute_frame_biomechanics(sequence(), phases(), timing_reliable=False)
    assert frames[0].elbow_flexion_deg.value == pytest.approx(180)
    assert frames[0].elbow_flexion_deg.reliable
    assert all(frame.wrist_vertical_velocity_height_s.value is None for frame in frames)
    assert all(not frame.wrist_vertical_velocity_height_s.reliable for frame in frames)
    assert all("playback speed" in frame.wrist_vertical_velocity_height_s.unavailable_reason for frame in frames)
