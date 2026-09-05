"""Create an exact timestamp-bounded benchmark clip from a local source video."""

import argparse
from pathlib import Path

import cv2


def clip_video(source: Path, output: Path, start_ms: int, end_ms: int) -> int:
    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        raise ValueError(f"cannot open source video: {source}")
    fps = capture.get(cv2.CAP_PROP_FPS)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if fps <= 0 or width <= 0 or height <= 0:
        raise ValueError("source video has invalid timing or dimensions")

    output.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(
        str(output), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height)
    )
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
    capture.release()
    writer.release()
    if written == 0:
        output.unlink(missing_ok=True)
        raise ValueError("requested interval contains no decoded frames")
    return written


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--start-ms", type=int, default=0)
    parser.add_argument("--end-ms", type=int, default=3000)
    args = parser.parse_args()
    if args.start_ms < 0 or args.end_ms <= args.start_ms:
        parser.error("require 0 <= start-ms < end-ms")
    frames = clip_video(args.source, args.output, args.start_ms, args.end_ms)
    print(f"wrote {frames} frames to {args.output}")


if __name__ == "__main__":
    main()
