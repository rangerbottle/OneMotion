"""Atomic, immutable local training records with UUID-scoped idempotency."""

import heapq
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from app.core.config import Settings
from app.core.storage import analysis_lock, atomic_write
from app.schemas.training import (
    TrainingSession,
    TrainingSessionCreate,
    TrainingSessionList,
    TrainingSummary,
    TrainingTotals,
)

logger = logging.getLogger(__name__)


class SessionConflict(ValueError):
    """The idempotency UUID already belongs to different outcomes or metadata."""


class TrainingStorageError(RuntimeError):
    """Storage could not be read or written; clients can retry the same UUID."""


def derive_totals(session: TrainingSessionCreate) -> TrainingTotals:
    attempts = sum(len(group.attempts) for group in session.sets)
    makes = sum(sum(group.attempts) for group in session.sets)
    return TrainingTotals(
        attempts=attempts,
        makes=makes,
        accuracy_pct=100 * makes / attempts if attempts else None,
        duration_ms=session.duration_ms,
        completed_sets=sum(len(group.attempts) == session.planned_reps for group in session.sets),
    )


def _read(path: Path) -> TrainingSession:
    session = TrainingSession.model_validate_json(path.read_text(encoding="utf-8"))
    if path.stem != str(session.session_id) or session.totals != derive_totals(session):
        raise ValueError("training record does not match its identity or outcomes")
    return session


def create_session(cfg: Settings, request: TrainingSessionCreate) -> tuple[TrainingSession, bool]:
    """Return (record, newly_created), preserving the original successful response."""
    try:
        cfg.training_sessions_dir.mkdir(parents=True, exist_ok=True)
        session_id = str(request.session_id)
        path = cfg.training_sessions_dir / f"{session_id}.json"
        # Reuse fixed lock stripes; training is outside the media-retention tree.
        with analysis_lock(cfg.data_dir, f"training:{session_id}"):
            try:
                previous = _read(path)
            except FileNotFoundError:
                previous = None
            if previous is not None:
                fields = set(TrainingSessionCreate.model_fields)
                if previous.model_dump(mode="json", include=fields) != request.model_dump(mode="json"):
                    raise SessionConflict("session UUID already has different recorded data")
                return previous, False
            session = TrainingSession(
                **request.model_dump(), created_at=datetime.now(timezone.utc),
                totals=derive_totals(request),
            )
            atomic_write(path, session.model_dump_json(indent=2))
            return session, True
    except SessionConflict:
        raise
    except (OSError, ValueError) as exc:
        logger.exception("Training session storage failed")
        raise TrainingStorageError("training storage is unavailable") from exc


def list_sessions(cfg: Settings, *, limit: int = 100) -> TrainingSessionList:
    """Bound the returned history while summarizing every persisted local record."""
    try:
        latest = []
        count = completed = attempts = makes = duration = 0
        try:
            entries = os.scandir(cfg.training_sessions_dir)
        except FileNotFoundError:
            # Only missing storage means an empty history. scandir surfaces
            # permission and non-directory errors instead of glob hiding them.
            entries = None
        if entries is not None:
            with entries:
                for entry in entries:
                    if not entry.name.endswith(".json"):
                        continue
                    record = _read(Path(entry.path))
                    count += 1
                    completed += record.status == "completed"
                    attempts += record.totals.attempts
                    makes += record.totals.makes
                    duration += record.totals.duration_ms
                    key = (record.completed_at, record.created_at, str(record.session_id))
                    item = (key, record)
                    # Retain at most limit heavy outcome arrays while computing
                    # an exact all-history summary; history has no expiry.
                    if len(latest) < limit:
                        heapq.heappush(latest, item)
                    elif key > latest[0][0]:
                        heapq.heapreplace(latest, item)
        records = [record for _, record in sorted(latest, key=lambda item: item[0], reverse=True)]
        return TrainingSessionList(
            sessions=records,
            summary=TrainingSummary(
                sessions=count,
                completed_sessions=completed,
                attempts=attempts,
                makes=makes,
                accuracy_pct=100 * makes / attempts if attempts else None,
                duration_ms=duration,
            ),
            has_more=count > limit,
        )
    except (OSError, ValueError) as exc:
        logger.exception("Training history storage failed")
        raise TrainingStorageError("training storage is unavailable") from exc
