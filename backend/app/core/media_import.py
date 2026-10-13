"""Bounded upload storage and full-frame extraction of one HomeCourt shot."""

import hashlib
import math
import queue
import re
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import cv2
import imageio_ffmpeg
from fastapi import HTTPException, UploadFile

from app.core.video import MAX_FPS, MAX_FRAMES, MAX_PIXELS, inference_slot
from app.schemas.media_source import ClipImportRequest, MediaSource

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".webm"}
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_SOURCE_BYTES = 200 * 1024 * 1024
MAX_SOURCE_DURATION_MS = 600_000
EXTRACTION_TIMEOUT_S = 60


def _write_upload(video: UploadFile, path: Path, limit: int) -> str:
    digest = hashlib.sha256()
    written = 0
    created = False
    try:
        with path.open("xb") as target:
            created = True
            while chunk := video.file.read(1024 * 1024):
                written += len(chunk)
                if written > limit:
                    kind = "source video" if limit == MAX_SOURCE_BYTES else "clip"
                    raise HTTPException(413, f"{kind} exceeds {limit // (1024 * 1024)} MB")
                target.write(chunk)
                digest.update(chunk)
    except BaseException:
        if created:
            path.unlink(missing_ok=True)
        raise
    return digest.hexdigest()


def _probe_source(path: Path) -> tuple[float, float]:
    """Require bounded, declared source timing before running the extractor."""
    capture = cv2.VideoCapture(str(path))
    try:
        if not capture.isOpened():
            raise ValueError("cannot decode source video — use mp4/mov/webm")
        fps = capture.get(cv2.CAP_PROP_FPS)
        width = capture.get(cv2.CAP_PROP_FRAME_WIDTH)
        height = capture.get(cv2.CAP_PROP_FRAME_HEIGHT)
        count = capture.get(cv2.CAP_PROP_FRAME_COUNT)
        if not all(math.isfinite(value) and value > 0 for value in (fps, width, height, count)):
            raise ValueError("source video must declare valid timing, frame count, and dimensions")
        if width * height > MAX_PIXELS or fps > MAX_FPS:
            raise ValueError("source video exceeds 4K pixel budget or 120 fps")
        duration_ms = count / fps * 1000
        if duration_ms > MAX_SOURCE_DURATION_MS + 1:
            raise ValueError("source video exceeds 10 minutes")
        return fps, duration_ms
    finally:
        capture.release()


def _timeout_error() -> RuntimeError:
    return RuntimeError("shot extraction exceeded 60 seconds — use a shorter source video")


def _wait_ffmpeg(process, deadline: float) -> int:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise _timeout_error()
    try:
        return process.wait(timeout=remaining)
    except subprocess.TimeoutExpired as exc:
        raise _timeout_error() from exc


@contextmanager
def _ffmpeg_lines(command: list[str], deadline: float):
    """Stream bounded diagnostic lines; kill the process on timeout/early exit.

    The reader queue holds at most 32 chunks of 8 KiB. A blocking pipe read
    cannot prevent the main thread from enforcing the shared wall-clock budget.
    """
    if time.monotonic() >= deadline:
        raise _timeout_error()
    try:
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except OSError as exc:
        raise RuntimeError("could not start the video extractor") from exc
    lines: queue.Queue[bytes | None] = queue.Queue(maxsize=32)
    stopped = threading.Event()

    def read_output() -> None:
        while not stopped.is_set():
            line = process.stderr.readline(8192)
            while not stopped.is_set():
                try:
                    lines.put(line if line else None, timeout=0.05)
                    break
                except queue.Full:
                    continue
            if not line:
                break

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()

    def output():
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _timeout_error()
            try:
                line = lines.get(timeout=remaining)
            except queue.Empty as exc:
                raise _timeout_error() from exc
            if line is None:
                break
            yield line.decode("utf-8", errors="replace")

    try:
        yield process, output()
    finally:
        stopped.set()
        if process.poll() is None:
            process.kill()
        process.wait()
        reader.join(timeout=1)
        process.stderr.close()


