"""Import contracts, bounded resources, cleanup, and real shot extraction."""

import hashlib
import io
import json
import subprocess
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import cv2
import imageio_ffmpeg
import numpy as np
import pytest
from fastapi import HTTPException, UploadFile
from pydantic import ValidationError

from app.core import media_import
from app.core.video import AnalysisBusy, inference_slot, validate_video
from app.schemas.media_source import ClipImportRequest, SubjectROI, parse_import_request


def upload(body: bytes, filename: str = "training.mov") -> UploadFile:
    return UploadFile(filename=filename, file=io.BytesIO(body))


def request(**changes) -> ClipImportRequest:
    return ClipImportRequest(start_ms=11_000, end_ms=12_000, **changes)


@pytest.fixture(scope="module")
def practice_video(tmp_path_factory) -> Path:
    path = tmp_path_factory.mktemp("import-source") / "practice.mp4"
    writer = imageio_ffmpeg.write_frames(
        str(path), (64, 48), fps=10, codec="libx264", macro_block_size=1,
        pix_fmt_out="yuv420p", output_params=["-crf", "10"],
    )
    writer.send(None)
    try:
        for index in range(140):
            frame = np.zeros((48, 64, 3), dtype=np.uint8)
            frame[:, :, 0] = index + 20
            frame[:, :4, :] = 255
            writer.send(frame)
    finally:
        writer.close()
    return path


@pytest.fixture(scope="module")
def variable_video(tmp_path_factory, practice_video) -> Path:
    path = tmp_path_factory.mktemp("vfr-source") / "variable.mp4"
    subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-nostdin",
        "-i", str(practice_video), "-t", "3", "-vf", "select='not(between(n,4,8))'",
        "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path),
    ], check=True, capture_output=True, timeout=10)
    return path


def clip_timestamps(path: Path) -> list[float]:
    capture = cv2.VideoCapture(str(path))
    timestamps = []
    try:
        while capture.read()[0]:
            timestamps.append(capture.get(cv2.CAP_PROP_POS_MSEC))
    finally:
        capture.release()
    return timestamps


