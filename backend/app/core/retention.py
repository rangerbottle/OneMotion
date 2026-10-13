"""Expire media on access and recover abandoned local analysis artifacts."""

import json
import logging
import re
import shutil
import stat
from datetime import datetime, timezone

from app.core.config import Settings
from app.core.storage import analysis_lock, atomic_write

logger = logging.getLogger(__name__)
SOURCE_DIRECTORY_RE = re.compile(r"\.([a-f0-9]{12,32})-source-[a-zA-Z0-9_-]+")


def media_expired(expires_at: datetime | str | None) -> bool:
    if expires_at is None:
        return False  # Legacy reports without a deadline are handled during cleanup.
    expires = datetime.fromisoformat(expires_at) if isinstance(expires_at, str) else expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) >= expires


def _cleanup_source_imports(cfg: Settings, now: float, ttl: float) -> int:
    """Recover HomeCourt originals abandoned before TemporaryDirectory cleanup."""
    removed = 0
    for directory in (cfg.uploads_dir, cfg.compare_videos_dir):
        if directory.is_symlink():
            continue
        for path in directory.glob(".*-source-*"):
            match = SOURCE_DIRECTORY_RE.fullmatch(path.name)
            if match is None:
                continue
            # Both upload routes hold this exact entity-id lock while importing.
            # Age alone cannot distinguish a crashed process from active work.
            with analysis_lock(cfg.data_dir, match[1], blocking=False) as acquired:
                if not acquired:
                    continue
                try:
                    info = path.lstat()
                    if not stat.S_ISDIR(info.st_mode) or now - info.st_mtime < ttl:
                        continue
                    # rmtree unlinks child symlinks rather than following them;
                    # lstat above also excludes a symlink to the source directory.
                    shutil.rmtree(path)
                    removed += 1
                except (FileNotFoundError, PermissionError):
                    # A concurrent sweep or an open Windows file can defer cleanup.
                    pass
                except OSError:
                    logger.exception("Could not expire source import %s", path.name)
    return removed


def cleanup_expired(cfg: Settings) -> int:
    removed = 0
    now = datetime.now(timezone.utc).timestamp()
    ttl = cfg.media_ttl_hours * 3600
    for result_path in cfg.analyses_dir.glob("*.json"):
        with analysis_lock(cfg.data_dir, result_path.stem, blocking=False) as acquired:
            if not acquired:
                continue
            try:
                payload = json.loads(result_path.read_text(encoding="utf-8"))
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
                except (FileNotFoundError, PermissionError):
                    # Windows holds media files open while a response streams;
                    # a failed unlink here just means "try again next sweep".
                    pass
    return removed + _cleanup_source_imports(cfg, now, ttl)
