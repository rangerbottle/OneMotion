"""Create an exact timestamp-bounded benchmark clip from a local source video."""

import argparse
import hashlib
import json
import os
import math
import tempfile
from pathlib import Path

import cv2


def clip_video(source: Path, output: Path, start_ms: int, end_ms: int) -> tuple[int, int]:
    """Extract the ``[start_ms, end_ms)`` window of ``source`` into ``output``.

    Returns ``(frames_written, effective_end_ms)``. ``effective_end_ms`` is
    derived from the frames actually written, so the provenance manifest always
    describes the real clip duration even when the source's frame timing differs
    slightly from the request (rounding, variable frame rate, container quirks).
    A source that stops well short of ``end_ms`` is still a hard error.
    """
    if source.resolve() == output.resolve():
        raise ValueError("source and output must be different files")
    if not 0 <= start_ms < end_ms:
        raise ValueError("require 0 <= start_ms < end_ms")
    capture = cv2.VideoCapture(str(source))
    writer = None
    temporary = None
    try:
        if not capture.isOpened():
            raise ValueError(f"cannot open source video: {source}")
        fps = capture.get(cv2.CAP_PROP_FPS)
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if not math.isfinite(fps) or fps <= 0 or width <= 0 or height <= 0:
            raise ValueError("source video has invalid timing or dimensions")
        frame_ms = 1000.0 / fps
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=output.parent, suffix=output.suffix, delete=False) as handle:
            temporary = Path(handle.name)
        writer = cv2.VideoWriter(str(temporary), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
        if not writer.isOpened():
            raise RuntimeError(f"cannot create output video: {output}")

        written = 0
        index = 0
        latest_ms = 0.0
        prev_pos = -1.0
        trust_pos = True  # use CAP_PROP_POS_MSEC until it proves unreliable
        reached_end = False
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            pos = capture.get(cv2.CAP_PROP_POS_MSEC)
            if trust_pos and (not math.isfinite(pos) or pos <= prev_pos):
                # Timestamps missing, zero, or non-monotonic for this container;
                # fall back to frame-index timing for the rest of the clip.
                trust_pos = False
            timestamp_ms = pos if trust_pos else index * frame_ms
            if math.isfinite(pos):
                prev_pos = pos
            index += 1
            latest_ms = max(latest_ms, timestamp_ms)
            if timestamp_ms < start_ms:
                continue
            if timestamp_ms >= end_ms:
                reached_end = True
                break
            writer.write(frame)
            written += 1

        if written == 0:
            raise ValueError(
                f"no frames fall in {start_ms}-{end_ms} ms — check --start-ms/--end-ms against the clip"
            )
        source_ms = latest_ms + frame_ms
        if not reached_end and (end_ms - source_ms) > max(3 * frame_ms, 200.0):
            raise ValueError(
                f"source is only ~{source_ms / 1000:.2f}s long but the requested interval ends at "
                f"{end_ms / 1000:.2f}s — lower --end-ms or provide a longer clip"
            )
        writer.release()
        temporary.replace(output)
        return written, start_ms + int(round(written * frame_ms))
    finally:
        capture.release()
        if writer is not None:
            writer.release()
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--start-ms", type=int, default=0)
    parser.add_argument("--end-ms", type=int, default=3000)
    parser.add_argument("--provenance", type=Path, help="write the source manifest for benchmark construction")
    parser.add_argument("--timing-mode", choices=["unknown", "realtime", "slow_motion"], default="unknown")
    parser.add_argument("--time-scale", type=float)
    parser.add_argument("--source-url")
    args = parser.parse_args()
    if args.start_ms < 0 or args.end_ms <= args.start_ms:
        parser.error("require 0 <= start-ms < end-ms")
    if args.timing_mode == "realtime" and args.time_scale != 1:
        parser.error("real-time source requires explicit --time-scale 1")
    frames, effective_end_ms = clip_video(args.source, args.output, args.start_ms, args.end_ms)
    if args.provenance:
        def digest(path):
            with path.open("rb") as handle:
                return hashlib.file_digest(handle, "sha256").hexdigest()
        args.provenance.parent.mkdir(parents=True, exist_ok=True)
        args.provenance.write_text(json.dumps({"clips": [{
            "path": os.path.relpath(args.output.resolve(), args.provenance.parent.resolve()),
            "sha256": digest(args.output), "source_sha256": digest(args.source),
            "source_url": args.source_url, "start_ms": args.start_ms, "end_ms": effective_end_ms,
            "timing_mode": args.timing_mode, "time_scale_to_realtime": args.time_scale,
        }]}, indent=2))
    print(f"wrote {frames} frames to {args.output}")
    if effective_end_ms != args.end_ms:
        print(
            f"note: effective interval is {args.start_ms}-{effective_end_ms} ms "
            f"(the source's frame timing differed from the {args.end_ms} ms request)"
        )


if __name__ == "__main__":
    main()
