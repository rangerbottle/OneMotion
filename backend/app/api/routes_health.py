"""Liveness and dependency-aware readiness probes."""

from typing import Annotated

from fastapi import APIRouter, Depends

from app.benchmarks.templates import ACTIVE_TEMPLATE_ID, load_template, template_video_path
from app.core.artifacts import verify_manifest
from app.core.config import Settings, get_settings

router = APIRouter()
Cfg = Annotated[Settings, Depends(get_settings)]


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/ready")
def ready(cfg: Cfg):
    failures = verify_manifest(cfg.artifact_manifest)
    if cfg.pose_backend == "yolo" and not cfg.model_path.is_file():
        failures.append(f"pose model missing: {cfg.model_path}")
    try:
        profile = load_template(cfg, ACTIVE_TEMPLATE_ID)
        if profile.canonical_sequence is None:
            failures.append("curry_v3 has no canonical pose sequence")
        if template_video_path(cfg, profile) is None:
            failures.append("curry_v3 replay video is missing")
    except (FileNotFoundError, ValueError) as exc:
        failures.append(str(exc))
    try:
        cfg.analyses_dir.mkdir(parents=True, exist_ok=True)
        probe = cfg.analyses_dir / ".ready"
        probe.write_text("ok")
        probe.unlink(missing_ok=True)
    except OSError as exc:
        failures.append(f"data directory is not writable: {exc}")
    if failures:
        from fastapi.responses import JSONResponse

        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "failures": failures},
        )
    return {"status": "ready", "template": ACTIVE_TEMPLATE_ID, "pose_backend": cfg.pose_backend}
