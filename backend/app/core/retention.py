"""Restart-safe cleanup for expired uploaded media and pose replays."""

import json
from datetime import datetime, timezone

from app.core.config import Settings


def cleanup_expired(cfg: Settings) -> int:
    removed = 0
    if not cfg.analyses_dir.is_dir():
        return removed
    now = datetime.now(timezone.utc)
    for result_path in cfg.analyses_dir.glob("*.json"):
        try:
            payload = json.loads(result_path.read_text())
            expires = payload.get("media_expires_at")
            if not expires or datetime.fromisoformat(expires) > now:
                continue
            analysis_id = result_path.stem
            keypoints = cfg.keypoints_dir / f"{analysis_id}.json"
            if keypoints.exists():
                keypoints.unlink()
                removed += 1
            for upload in cfg.uploads_dir.glob(f"{analysis_id}.*"):
                if upload.is_file():
                    upload.unlink()
                    removed += 1
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    return removed
