"""Expire media on access and recover abandoned local analysis artifacts."""

import json
import logging
from datetime import datetime, timezone

from app.core.config import Settings
from app.core.storage import analysis_lock, atomic_write

logger = logging.getLogger(__name__)


def media_expired(expires_at: datetime | str | None) -> bool:
    if expires_at is None:
        return False  # Legacy reports without a deadline are handled during cleanup.
    expires = datetime.fromisoformat(expires_at) if isinstance(expires_at, str) else expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) >= expires


def cleanup_expired(cfg: Settings) -> int:
    removed = 0
    now = datetime.now(timezone.utc).timestamp()
    ttl = cfg.media_ttl_hours * 3600
    for result_path in cfg.analyses_dir.glob("*.json"):
        with analysis_lock(cfg.data_dir, result_path.stem, blocking=False) as acquired:
            if not acquired:
                continue
            try:
                payload = json.loads(result_path.read_text())
                expires = payload.get("media_expires_at")
                if expires is None:
                    expires = datetime.fromtimestamp(result_path.stat().st_mtime + ttl, timezone.utc).isoformat()
                    payload["media_expires_at"] = expires
                    atomic_write(result_path, json.dumps(payload))
                if not media_expired(expires):
                    continue
                for path in [cfg.keypoints_dir / result_path.name, *cfg.uploads_dir.glob(f"{result_path.stem}.*")]:
                    if path.is_file():
                        path.unlink()
                        removed += 1
                if payload.get("player_sequence") is not None or payload.get("benchmark_sequence") is not None:
                    payload.update(player_sequence=None, benchmark_sequence=None)
                    atomic_write(result_path, json.dumps(payload))
            except (OSError, ValueError, TypeError):
                logger.exception("Could not expire analysis %s", result_path.stem)
    # A crash before report commit must not retain videos forever. Active work holds
    # this lock; age avoids deleting newly uploaded or temporarily unassociated files.
    for directory in (cfg.uploads_dir, cfg.keypoints_dir, cfg.analyses_dir):
        for path in directory.glob("*"):
            if not path.is_file():
                continue
            analysis_id = path.name.split(".")[0]
            with analysis_lock(cfg.data_dir, analysis_id, blocking=False) as acquired:
                if not acquired:
                    continue
                try:
                    if now - path.stat().st_mtime < ttl:
                        continue
                    report = cfg.analyses_dir / f"{analysis_id}.json"
                    if path.suffix == ".tmp" or (directory != cfg.analyses_dir and not report.exists()):
                        path.unlink()
                        removed += 1
                except FileNotFoundError:
                    pass
    return removed
