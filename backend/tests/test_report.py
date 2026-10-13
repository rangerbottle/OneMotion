"""Report alignment and transactional export checks, without pose inference."""

from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
import pytest

from app.api import routes_compare as routes
from app.compare import report, store
from app.core.config import Settings
from app.schemas.compare import (
    AffineTransform, CameraCheckResult, ClipMeta, ComparisonState,
    PhaseBoundary, TemporalAlignment,
)
from app.schemas.pose import COCO17_KEYPOINTS, Keypoint, PoseFrame, ShotSequence


def pose(clip_id, times, positions, *, width=80, height=60):
    return ShotSequence(
        clip_id=clip_id, fps=4, width=width, height=height,
        frames=[PoseFrame(
            frame_idx=i, t_ms=t,
            keypoints=[Keypoint(name=name, x=x, y=.5, confidence=1)
                       for name in COCO17_KEYPOINTS],
        ) for i, (t, x) in enumerate(zip(times, positions))],
    )


def comparison():
    return ComparisonState(
        comparison_id="c" * 32, player_id="d" * 32, template_id="e" * 32,
        baseline_clip_id="a" * 32, comparison_clip_id="b" * 32,
        spatial=AffineTransform(), temporal=TemporalAlignment(),
        phases_a=[PhaseBoundary(phase="shot", start_frame=0, end_frame=4)],
        phases_b=[PhaseBoundary(phase="shot", start_frame=0, end_frame=4)],
        camera_check=CameraCheckResult(status="match", inlier_ratio=1, matches=20),
        created_at=datetime.now(timezone.utc),
    )


@pytest.fixture
def report_assets(tmp_path):
    cfg = Settings(data_dir=tmp_path)
    store.ensure_dirs(cfg)
    state = comparison()
    for clip_id, kind in ((state.baseline_clip_id, "baseline"),
                          (state.comparison_clip_id, "comparison")):
        seq = pose(clip_id, [0, 250, 500, 750, 1000], [.25] * 5)
        store.save_clip_pose(cfg, clip_id, seq)
        store.save_clip_meta(cfg, ClipMeta(
            clip_id=clip_id, player_id=state.player_id, template_id=state.template_id,
            kind=kind, filename="fixture.mp4", fps=4, width=80, height=60,
            frame_count=5, duration_ms=1250, created_at=state.created_at,
        ))
        writer = cv2.VideoWriter(str(cfg.compare_videos_dir / f"{clip_id}.mp4"),
                                 cv2.VideoWriter_fourcc(*"mp4v"), 4, (80, 60))
        assert writer.isOpened()
        try:
            for _ in range(5):
                writer.write(np.zeros((60, 80, 3), dtype=np.uint8))
        finally:
            writer.release()
    store.save_comparison(cfg, state)
    return cfg, state


def screenshot_paths(cfg, state):
    return [cfg.compare_reports_dir / state.comparison_id / Path(frame.url).name
            for frame in state.report.keyframes]


def test_aligned_deviation_uses_current_source_frame():
    state = comparison()
    seq_a = pose("a", [0, 100, 200], [.1, .1, .9])
    seq_b = pose("b", [0, 120, 240], [.1, .9, .9])
    values = dict(report.aligned_deviation(seq_a, seq_b, state))
    assert values[100] == pytest.approx(0)
    assert report._frame_at(seq_b, 100).frame_idx == 0
    assert report._frame_at(seq_b, 120).frame_idx == 1


def test_deviation_uses_native_pixels_and_gates_missing_joints():
    state = comparison()
    state.spatial = AffineTransform(scale=2, tx=8)
    seq_a = pose("a", [0], [.6])
    seq_b = pose("b", [0], [.5], width=40, height=30)
    assert report.aligned_deviation(seq_a, seq_b, state)[0][1] == pytest.approx(0)
    for point in seq_b.frames[0].keypoints[7:]:
        point.confidence = .49
    assert report.aligned_deviation(seq_a, seq_b, state) == []
    seq_b.frames[0].keypoints[7].confidence = .5
    assert len(report.aligned_deviation(seq_a, seq_b, state)) == 1
    seq_b.frames = []
    assert report.aligned_deviation(seq_a, seq_b, state) == []