@dataclass(frozen=True)
class _FrameWindow:
    start_pts: int
    end_pts: int
    frame_count: int
    last_frame_pts: int
    time_base_num: int
    time_base_den: int

    @property
    def start_s(self) -> float:
        return self.start_pts * self.time_base_num / self.time_base_den

    @property
    def end_s(self) -> float:
        return self.end_pts * self.time_base_num / self.time_base_den


def _source_window(source_path: Path, source: ClipImportRequest, deadline: float) -> _FrameWindow:
    """Floor the requested start and ceil its end on the original decoded PTS.

    A backward keyframe seek includes the frame already displayed at the start.
    Stop at the first frame on/after end; no full source pose/PTS array is built.
    The final source frame's declared duration is the only EOF boundary allowed.
    """
    command = [
        imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "info", "-nostdin",
        "-copyts", "-threads", "1", "-seek_timestamp", "1",
        "-ss", f"{source.start_ms / 1000:.3f}", "-noaccurate_seek", "-i", str(source_path),
        "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", "showinfo",
        "-fps_mode", "passthrough", "-f", "null", "-",
    ]
    time_base = None
    previous_pts = None
    start_pts = None
    last_pts = None
    last_duration_pts = None
    count = 0
    with _ffmpeg_lines(command, deadline) as (process, lines):
        for line in lines:
            base = re.search(r"config in time_base:\s*(\d+)/(\d+)", line)
            if base:
                numerator, denominator = map(int, base.groups())
                if numerator <= 0 or denominator <= 0:
                    raise ValueError("source video has invalid frame timing")
                if time_base is not None and time_base != (numerator, denominator):
                    raise ValueError("source video changes its frame time base")
                time_base = (numerator, denominator)
            frame = re.search(r"\bn:\s*\d+\s+pts:\s*(\S+)\s+pts_time:\s*(\S+)\s+duration:\s*(\S+)", line)
            if not frame:
                continue
            try:
                pts, printed_s, duration = frame.groups()
                current_pts = int(pts)
                duration_pts = int(duration)
                numerator, denominator = time_base
                if not math.isfinite(float(printed_s)):
                    raise ValueError
            except (ValueError, TypeError, OverflowError):
                raise ValueError("source video has invalid frame timing") from None
            if duration_pts < 0:
                raise ValueError("source video has invalid frame timing")
            if current_pts < 0 or (previous_pts is not None and current_pts <= previous_pts):
                raise ValueError("source video frame timestamps must strictly increase")
            previous_pts = current_pts
            if current_pts * numerator * 1000 >= source.end_ms * denominator:
                if start_pts is None:
                    raise ValueError("selected shot window contains no source video frames")
                return _FrameWindow(start_pts, current_pts, count, last_pts, numerator, denominator)
            if start_pts is None or current_pts * numerator * 1000 <= source.start_ms * denominator:
                start_pts, count = current_pts, 1
            else:
                count += 1
            last_pts, last_duration_pts = current_pts, duration_pts
            if count > MAX_FRAMES:
                raise ValueError("selected shot exceeds the decoded-frame limit")
        if _wait_ffmpeg(process, deadline) != 0:
            raise ValueError("could not decode the selected source video window")
    if start_pts is None or last_duration_pts is None or last_duration_pts <= 0:
        raise ValueError("selected shot window extends beyond the source video")
    end_pts = last_pts + last_duration_pts
    numerator, denominator = time_base
    if source.end_ms * denominator > end_pts * numerator * 1000:
        raise ValueError("selected shot window extends beyond the source video")
    return _FrameWindow(start_pts, end_pts, count, last_pts, numerator, denominator)