def test_real_long_source_extracts_selected_shot_without_crop_or_speed_change(tmp_path, practice_video):
    # This source exceeds the ordinary 12-second budget; only the extracted shot
    # enters that existing pipeline, and an ROI must not crop away the background.
    with pytest.raises(ValueError, match="12 seconds"):
        validate_video(practice_video)
    body = practice_video.read_bytes()
    roi = {"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5}
    source = request(subject_roi=roi, recorded_at="2026-10-04T10:00:00+08:00", camera_label=" court side ")
    selected, provenance = media_import.prepare_upload(upload(body), tmp_path, "shot", source)
    validate_video(selected)
    assert selected.name == "shot.mp4"
    assert list(tmp_path.iterdir()) == [selected]
    assert provenance is not None
    assert provenance.original_filename == "training.mov"
    assert provenance.original_sha256 == hashlib.sha256(body).hexdigest()
    assert provenance.selected_sha256 == hashlib.sha256(selected.read_bytes()).hexdigest()
    assert (provenance.start_ms, provenance.end_ms) == (11_000, 12_000)
    assert provenance.subject_roi == SubjectROI(**roi)
    assert provenance.timing_mode == "unknown"
    assert provenance.camera_label == "court side"
    assert provenance.recorded_at.isoformat() == "2026-10-04T10:00:00+08:00"
    capture = cv2.VideoCapture(str(selected))
    try:
        assert capture.get(cv2.CAP_PROP_FRAME_WIDTH) == 64
        assert capture.get(cv2.CAP_PROP_FRAME_HEIGHT) == 48
        assert capture.get(cv2.CAP_PROP_FPS) == pytest.approx(10)
        assert capture.get(cv2.CAP_PROP_FRAME_COUNT) == 10
        ok, first = capture.read()
        assert ok
        # Frame 110 has red=130; the beginning of the source has red=20.
        assert int(first[24, 32, 2]) == pytest.approx(130, abs=6)
        assert first[24, 0].min() >= 240
        assert capture.get(cv2.CAP_PROP_POS_MSEC) == pytest.approx(0, abs=1)
    finally:
        capture.release()


def test_normal_upload_keeps_original_bytes_and_does_not_close_caller_file(tmp_path):
    video = upload(b"ordinary upload", "shot.MOV")
    path, source = media_import.prepare_upload(video, tmp_path, "shot")
    assert path.name == "shot.mov"
    assert path.read_bytes() == b"ordinary upload"
    assert source is None
    assert not video.file.closed


def test_variable_frame_timestamps_are_preserved_by_extraction(tmp_path, variable_video):
    destination = tmp_path / "clips"
    selected, _ = media_import.prepare_upload(
        upload(variable_video.read_bytes(), "variable.mp4"), destination, "shot",
        ClipImportRequest(start_ms=0, end_ms=1_500),
    )
    validate_video(selected)
    assert clip_timestamps(selected) == pytest.approx([0, 100, 200, 300, 900, 1000, 1100, 1200, 1300, 1400], abs=1)
    assert list(destination.iterdir()) == [selected]


@pytest.mark.parametrize("start,end,actual_start,actual_end,timestamps", [
    (400, 1_500, 300, 1_500, [0, 600, 700, 800, 900, 1000, 1100]),
    (0, 400, 0, 900, [0, 100, 200, 300]),
    (450, 950, 300, 1_000, [0, 600]),
    (401, 499, 300, 900, [0]),
])
def test_vfr_gap_boundaries_are_explicit_and_keep_held_frame_duration(
    tmp_path, variable_video, start, end, actual_start, actual_end, timestamps,
):
    selected, metadata = media_import.prepare_upload(
        upload(variable_video.read_bytes(), "variable.mp4"), tmp_path, "shot",
        ClipImportRequest(start_ms=start, end_ms=end),
    )
    validate_video(selected)
    assert (metadata.start_ms, metadata.end_ms) == (actual_start, actual_end)
    assert (metadata.requested_start_ms, metadata.requested_end_ms) == (start, end)
    assert clip_timestamps(selected) == pytest.approx(timestamps, abs=1)
    _, duration = media_import._probe_source(selected)
    assert duration == pytest.approx(actual_end - actual_start, abs=1)
    assert list(tmp_path.iterdir()) == [selected]


def test_initial_source_pts_offset_is_recorded_and_output_clock_starts_at_zero(tmp_path):
    original = tmp_path / "offset.mp4"
    subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=3",
        "-vf", "settb=1/1000,setpts=PTS+23", "-fps_mode", "passthrough",
        "-enc_time_base:v", "filter", "-c:v", "libx264", "-bf", "0", str(original),
    ], check=True, capture_output=True, timeout=10)
    selected, metadata = media_import.prepare_upload(
        upload(original.read_bytes(), "offset.mp4"), tmp_path / "clips", "shot",
        ClipImportRequest(start_ms=0, end_ms=1_000),
    )
    assert (metadata.start_ms, metadata.end_ms) == (23, 1_023)
    assert (metadata.requested_start_ms, metadata.requested_end_ms) == (0, 1_000)
    assert clip_timestamps(selected) == pytest.approx(list(range(0, 1000, 100)), abs=1)
    # Check raw demux PTS too: OpenCV alone normalizes a nonzero stream start.
    window = media_import._source_window(
        selected, ClipImportRequest(start_ms=0, end_ms=500), time.monotonic() + 5,
    )
    assert window.start_s == 0


def test_fractional_millisecond_frame_boundaries_keep_all_exact_ticks(tmp_path):
    original = tmp_path / "fractional.mp4"
    subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", "testsrc=size=64x48:rate=60000/1001:duration=1",
        "-c:v", "libx264", "-bf", "0", str(original),
    ], check=True, capture_output=True, timeout=10)
    request = ClipImportRequest(start_ms=17, end_ms=100)
    source_window = media_import._source_window(original, request, time.monotonic() + 5)
    assert (source_window.start_pts, source_window.end_pts) == (1001, 6006)
    assert (source_window.time_base_num, source_window.time_base_den) == (1, 60_000)
    selected, _ = media_import.prepare_upload(
        upload(original.read_bytes(), "fractional.mp4"), tmp_path / "clips", "shot", request,
    )
    timestamps = clip_timestamps(selected)
    assert len(timestamps) == 5
    assert timestamps == pytest.approx([index * 1001 / 60 for index in range(5)], abs=0.001)
    assert media_import._probe_source(selected)[1] == pytest.approx(5005 / 60, abs=0.001)
    output_window = media_import._source_window(
        selected, ClipImportRequest(start_ms=0, end_ms=80), time.monotonic() + 5,
    )
    assert output_window.start_pts == 0


