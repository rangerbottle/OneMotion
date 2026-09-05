"""Template registry layered over versioned benchmark artifacts."""

from pathlib import Path

from app.benchmarks.curry import load_benchmark
from app.core.config import Settings
from app.schemas.benchmark import BenchmarkProfile
from app.schemas.template import TemplateSummary

ACTIVE_TEMPLATE_ID = "curry_v3"

_METADATA: dict[str, dict] = {
    "curry_v3": {
        "display_name": "Curry v3 — Real time / form + timing",
        "description": "Fixed-camera full-body reference from the first three seconds of BV14u411J7qS.",
        "source_url": "https://www.bilibili.com/video/BV14u411J7qS/",
        "clip_start_ms": 0,
        "clip_end_ms": 3000,
        "timing_mode": "realtime",
        "time_scale_to_realtime": 1.0,
        "timing_reliable": True,
        "template_kind": "single_reference",
        "canonical_video_filename": "curry_v3_reference.mp4",
    },
}


def _validate_template_id(template_id: str) -> str:
    if template_id != ACTIVE_TEMPLATE_ID:
        raise ValueError(f"template '{template_id}' is retired; use {ACTIVE_TEMPLATE_ID}")
    return template_id


def decorate_template(profile: BenchmarkProfile) -> BenchmarkProfile:
    """Apply registry metadata while keeping old JSON artifacts compatible."""
    override = _METADATA.get(profile.version, {})
    updates = {key: value for key, value in override.items() if value is not None}
    if not updates.get("canonical_video_filename"):
        updates["canonical_video_filename"] = f"{profile.canonical_clip_id}.mp4"
    return profile.model_copy(update=updates)


def load_template(cfg: Settings, template_id: str) -> BenchmarkProfile:
    template_id = _validate_template_id(template_id)
    return decorate_template(load_benchmark(cfg.benchmarks_dir / f"{template_id}.json"))


def template_video_path(cfg: Settings, profile: BenchmarkProfile) -> Path | None:
    filename = profile.canonical_video_filename
    if filename:
        candidate = cfg.raw_videos_dir / filename
        if candidate.is_file():
            return candidate
    for extension in (".mp4", ".mov", ".webm"):
        candidate = cfg.raw_videos_dir / f"{profile.canonical_clip_id}{extension}"
        if candidate.is_file():
            return candidate
    return None


def list_templates(cfg: Settings) -> list[TemplateSummary]:
    try:
        profiles = [load_template(cfg, ACTIVE_TEMPLATE_ID)]
    except FileNotFoundError:
        profiles = []
    return [
        TemplateSummary(
            template_id=profile.version,
            display_name=profile.display_name or profile.version,
            description=profile.description or "Curry shooting reference",
            timing_mode=profile.timing_mode,
            timing_reliable=profile.timing_reliable,
            time_scale_to_realtime=profile.time_scale_to_realtime,
            template_kind=profile.template_kind,
            sample_count=max(
                (stats.n for stats in profile.metrics.values()), default=0
            ),
            source_url=profile.source_url,
            clip_start_ms=profile.clip_start_ms,
            clip_end_ms=profile.clip_end_ms,
            video_url=(
                f"/api/v1/templates/{profile.version}/video"
                if template_video_path(cfg, profile)
                else None
            ),
            is_default=True,
        )
        for profile in profiles
    ]
