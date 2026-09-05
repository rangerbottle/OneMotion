"""Curry benchmark build/load (docs/ARCHITECTURE.md §4).

`build_benchmark` turns a folder of Curry clips into a versioned benchmark
profile JSON: per-clip pose extraction → phase segmentation → metrics, then
median/IQR aggregation across clips. The clip closest to the median profile
is kept as the canonical sequence for skeleton overlay replay.

`load_benchmark` is used read-only by the API when answering analysis
requests.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from app.analysis.metrics import compute_all
from app.analysis.phases import segment
from app.schemas.benchmark import BenchmarkProfile, MetricStats, PhaseTiming
from app.schemas.pose import ShotSequence

CLIP_EXTENSIONS = {".mp4", ".mov", ".webm"}


def analyze_clip(
    backend, clip_path: Path
) -> tuple[ShotSequence, list, dict[str, float]]:
    """Pose → phases → metrics for one clip."""
    sequence = backend.estimate_video(clip_path)
    phases = segment(sequence)
    return sequence, phases, compute_all(sequence, phases)


def build_benchmark(
    clips_dir: Path,
    out_path: Path,
    clips: list[Path] | None = None,
) -> BenchmarkProfile:
    """Turn a folder of Curry clips into a versioned benchmark profile JSON."""
    from app.pose import get_backend

    clips = clips or sorted(
        p for p in clips_dir.iterdir() if p.suffix.lower() in CLIP_EXTENSIONS
    )
    clips = [path for path in clips if path.suffix.lower() in CLIP_EXTENSIONS]
    if not clips:
        raise FileNotFoundError(f"no clips found in {clips_dir}")

    backend = get_backend()
    sequences: dict[str, ShotSequence] = {}
    all_phases = {}
    all_metrics: dict[str, dict[str, float]] = {}
    for clip in clips:
        print(f"[benchmark] processing {clip.name} …")
        seq, phases, metrics = analyze_clip(backend, clip)
        sequences[clip.stem] = seq
        all_phases[clip.stem] = phases
        all_metrics[clip.stem] = metrics
        print(f"[benchmark] {clip.stem}: {metrics}")

    # Aggregate metrics: median + IQR across clips. Metric sets differ per
    # clip (unreliable ones are omitted per clip), so take the union and
    # aggregate each metric over the clips that actually produced it.
    metric_names = sorted({name for m in all_metrics.values() for name in m})
    stats = {}
    for name in metric_names:
        values = [m[name] for m in all_metrics.values() if name in m]
        stats[name] = MetricStats(
            median=float(np.median(values)),
            p25=float(np.percentile(values, 25)),
            p75=float(np.percentile(values, 75)),
            n=len(values),
        )

    # Median phase durations across clips.
    timing = []
    for phase in ("dip", "load", "lift", "release", "follow_through"):
        durations = []
        for clip_id, phases in all_phases.items():
            seg = next(s for s in phases if s.phase == phase)
            frames = sequences[clip_id].frames
            durations.append(
                (frames[seg.end_frame].t_ms - frames[seg.start_frame].t_ms) / 1000.0
            )
        timing.append(
            PhaseTiming(phase=phase, median_duration_s=float(np.median(durations)))
        )

    # Canonical clip: smallest distance to the median profile.
    def distance(metrics: dict[str, float]) -> float:
        return sum(
            abs(metrics[name] - stats[name].median) / (abs(stats[name].median) + 1e-9)
            for name in metric_names
            if name in metrics
        )

    canonical_id = min(all_metrics, key=lambda c: distance(all_metrics[c]))

    profile = BenchmarkProfile(
        version=out_path.stem,
        created_at=datetime.now(timezone.utc),
        source_clips=list(sequences.keys()),
        backend=backend.name,
        metrics=stats,
        phase_timing=timing,
        canonical_clip_id=canonical_id,
        canonical_sequence=sequences[canonical_id],
        canonical_phases=all_phases[canonical_id],
    )
    if out_path.stem == "curry_v3":
        profile = profile.model_copy(
            update={
                "display_name": "Curry v3 — Real time / form + timing",
                "description": (
                    "Fixed-camera full-body reference from the first three seconds "
                    "of BV14u411J7qS. This is a single-shot reference, not a "
                    "population confidence interval."
                ),
                "source_url": "https://www.bilibili.com/video/BV14u411J7qS/",
                "clip_start_ms": 0,
                "clip_end_ms": 3000,
                "timing_mode": "realtime",
                "time_scale_to_realtime": 1.0,
                "timing_reliable": True,
                "template_kind": "single_reference",
                "canonical_video_filename": "curry_v3_reference.mp4",
            }
        )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(profile.model_dump_json(indent=2))
    print(f"[benchmark] wrote {out_path} (canonical clip: {canonical_id})")
    return profile


def load_benchmark(path: Path) -> BenchmarkProfile:
    """Load a benchmark profile; raises FileNotFoundError if never built."""
    if not path.exists():
        raise FileNotFoundError(
            f"no benchmark at {path} — run scripts/build_curry_benchmark.py"
        )
    return BenchmarkProfile.model_validate(json.loads(path.read_text()))
