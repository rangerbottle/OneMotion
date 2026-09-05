"""Curry comparison-template registry and canonical media."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from app.benchmarks.templates import (
    ACTIVE_TEMPLATE_ID,
    list_templates,
    load_template,
    template_video_path,
)
from app.core.config import Settings, get_settings
from app.schemas.template import TemplateSummary

router = APIRouter()
Cfg = Annotated[Settings, Depends(get_settings)]


def _require_active(template_id: str) -> None:
    if template_id != ACTIVE_TEMPLATE_ID:
        raise HTTPException(
            410,
            f"template '{template_id}' is retired; use {ACTIVE_TEMPLATE_ID}",
        )


@router.get("/templates", response_model=list[TemplateSummary])
def templates(cfg: Cfg) -> list[TemplateSummary]:
    return list_templates(cfg)


@router.get("/templates/{template_id}", response_model=TemplateSummary)
def template(template_id: str, cfg: Cfg) -> TemplateSummary:
    _require_active(template_id)
    for item in list_templates(cfg):
        if item.template_id == template_id:
            return item
    raise HTTPException(404, f"no template '{template_id}'")


@router.get("/templates/{template_id}/video")
def template_video(template_id: str, cfg: Cfg) -> FileResponse:
    _require_active(template_id)
    try:
        profile = load_template(cfg, template_id)
    except (FileNotFoundError, ValueError):
        raise HTTPException(404, f"no template '{template_id}'")
    path = template_video_path(cfg, profile)
    if path is None:
        raise HTTPException(404, f"template '{template_id}' has no replay video")
    return FileResponse(path, media_type="video/mp4", filename=path.name)
