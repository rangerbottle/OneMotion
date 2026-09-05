#!/usr/bin/env python
"""Split a long multi-shot video into one-shot clips for benchmark building.

Finds shot events as local maxima of the shooting-wrist height trajectory
(wrist above shoulder, arm extending) separated by MIN_GAP_S, then writes a
subclip around each apex. Reusable for any long warmup/practice footage.

Usage:
    uv run python scripts/split_shots.py data/raw_videos/curry/_source/long.mp4 \
        [--out-dir data/raw_videos/curry]
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

from app.analysis.phases import CONF_MIN, raw_conf, shooting_side
from app.analysis.series import series
from app.pose import get_backend

MIN_GAP_S = 3.0  # shots closer than this are one event
PRE_S, POST_S = 2.5, 1.2  # subclip window around the apex


def find_shot_apexes(seq) -> list[int]:
    """Indices of shot apex frames (wrist high, arm extending, well tracked)."""
    from app.analysis.series import angle_abc

    side = shooting_side(seq)
    wrist = series(seq, f"{side}_wrist")
    shoulder = series(seq, f"{side}_shoulder")
    elbow = series(seq, f"{side}_elbow")
    n = len(seq.frames)

    valid = np.array([raw_conf(seq, i, f"{side}_wrist") for i in range(n)]) >= CONF_MIN
    h = -wrist[:, 1]

    apexes: list[int] = []
    min_gap = int(MIN_GAP_S * seq.fps)
    for i in range(1, n - 1):
        if not valid[i] or h[i] < h[i - 1] or h[i] < h[i + 1]:
            continue
        if h[i] < -shoulder[i, 1]:  # wrist must be above shoulder
            continue
        # arm must be extending (follow-through), not e.g. scratching an ear
        if angle_abc(shoulder[i], elbow[i], wrist[i]) < 140:
            continue
        if apexes and i - apexes[-1] < min_gap:
            if h[i] > h[apexes[-1]]:
                apexes[-1] = i
            continue
        apexes.append(i)
    return apexes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--out-dir", type=Path, default=None)
    args = parser.parse_args()

    import cv2

    out_dir = args.out_dir or args.video.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    backend = get_backend()
    seq = backend.estimate_video(args.video)
    apexes = find_shot_apexes(seq)
    print(f"[split] {args.video.name}: {len(apexes)} shots at "
          f"{[round(seq.frames[a].t_ms / 1000, 1) for a in apexes]}s")

    cap = cv2.VideoCapture(str(args.video))
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    for n_shot, apex in enumerate(apexes, 1):
        t0 = max(seq.frames[apex].t_ms / 1000 - PRE_S, 0)
        t1 = seq.frames[apex].t_ms / 1000 + POST_S
        out_path = out_dir / f"{args.video.stem}_shot{n_shot}.mp4"
        writer = cv2.VideoWriter(out_path, fourcc, seq.fps, (seq.width, seq.height))
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(t0 * seq.fps))
        while cap.get(cv2.CAP_PROP_POS_MSEC) / 1000 <= t1:
            ok, frame = cap.read()
            if not ok:
                break
            writer.write(frame)
        writer.release()
        print(f"[split] wrote {out_path.name} ({t0:.1f}s–{t1:.1f}s)")
    cap.release()


if __name__ == "__main__":
    main()
