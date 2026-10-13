"""Bounded manual shooting records; outcomes, rather than client totals, are input."""

from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from pydantic import (
    AwareDatetime,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictBool,
    UUID4,
    field_validator,
    model_validator,
)

DrillId = Literal[
    "close-form", "guide-hand", "follow-through", "free-throw", "five-spots",
    "baseline-corners", "distance-ladder", "star-rotation", "catch-and-shoot",
    "one-dribble", "relocation", "one-motion-rhythm",
]
SessionStatus = Literal["completed", "partial"]
MAX_SETS = 20
MAX_REPS = 100
# This is wall-clock record duration, including breaks and a restored closed tab.
# It is not an estimate of time actively exercising.
MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000


def _iso_datetime(value: object) -> object:
    # AwareDatetime also accepts numeric Unix timestamps by default. This API
    # requires an explicit ISO clock with an offset, including during retries.
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or len(value) > 64:
        raise ValueError("use a timezone-aware ISO datetime")
    return value


SessionDatetime = Annotated[AwareDatetime, BeforeValidator(_iso_datetime)]


class TrainingSet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    attempts: list[StrictBool] = Field(max_length=MAX_REPS)


class TrainingSessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: UUID4
    drill_id: DrillId
    started_at: SessionDatetime
    completed_at: SessionDatetime
    planned_sets: int = Field(strict=True, ge=1, le=MAX_SETS)
    planned_reps: int = Field(strict=True, ge=1, le=MAX_REPS)
    sets: list[TrainingSet] = Field(max_length=MAX_SETS)
    status: SessionStatus

    @field_validator("started_at", "completed_at")
    @classmethod
    def utc_clock(cls, value: datetime) -> datetime:
        try:
            return value.astimezone(timezone.utc)
        except (OverflowError, ValueError) as exc:
            raise ValueError("datetime cannot be represented in UTC") from exc

    @model_validator(mode="after")
    def matches_plan(self) -> "TrainingSessionCreate":
        elapsed = self.completed_at - self.started_at
        if not timedelta() <= elapsed <= timedelta(milliseconds=MAX_DURATION_MS):
            raise ValueError("session must last between zero and seven days")
        if len(self.sets) > self.planned_sets:
            raise ValueError("recorded sets exceed the plan")
        if any(len(group.attempts) > self.planned_reps for group in self.sets):
            raise ValueError("recorded attempts exceed the planned repetitions")
        if any(len(group.attempts) != self.planned_reps for group in self.sets[:-1]):
            raise ValueError("finish each earlier set before recording the next set")
        if self.status == "completed" and (
            len(self.sets) != self.planned_sets
            or any(len(group.attempts) != self.planned_reps for group in self.sets)
        ):
            raise ValueError("a completed session must finish every planned set")
        return self

    @property
    def duration_ms(self) -> int:
        elapsed = self.completed_at - self.started_at
        return (elapsed.days * 86_400 + elapsed.seconds) * 1000 + elapsed.microseconds // 1000


class TrainingTotals(BaseModel):
    model_config = ConfigDict(extra="forbid")

    attempts: int = Field(strict=True, ge=0, le=MAX_SETS * MAX_REPS)
    makes: int = Field(strict=True, ge=0, le=MAX_SETS * MAX_REPS)
    accuracy_pct: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    duration_ms: int = Field(strict=True, ge=0, le=MAX_DURATION_MS)
    completed_sets: int = Field(strict=True, ge=0, le=MAX_SETS)


class TrainingSession(TrainingSessionCreate):
    created_at: SessionDatetime
    totals: TrainingTotals

    @field_validator("created_at")
    @classmethod
    def created_utc_clock(cls, value: datetime) -> datetime:
        return cls.utc_clock(value)


class TrainingSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sessions: int = Field(strict=True, ge=0)
    completed_sessions: int = Field(strict=True, ge=0)
    attempts: int = Field(strict=True, ge=0)
    makes: int = Field(strict=True, ge=0)
    accuracy_pct: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    duration_ms: int = Field(strict=True, ge=0)


class TrainingSessionList(BaseModel):
    sessions: list[TrainingSession] = Field(max_length=100)
    summary: TrainingSummary
    has_more: bool