def test_snap_expansion_does_not_relax_actual_twelve_second_limit(tmp_path, practice_video):
    with pytest.raises(ValueError, match="actual frame boundaries exceed 12 seconds"):
        media_import.prepare_upload(
            upload(practice_video.read_bytes()), tmp_path, "shot",
            ClipImportRequest(start_ms=1, end_ms=12_001),
        )
    assert list(tmp_path.iterdir()) == []


def test_source_end_uses_last_real_frame_duration_without_inventing_frames(tmp_path, practice_video):
    selected, metadata = media_import.prepare_upload(
        upload(practice_video.read_bytes()), tmp_path, "shot",
        ClipImportRequest(start_ms=13_550, end_ms=14_000),
    )
    assert (metadata.start_ms, metadata.end_ms) == (13_500, 14_000)
    assert (metadata.requested_start_ms, metadata.requested_end_ms) == (13_550, 14_000)
    assert clip_timestamps(selected) == pytest.approx([0, 100, 200, 300, 400], abs=1)
    assert media_import._probe_source(selected)[1] == pytest.approx(500, abs=1)


def test_pts_scan_and_encoding_share_one_wall_clock_budget(tmp_path, monkeypatch):
    now = [100.0]
    monkeypatch.setattr(media_import.time, "monotonic", lambda: now[0])

    def scan(path, source, deadline):
        assert deadline == 160
        now[0] = 130
        return media_import._FrameWindow(330, 360, 30, 359, 1, 30)

    @contextmanager
    def encoder(command, deadline):
        assert deadline == 160
        assert deadline - now[0] == 30
        yield type("Process", (), {"wait": lambda self, **options: 0})(), iter(())

    monkeypatch.setattr(media_import, "_source_window", scan)
    monkeypatch.setattr(media_import, "_ffmpeg_lines", encoder)
    actual = media_import._extract_clip(tmp_path / "source.mp4", tmp_path / "shot.mp4", request())
    assert (actual.start_ms, actual.end_ms) == (11_000, 12_000)


@pytest.mark.parametrize("pts,printed", [(0, "nan"), ("NOPTS", "0"), (0, "0"), (-1, "-0.001")])
def test_pts_scan_rejects_invalid_or_nonincreasing_clock(tmp_path, monkeypatch, pts, printed):
    @contextmanager
    def output(*args):
        yield None, iter([
            "config in time_base: 1/1000",
            "n: 0 pts: 0 pts_time:0 duration:100",
            f"n: 1 pts: {pts} pts_time:{printed} duration:100",
        ])

    monkeypatch.setattr(media_import, "_ffmpeg_lines", output)
    with pytest.raises(ValueError, match="timing|strictly increase"):
        media_import._source_window(tmp_path / "source.mp4", ClipImportRequest(start_ms=0, end_ms=1_000), 60)


def test_pts_scan_stops_at_first_frame_after_requested_end(tmp_path, monkeypatch):
    def lines():
        yield "config in time_base: 1/1000"
        for index, pts in enumerate([0, 100, 200]):
            yield f"n: {index} pts: {pts} pts_time:{pts/1000} duration:100"
        pytest.fail("scan continued past the first ending frame")

    @contextmanager
    def output(*args):
        yield None, lines()

    monkeypatch.setattr(media_import, "_ffmpeg_lines", output)
    window = media_import._source_window(tmp_path / "source.mp4", ClipImportRequest(start_ms=10, end_ms=150), 60)
    assert window == media_import._FrameWindow(0, 200, 2, 100, 1, 1000)


@pytest.mark.parametrize("homecourt", [False, True])
def test_upload_size_limit_removes_all_partial_files(tmp_path, monkeypatch, homecourt):
    monkeypatch.setattr(media_import, "MAX_UPLOAD_BYTES", 4)
    monkeypatch.setattr(media_import, "MAX_SOURCE_BYTES", 8)
    with pytest.raises(HTTPException) as error:
        media_import.prepare_upload(upload(b"too much data"), tmp_path, "shot", request() if homecourt else None)
    assert error.value.status_code == 413
    assert list(tmp_path.iterdir()) == []


