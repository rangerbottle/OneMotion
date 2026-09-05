"""Template registry layered over versioned benchmark artifacts."""

from pathlib import Path

from app.benchmarks.curry import load_benchmark
from app.core.config import Settings
from app.schemas.benchmark import BenchmarkProfile
from app.schemas.template import TemplateSummary

ACTIVE_TEMPLATE_ID = "curry_v3"

def _validate_template_id(template_id: str) -> str:
    if template_id != ACTIVE_TEMPLATE_ID:
        raise ValueError(f"template '{template_id}' is retired; use {ACTIVE_TEMPLATE_ID}")
    return template_id


def decorate_template(profile: BenchmarkProfile) -> BenchmarkProfile:
    """Preserve artifact evidence; a registry ID cannot establish source timing."""
    return profile.model_copy(update={"display_name": profile.display_name or profile.version})


def load_template(cfg: Settings, template_id: str) -> BenchmarkProfile:
    template_id = _validate_template_id(template_id)
    profile = load_benchmark(cfg.benchmarks_dir / f"{template_id}.json")
    if profile.version != template_id:
        raise ValueError("template file and embedded version disagree")
    return decorate_template(profile)


def template_video_path(cfg: Settings, profile: BenchmarkProfile) -> Path | None:
    filename = profile.canonical_video_filename
    if filename:
        if Path(filename).name != filename:
            raise ValueError("canonical video must be a filename inside the reference directory")
        candidate = cfg.raw_videos_dir / filename
        if candidate.is_file():
            expected = profile.provenance.get("canonical_sha256")
            if expected:
                from app.benchmarks.provenance import file_sha256
                if file_sha256(candidate) != expected:
                    raise ValueError("canonical video does not match benchmark provenance")
            return candidate
        return None
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
