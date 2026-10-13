"""Manual training history; saving shooting outcomes never runs pose inference."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import ValidationError

from app.api.validation import StringDetailRoute, validation_detail
from app.core.config import Settings, get_settings
from app.schemas.training import TrainingSession, TrainingSessionCreate, TrainingSessionList
from app.training import store

router = APIRouter(route_class=StringDetailRoute)
Cfg = Annotated[Settings, Depends(get_settings)]


@router.post("/training/sessions", response_model=TrainingSession, status_code=201)
def create_session(body: TrainingSessionCreate, response: Response, cfg: Cfg) -> TrainingSession:
    try:
        body = TrainingSessionCreate.model_validate(body)
    except ValidationError as exc:
        raise HTTPException(422, validation_detail(exc.errors())) from exc
    try:
        session, created = store.create_session(cfg, body)
    except store.SessionConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except store.TrainingStorageError as exc:
        raise HTTPException(503, str(exc), headers={"Retry-After": "5"}) from exc
    response.status_code = 201 if created else 200
    return session


@router.get("/training/sessions", response_model=TrainingSessionList)
def list_sessions(cfg: Cfg, limit: Annotated[int, Query(ge=1, le=100)] = 100) -> TrainingSessionList:
    try:
        return store.list_sessions(cfg, limit=limit)
    except store.TrainingStorageError as exc:
        raise HTTPException(503, str(exc), headers={"Retry-After": "5"}) from exc