def test_extract_failure_removes_original_and_partial_selected_media(tmp_path, monkeypatch):
    monkeypatch.setattr(media_import, "_probe_source", lambda _: (30, 15_000))

    def fail(original, selected, source):
        assert original.read_bytes() == b"source"
        selected.write_bytes(b"partial encoded video")
        raise RuntimeError("encoder failed")

    monkeypatch.setattr(media_import, "_extract_clip", fail)
    with pytest.raises(RuntimeError, match="encoder failed"):
        media_import.prepare_upload(upload(b"source"), tmp_path, "shot", request())
    assert list(tmp_path.iterdir()) == []


def test_extraction_timeout_is_bounded_and_cleans_files(tmp_path, monkeypatch):
    monkeypatch.setattr(media_import, "_probe_source", lambda _: (30, 15_000))
    monkeypatch.setattr(media_import, "EXTRACTION_TIMEOUT_S", 0.05)
    killed = threading.Event()

    class Pipe:
        def readline(self, size):
            assert size == 8192
            killed.wait(2)
            return b""

        def close(self):
            pass

    class Process:
        stderr = Pipe()

        def poll(self):
            return -9 if killed.is_set() else None

        def kill(self):
            killed.set()

        def wait(self, **options):
            assert killed.is_set()
            return -9

    monkeypatch.setattr(media_import.subprocess, "Popen", lambda *args, **options: Process())
    with pytest.raises(RuntimeError, match="exceeded 60 seconds"):
        media_import.prepare_upload(upload(b"source"), tmp_path, "shot", request())
    assert killed.is_set()
    assert list(tmp_path.iterdir()) == []
    # The same semaphore used by pose must be released even after failure.
    with inference_slot(1):
        pass


def test_busy_extraction_does_not_encode_and_cleans_source(tmp_path, monkeypatch):
    monkeypatch.setattr(media_import, "_probe_source", lambda _: (30, 15_000))
    monkeypatch.setattr(media_import, "_extract_clip", lambda *_: pytest.fail("busy extraction ran"))
    with inference_slot(1):
        with pytest.raises(AnalysisBusy):
            media_import.prepare_upload(upload(b"source"), tmp_path, "shot", request())
    assert list(tmp_path.iterdir()) == []


def test_successful_extraction_releases_slot_before_caller_pose(tmp_path, monkeypatch, practice_video):
    entered = []

    @contextmanager
    def track_slot(count):
        entered.append(count)
        with inference_slot(count):
            yield

    monkeypatch.setattr(media_import, "inference_slot", track_slot)
    media_import.prepare_upload(upload(practice_video.read_bytes()), tmp_path, "shot", request())
    assert entered == [1]
    with inference_slot(1):
        pass


def test_window_past_source_end_is_rejected_and_cleans_original(tmp_path, practice_video):
    source = ClipImportRequest(start_ms=13_500, end_ms=14_500)
    with pytest.raises(ValueError, match="beyond the source"):
        media_import.prepare_upload(upload(practice_video.read_bytes()), tmp_path, "shot", source)
    assert list(tmp_path.iterdir()) == []


def test_truncated_extraction_does_not_commit_partial_shot(tmp_path, monkeypatch):
    monkeypatch.setattr(media_import, "_probe_source", lambda path: (30, 15_000 if path.name.startswith("original") else 500))

    def short(original, selected, source):
        selected.write_bytes(b"short")
        return source

    monkeypatch.setattr(media_import, "_extract_clip", short)
    with pytest.raises(ValueError, match="complete selected shot"):
        media_import.prepare_upload(upload(b"source"), tmp_path, "shot", request())
    assert list(tmp_path.iterdir()) == []