def test_export_commits_new_images_before_cleaning_old_report(report_assets):
    cfg, state = report_assets
    first = routes.generate_report(state.comparison_id, cfg)
    first_paths = screenshot_paths(cfg, first)
    assert len(first_paths) == 5
    for path in first_paths:
        assert cv2.imread(str(path)).shape == (60, 80, 3)
        assert routes.report_file(state.comparison_id, path.name, cfg).filename == path.name
    second = routes.generate_report(state.comparison_id, cfg)
    second_paths = screenshot_paths(cfg, second)
    assert set(first_paths).isdisjoint(second_paths)
    assert all(path.is_file() for path in second_paths)
    assert all(not path.exists() for path in first_paths)
    assert store.load_comparison(cfg, state.comparison_id).report == second.report


def test_failed_image_write_keeps_previous_report(report_assets, monkeypatch):
    cfg, state = report_assets
    previous = routes.generate_report(state.comparison_id, cfg)
    paths = screenshot_paths(cfg, previous)
    contents = {path: path.read_bytes() for path in paths}
    write = report.atomic_write
    calls = 0

    def fail_second_write(path, content):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("disk fixture is full")
        write(path, content)

    monkeypatch.setattr(report, "atomic_write", fail_second_write)
    with pytest.raises(OSError, match="disk fixture"):
        routes.generate_report(state.comparison_id, cfg)
    assert store.load_comparison(cfg, state.comparison_id).report == previous.report
    assert {path: path.read_bytes() for path in paths} == contents
    assert set(paths[0].parent.glob("kf_*.png")) == set(paths)


def test_failed_metadata_commit_keeps_previous_report(report_assets, monkeypatch):
    cfg, state = report_assets
    previous = routes.generate_report(state.comparison_id, cfg)
    paths = screenshot_paths(cfg, previous)
    contents = {path: path.read_bytes() for path in paths}

    def fail_commit(*_):
        raise OSError("metadata commit failed")

    monkeypatch.setattr(store, "save_comparison", fail_commit)
    with pytest.raises(OSError, match="metadata commit failed"):
        routes.generate_report(state.comparison_id, cfg)
    assert store.load_comparison(cfg, state.comparison_id).report == previous.report
    assert {path: path.read_bytes() for path in paths} == contents
    assert set(paths[0].parent.glob("kf_*.png")) == set(paths)


def test_failed_decoding_keeps_previous_report(report_assets, monkeypatch):
    cfg, state = report_assets
    previous = routes.generate_report(state.comparison_id, cfg)
    paths = screenshot_paths(cfg, previous)
    monkeypatch.setattr(report, "_decode_frame", lambda *_: None)
    with pytest.raises(RuntimeError, match="could not decode"):
        routes.generate_report(state.comparison_id, cfg)
    assert store.load_comparison(cfg, state.comparison_id).report == previous.report
    assert all(path.is_file() for path in paths)
    assert set(paths[0].parent.glob("kf_*.png")) == set(paths)


def test_screenshot_decoder_selects_pose_frame_index(report_assets):
    cfg, state = report_assets
    path = cfg.compare_videos_dir / f"{state.baseline_clip_id}.mp4"
    with report._video_reader(path) as reader:
        assert report._decode_frame(reader, 2) is not None
        # OpenCV's next frame index confirms exact source-frame selection.
        assert reader.get(cv2.CAP_PROP_POS_FRAMES) == 3


def test_homecourt_unknown_clock_exports_skeletons_without_phase_timing(report_assets):
    from app.schemas.media_source import MediaSource

    cfg, state = report_assets
    clip = store.load_clip_meta(cfg, state.comparison_clip_id)
    clip.source = MediaSource(
        start_ms=0, end_ms=1250, original_filename="homecourt.mp4",
        original_sha256="a" * 64, selected_sha256="b" * 64,
        timing_mode="unknown",
    )
    store.save_clip_meta(cfg, clip)
    result = routes.generate_report(state.comparison_id, cfg)
    assert len(result.report.keyframes) == 5
    assert result.report.phase_offsets == []
    assert "phase timing comparison is disabled" in result.report.summary_text


def test_phase_offsets_use_presentation_timestamps_for_variable_rate_clips():
    state = comparison()
    state.phases_a[0].start_frame = state.phases_b[0].start_frame = 4
    seq_a = pose("a", [0, 100, 200, 300, 400], [.25] * 5)
    seq_b = pose("b", [0, 100, 200, 300, 900], [.25] * 5)
    seq_a.fps, seq_b.fps = 10, 6.667
    offsets = report._phase_offsets(state, seq_a, seq_b)
    assert offsets[0].delta_frames == 0
    assert offsets[0].delta_ms == 500