def _extract_clip(source_path: Path, selected_path: Path, source: ClipImportRequest) -> ClipImportRequest:
    deadline = time.monotonic() + EXTRACTION_TIMEOUT_S
    window = _source_window(source_path, source, deadline)
    duration_s = window.end_s - window.start_s
    if not 0 < (window.end_pts - window.start_pts) * window.time_base_num <= 12 * window.time_base_den:
        raise ValueError("actual frame boundaries exceed 12 seconds — select a shorter shot window")
    actual = ClipImportRequest.model_validate({
        **source.model_dump(), "start_ms": round(window.start_s * 1000), "end_ms": round(window.end_s * 1000),
    })
    # Preserve every source PTS delta and set the output clock's origin to zero.
    # No B frames: DTS then equals PTS, including around VFR gaps. The last packet
    # must retain its actual display duration through the next source boundary;
    # otherwise a final held frame would be shortened to one nominal frame.
    final_duration_pts = window.end_pts - window.last_frame_pts
    packet_duration = (
        f"setts=duration=if(eq(N\\,{window.frame_count - 1})\\,"
        f"round({final_duration_pts}*{window.time_base_num}/{window.time_base_den}/TB)\\,DURATION)"
    )
    command = [
        imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-nostdin",
        "-y", "-copyts", "-threads", "1", "-seek_timestamp", "1",
        "-ss", f"{window.start_s:.9f}", "-noaccurate_seek", "-i", str(source_path),
        "-t", f"{duration_s:.9f}",
        "-map", "0:v:0", "-an", "-sn", "-dn", "-c:v", "libx264", "-threads", "1",
        "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-bf", "0",
        "-vf", f"trim=start_pts={window.start_pts}:end_pts={window.end_pts},setpts=PTS-STARTPTS,pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-fps_mode", "passthrough", "-enc_time_base:v", "filter", "-bsf:v", packet_duration,
        "-movflags", "+faststart", "-fs", str(MAX_UPLOAD_BYTES + 1), str(selected_path),
    ]
    with _ffmpeg_lines(command, deadline) as (process, lines):
        for _ in lines:
            pass
        if _wait_ffmpeg(process, deadline) != 0:
            raise RuntimeError("could not extract a playable shot from the source video")
    return actual


def prepare_upload(
    video: UploadFile,
    target_dir: Path,
    clip_id: str,
    source: ClipImportRequest | None = None,
    *,
    concurrency: int = 1,
) -> tuple[Path, MediaSource | None]:
    """Store a normal upload or extract a single full-frame HomeCourt shot.

    The caller still validates the returned clip and runs pose under its own
    inference slot. This function releases the extraction slot before returning.
    The caller owns UploadFile.close and rollback after a successful return.
    Original HomeCourt media is always temporary, including on extraction error.
    """
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", clip_id):
        raise ValueError("invalid clip identifier")
    filename = video.filename or "clip.mp4"
    extension = Path(filename).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise ValueError(f"unsupported video type '{extension}' — use mp4/mov/webm")
    target_dir.mkdir(parents=True, exist_ok=True)
    selected_path = target_dir / f"{clip_id}{'.mp4' if source else extension}"
    if selected_path.exists():
        raise FileExistsError("clip destination already exists")

    if source is None:
        _write_upload(video, selected_path, MAX_UPLOAD_BYTES)
        return selected_path, None

    with tempfile.TemporaryDirectory(prefix=f".{clip_id}-source-", dir=target_dir) as directory:
        original_path = Path(directory) / f"original{extension}"
        temporary_clip = Path(directory) / "selected.mp4"
        original_sha256 = _write_upload(video, original_path, MAX_SOURCE_BYTES)
        _probe_source(original_path)
        with inference_slot(concurrency):
            actual = _extract_clip(original_path, temporary_clip, source)
        if not temporary_clip.is_file() or temporary_clip.stat().st_size == 0:
            raise RuntimeError("shot extraction produced no video")
        if temporary_clip.stat().st_size > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "selected clip exceeds 50 MB")
        clip_fps, clip_duration_ms = _probe_source(temporary_clip)
        expected_ms = actual.end_ms - actual.start_ms
        if abs(clip_duration_ms - expected_ms) > max(2_000 / clip_fps, 50):
            raise ValueError("source video ended before the complete selected shot could be extracted")
        with temporary_clip.open("rb") as handle:
            selected_sha256 = hashlib.file_digest(handle, "sha256").hexdigest()
        metadata = MediaSource(
            **actual.model_dump(), original_filename=filename,
            original_sha256=original_sha256, selected_sha256=selected_sha256,
            requested_start_ms=source.start_ms if actual.start_ms != source.start_ms or actual.end_ms != source.end_ms else None,
            requested_end_ms=source.end_ms if actual.start_ms != source.start_ms or actual.end_ms != source.end_ms else None,
        )
        temporary_clip.replace(selected_path)
        return selected_path, metadata