def test_selected_output_still_obeys_ordinary_size_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(media_import, "MAX_UPLOAD_BYTES", 8)
    monkeypatch.setattr(media_import, "_probe_source", lambda _: (30, 15_000))
    monkeypatch.setattr(media_import, "_extract_clip", lambda original, selected, source: selected.write_bytes(b"encoded video"))
    with pytest.raises(HTTPException) as error:
        media_import.prepare_upload(upload(b"source"), tmp_path, "shot", request())
    assert error.value.status_code == 413
    assert error.value.detail == "selected clip exceeds 50 MB"
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("property_name,value,message", [
    (cv2.CAP_PROP_FPS, 121, "120 fps"),
    (cv2.CAP_PROP_FRAME_WIDTH, 10_000, "4K"),
    (cv2.CAP_PROP_FRAME_COUNT, 18_001, "10 minutes"),
    (cv2.CAP_PROP_FRAME_COUNT, 0, "declare valid timing"),
    (cv2.CAP_PROP_FPS, float("nan"), "declare valid timing"),
])
def test_source_resource_limits_reject_before_extraction(tmp_path, monkeypatch, property_name, value, message):
    properties = {
        cv2.CAP_PROP_FPS: 30, cv2.CAP_PROP_FRAME_WIDTH: 1920,
        cv2.CAP_PROP_FRAME_HEIGHT: 1080, cv2.CAP_PROP_FRAME_COUNT: 450,
    }
    properties[property_name] = value
    released = []

    class Capture:
        def isOpened(self):
            return True

        def get(self, name):
            return properties[name]

        def release(self):
            released.append(True)

    monkeypatch.setattr(media_import.cv2, "VideoCapture", lambda *_: Capture())
    monkeypatch.setattr(media_import, "_extract_clip", lambda *_: pytest.fail("invalid source encoded"))
    with pytest.raises(ValueError, match=message):
        media_import.prepare_upload(upload(b"source"), tmp_path, "shot", request())
    assert released == [True]
    assert list(tmp_path.iterdir()) == []


def test_existing_clip_cannot_be_overwritten(tmp_path):
    existing = tmp_path / "shot.mp4"
    existing.write_bytes(b"previous")
    with pytest.raises(FileExistsError):
        media_import.prepare_upload(upload(b"replacement", "shot.mp4"), tmp_path, "shot")
    assert existing.read_bytes() == b"previous"


@pytest.mark.parametrize("changes", [
    {"start_ms": True}, {"end_ms": 12_000.5}, {"start_ms": -1},
    {"start_ms": 12_000}, {"end_ms": 24_001}, {"provider": "other"},
    {"recorded_at": "not a date"}, {"camera_label": "   "},
    {"start_ms": 10**1000, "end_ms": 10**1000 + 1000},
    {"start_ms": 599_500, "end_ms": 600_500},
])
def test_import_schema_rejects_invalid_window_and_metadata(changes):
    payload = {"start_ms": 11_000, "end_ms": 12_000, **changes}
    with pytest.raises(ValidationError):
        ClipImportRequest.model_validate(payload)


@pytest.mark.parametrize("changes", [
    {"x": True}, {"width": "0.5"}, {"x": float("nan")},
    {"height": float("inf")}, {"x": -0.1}, {"width": 0},
    {"x": 0.8}, {"y": 0.8},
])
def test_roi_rejects_booleans_nonfinite_values_and_out_of_frame_bounds(changes):
    with pytest.raises(ValidationError):
        SubjectROI.model_validate({"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5, **changes})


@pytest.mark.parametrize("source", ["", "null", "[]", "not json", '{"start_ms": true, "end_ms": 1000}'])
def test_explicit_invalid_source_does_not_fall_back_to_normal_upload(source):
    with pytest.raises(ValueError):
        parse_import_request(source)


def test_source_parser_accepts_only_absent_or_valid_import():
    assert parse_import_request(None) is None
    parsed = parse_import_request(json.dumps({"provider": "homecourt", "start_ms": 1_000, "end_ms": 2_000}))
    assert parsed is not None
    assert parsed.timing_mode == "unknown"


def test_huge_selected_timestamps_are_rejected_before_extraction(tmp_path, monkeypatch):
    monkeypatch.setattr(media_import, "_extract_clip", lambda *_: pytest.fail("unbounded timestamp reached extraction"))
    source = json.dumps({"start_ms": 10**1000, "end_ms": 10**1000 + 1000})
    with pytest.raises(ValueError, match="600000"):
        parsed = parse_import_request(source)
        media_import.prepare_upload(upload(b"source"), tmp_path, "shot", parsed)
    assert list(tmp_path.iterdir()) == []
