"""Compare-domain algorithm tests: camera check / affine fit / temporal offset."""

import cv2
import numpy as np
import pytest

from app.compare.alignment import (
    PairStats,
    check_camera,
    fit_affine,
    homography_to_affine,
    person_mask,
    sample_frame_indices,
)
from app.compare.signals import pose_signal, suggest_offset_ms
from app.core.config import Settings
from app.schemas.pose import Keypoint, PoseFrame, ShotSequence
from test_biomechanics import sequence


def textured_frame(rng, w=320, h=240):
    """Random textured background with a dark 'person' rectangle."""
    base = (rng.random((h, w, 3)) * 255).astype(np.uint8)
    base = cv2.GaussianBlur(base, (5, 5), 0)
    cv2.rectangle(base, (60, 40), (120, 160), (20, 20, 20), -1)
    return base


def shifted(frame, dx, dy):
    return np.roll(np.roll(frame, dy, axis=0), dx, axis=1)


def test_camera_check_match_and_affine_recovery(tmp_path):
    cfg = Settings(data_dir=tmp_path)
    rng = np.random.default_rng(7)
    # B is A shifted 8px right / 4px down — same camera nudged. The stored
    # affine maps B back onto A, so its translation is the inverse shift.
    a = textured_frame(rng)
    b = shifted(a, 8, 4)
    pairs = [_match(a, b), _match(a, b)]
    result = check_camera(pairs, cfg)
    assert result.status == "match"
    assert result.inlier_ratio >= 0.5
    affine = fit_affine(pairs, a.shape[1], a.shape[0])
    assert affine is not None
    assert abs(affine.tx - (-8)) <= 2 and abs(affine.ty - (-4)) <= 2


def test_camera_check_mismatch_on_different_backgrounds(tmp_path):
    cfg = Settings(data_dir=tmp_path)
    rng = np.random.default_rng(3)
    a = textured_frame(rng)
    b = (rng.random((240, 320, 3)) * 255).astype(np.uint8)
    pairs = [_match(a, b), _match(a, b)]
    result = check_camera(pairs, cfg)
    assert result.status == "mismatch"
    assert result.inlier_ratio < cfg.compare_camera_suspect_ratio


def test_camera_check_too_few_matches_is_mismatch(tmp_path):
    cfg = Settings(data_dir=tmp_path)
    result = check_camera([PairStats(0, 5, None)], cfg)
    assert result.status == "mismatch" and result.matches == 5


def _match(frame_a, frame_b):
    from app.compare.alignment import _match_pair

    mask = np.ones(frame_a.shape[:2], bool)
    return _match_pair(frame_a, frame_b, mask, mask)


def test_homography_to_affine_pure_translation():
    h = np.array([[1.0, 0.0, 12.0], [0.0, 1.0, -7.0], [0.0, 0.0, 1.0]])
    affine = homography_to_affine(h, 640, 480)
    assert affine.tx == pytest.approx(12.0)
    assert affine.ty == pytest.approx(-7.0)
    assert affine.scale == pytest.approx(1.0)
    assert abs(affine.rotation_deg) < 1e-6


def test_homography_to_affine_fits_across_frame_not_corner():
    # Mild projective warp: a corner-only fit would drift badly mid-frame.
    h = np.array([[1.0, 0.01, 30.0], [-0.008, 1.0, -20.0], [2e-5, -1.5e-5, 1.0]])
    affine = homography_to_affine(h, 1920, 1080)
    import cv2

    grid = np.array([[960.0, 540.0], [480.0, 270.0], [1440.0, 810.0]], dtype=np.float32)
    expected = cv2.perspectiveTransform(grid.reshape(1, -1, 2), h).reshape(-1, 2)
    rad = np.radians(affine.rotation_deg)
    rot = np.array([[np.cos(rad), -np.sin(rad)], [np.sin(rad), np.cos(rad)]])
    for src, want in zip(grid, expected):
        got = affine.scale * (rot @ src) + np.array([affine.tx, affine.ty])
        assert np.allclose(got, want, atol=15.0)


def test_person_mask_blanks_person_area():
    frame = np.zeros((100, 100, 3), np.uint8)
    keypoints = [
        Keypoint(name="nose", x=0.4, y=0.3, confidence=0.9),
        Keypoint(name="right_ankle", x=0.6, y=0.9, confidence=0.9),
    ]
    mask = person_mask(frame.shape[:2], keypoints)
    assert not mask[60, 50]  # inside the person bbox
    assert mask[2, 2]  # far corner kept


def test_sample_frame_indices_bounds_count():
    assert sample_frame_indices(3) == [0, 1, 2]
    idxs = sample_frame_indices(300)
    assert len(idxs) <= 5 and idxs[0] == 0 and idxs[-1] == 299


def test_suggest_offset_recovers_known_lag():
    # A holds the pattern from its start; B's recording begins 15 frames
    # (500 ms @30fps) INTO the pattern, so B's action starts earlier in
    # B's clip — the anchor must land on offset_a.
    seq_a = _cycling_sequence(content_offset=0)
    seq_b = _cycling_sequence(content_offset=15)
    offset_a, offset_b, confidence = suggest_offset_ms(seq_a, seq_b)
    assert (offset_a, offset_b) == (pytest.approx(500, abs=60), 0)  # 100 Hz grid
    assert confidence is not None and confidence > 0.7


def test_suggest_offset_handles_action_later_in_b():
    # B starts 15 frames before the pattern — its action begins later than
    # A's, so the anchor must land on offset_b instead.
    seq_a = _cycling_sequence(content_offset=15)
    seq_b = _cycling_sequence(content_offset=0)
    offset_a, offset_b, confidence = suggest_offset_ms(seq_a, seq_b)
    assert (offset_a, offset_b) == (0, pytest.approx(500, abs=60))
    assert confidence is not None and confidence > 0.7


def _cycling_sequence(start_ms: int = 0, content_offset: int = 0) -> ShotSequence:
    """2 s @ 30 fps following a shared non-periodic height pattern."""
    frames = []
    for i in range(60):
        k = i + content_offset
        phase = np.sin(k / 60 * 2 * np.pi * 2) + 0.3 * np.sin(k / 60 * 2 * np.pi * 0.5 + 1.0)
        keypoints = [
            Keypoint(name=name, x=0.5, y=float(0.5 + 0.2 * phase), confidence=0.95)
            for name in ["nose", "left_shoulder", "right_shoulder"]
        ]
        keypoints += [
            Keypoint(name=name, x=0.5, y=0.9, confidence=0.95)
            for name in set(_ALL_NAMES()) - {"nose", "left_shoulder", "right_shoulder"}
        ]
        frames.append(PoseFrame(frame_idx=i, t_ms=start_ms + i * (1000 // 30), keypoints=keypoints))
    return ShotSequence(clip_id="cycling", fps=30, width=100, height=100, frames=frames)


def _ALL_NAMES():
    from app.schemas.pose import COCO17_KEYPOINTS

    return COCO17_KEYPOINTS


def test_suggest_offset_short_clips_returns_none():
    seq = sequence()  # 3 frames / 200 ms — too short
    assert suggest_offset_ms(seq, seq) == (0, 0, None)


def test_pose_signal_interpolates_missing_frames():
    import copy

    seq = sequence()
    seq.frames[1].keypoints = [Keypoint(name=k.name, x=0.0, y=0.0, confidence=0.0) for k in seq.frames[1].keypoints]
    t, signal = pose_signal(seq)
    assert np.all(np.isfinite(signal))
    assert np.allclose(signal.mean(), 0.0, atol=1e-9)
