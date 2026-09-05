"""Create an exact timestamp-bounded benchmark clip from a local source video."""

import argparse
import hashlib
import json
import os
import math
import tempfile
from pathlib import Path

import cv2


def clip_video(source: Path, output: Path, start_ms: int, end_ms: int) -> int:
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
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=output.parent, suffix=output.suffix, delete=False) as handle:
            temporary = Path(handle.name)
        writer = cv2.VideoWriter(str(temporary), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
        if not writer.isOpened():
            raise RuntimeError(f"cannot create output video: {output}")
        written = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            timestamp_ms = capture.get(cv2.CAP_PROP_POS_MSEC)
            if timestamp_ms < start_ms:
                continue
            if timestamp_ms >= end_ms:
                break
            writer.write(frame)
            written += 1
        if written == 0 or abs(written / fps * 1000 - (end_ms - start_ms)) > 2000 / fps:
            raise ValueError("source does not contain the complete requested interval")
        writer.release()
        temporary.replace(output)
        return written
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
    frames = clip_video(args.source, args.output, args.start_ms, args.end_ms)
    if args.provenance:
        def digest(path):
            with path.open("rb") as handle:
                return hashlib.file_digest(handle, "sha256").hexdigest()
        args.provenance.parent.mkdir(parents=True, exist_ok=True)
        args.provenance.write_text(json.dumps({"clips": [{
            "path": os.path.relpath(args.output.resolve(), args.provenance.parent.resolve()),
            "sha256": digest(args.output), "source_sha256": digest(args.source),
            "source_url": args.source_url, "start_ms": args.start_ms, "end_ms": args.end_ms,
            "timing_mode": args.timing_mode, "time_scale_to_realtime": args.time_scale,
        }]}, indent=2))
    print(f"wrote {frames} frames to {args.output}")


if __name__ == "__main__":
    main()
