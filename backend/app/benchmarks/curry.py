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

from app.analysis.metrics import compute_all, measurement_evidence
from app.benchmarks.provenance import file_sha256, load_sources
from app.core.storage import atomic_write
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
    evidence = measurement_evidence(sequence, phases)
    metrics = {name: value for name, value in compute_all(sequence, phases).items() if evidence[name]["reliable"]}
    return sequence, phases, metrics


def build_benchmark(
    clips_dir: Path,
    out_path: Path,
    clips: list[Path] | None = None,
    input_manifest: Path | None = None,
) -> BenchmarkProfile:
    """Turn a folder of Curry clips into a versioned benchmark profile JSON."""
    from app.pose import get_backend

    clips = clips or sorted(
        p for p in clips_dir.iterdir() if p.suffix.lower() in CLIP_EXTENSIONS
    )
    clips = [path for path in clips if path.suffix.lower() in CLIP_EXTENSIONS]
    if not clips:
        raise FileNotFoundError(f"no clips found in {clips_dir}")

    if len({path.stem for path in clips}) != len(clips):
        raise ValueError("reference clip IDs must be unique")
    if out_path.stem == "curry_v3" and (len(clips) != 1 or input_manifest is None):
        raise ValueError("curry_v3 requires exactly one clip and an explicit --input-manifest")
    sources = load_sources(input_manifest, clips) if input_manifest else {}
    backend = get_backend()
    sequences: dict[str, ShotSequence] = {}
    all_phases = {}
    all_metrics: dict[str, dict[str, float]] = {}
    for clip in clips:
        print(f"[benchmark] processing {clip.name} …")
        seq, phases, metrics = analyze_clip(backend, clip)
        source = sources.get(clip.stem)
        if source:
            duration = seq.frames[-1].t_ms - seq.frames[0].t_ms + 1000 / seq.fps
            if abs(duration - (source.end_ms - source.start_ms)) > max(100, 2000 / seq.fps):
                raise ValueError(f"reference duration does not match source manifest: {clip.name}")
        if not metrics:
            raise ValueError(f"reference has no reliable metrics: {clip.name}")
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
            if seg.degraded or seg.censored:
                continue
            frames = sequences[clip_id].frames
            durations.append(
                (frames[seg.end_frame].t_ms - frames[seg.start_frame].t_ms) / 1000.0
            )
        if durations:
            timing.append(PhaseTiming(phase=phase, median_duration_s=float(np.median(durations))))

    # Canonical clip: smallest distance to the median profile.
    def distance(metrics: dict[str, float]) -> float:
        return sum(
            abs(metrics[name] - stats[name].median) / (abs(stats[name].median) + 1e-9)
            if name in metrics else 1.0
            for name in metric_names
        ) / max(len(metric_names), 1)

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
    canonical_path = next(path for path in clips if path.stem == canonical_id)
    from app.core.config import settings
    from app.pose.ball_detector import track_window
    canonical_sequence = sequences[canonical_id]
    canonical_sequence.ball_track = track_window(
        settings, canonical_path, all_phases[canonical_id]
    )
    source = sources.get(canonical_id)
    realtime = bool(sources) and all(item.timing_mode == "realtime" for item in sources.values())
    algorithm_files = sorted((Path(__file__).parents[1] / "analysis").glob("*.py"))
    import hashlib
    algorithm_hash = hashlib.sha256(b"".join(path.name.encode() + path.read_bytes() for path in algorithm_files)).hexdigest()
    profile = profile.model_copy(update={
        "display_name": f"{out_path.stem.replace('_', ' ').title()} — {'Form + timing' if realtime else 'Form reference'}",
        "description": "Single-shot reference, not a population confidence interval." if len(clips) == 1 else "Aggregate of explicitly selected reference clips.",
        "source_url": source.source_url if source else None,
        "clip_start_ms": source.start_ms if source else None,
        "clip_end_ms": source.end_ms if source else None,
        "timing_mode": "realtime" if realtime else source.timing_mode if len(clips) == 1 and source else "unknown",
        "time_scale_to_realtime": source.time_scale_to_realtime if source else None,
        "timing_reliable": realtime,
        "template_kind": "single_reference" if len(clips) == 1 else "aggregate",
        "canonical_video_filename": canonical_path.name,
        "provenance": {
            "clips": [item.model_dump() for item in sources.values()],
            "canonical_sha256": file_sha256(canonical_path),
            "model_sha256": file_sha256(settings.model_path) if settings.model_path.is_file() else None,
            "ball_model_sha256": file_sha256(settings.ball_model_path) if settings.ball_model_path.is_file() else None,
            "algorithm_sha256": algorithm_hash,
        },
    })
    atomic_write(out_path, profile.model_dump_json(indent=2))
    print(f"[benchmark] wrote {out_path} (canonical clip: {canonical_id})")
    return profile


def load_benchmark(path: Path) -> BenchmarkProfile:
    """Load a benchmark profile; raises FileNotFoundError if never built."""
    if not path.exists():
        raise FileNotFoundError(
            f"no benchmark at {path} — run scripts/build_curry_benchmark.py"
        )
    return BenchmarkProfile.model_validate(json.loads(path.read_text(encoding="utf-8")))
