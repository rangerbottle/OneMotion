#!/usr/bin/env python
"""Build the versioned Curry benchmark profile from source clips.

Usage:
    uv run python scripts/build_curry_benchmark.py \
        --clip data/raw_videos/curry/curry_v3_reference.mp4 \
        --out data/benchmarks/curry_v3.json

Pipeline: ingest -> pose extraction -> phase segmentation -> metrics ->
aggregate (docs/ARCHITECTURE.md §4).
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.benchmarks.curry import build_benchmark
from app.core.config import settings


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clips-dir", type=Path, default=settings.raw_videos_dir)
    parser.add_argument(
        "--clip",
        type=Path,
        action="append",
        help="build from this exact clip (repeatable); overrides directory scanning",
    )
    parser.add_argument("--out", type=Path, default=settings.benchmark_path)
    parser.add_argument("--input-manifest", type=Path, help="verified source clips, hashes, crop interval and playback speed")
    args = parser.parse_args()

    build_benchmark(args.clips_dir, args.out, clips=args.clip, input_manifest=args.input_manifest)


if __name__ == "__main__":
    main()
