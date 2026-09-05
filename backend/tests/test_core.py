"""Artifact integrity and media-retention regression tests."""

import hashlib
import json
from datetime import datetime, timedelta, timezone

from app.core.artifacts import verify_manifest
from app.core.config import Settings
from app.core.retention import cleanup_expired


def test_manifest_verifies_size_and_checksum(tmp_path) -> None:
    artifact = tmp_path / "models" / "pose.pt"
    artifact.parent.mkdir()
    artifact.write_bytes(b"model-bytes")
    manifest = tmp_path / "infra" / "artifacts.json"
    manifest.parent.mkdir()
    manifest.write_text(
        json.dumps(
            {
                "artifacts": [
                    {
                        "path": "models/pose.pt",
                        "size": artifact.stat().st_size,
                        "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                    }
                ]
            }
        )
    )

    assert verify_manifest(manifest) == []
    artifact.write_bytes(b"changed")
    assert "size mismatch" in verify_manifest(manifest)[0]


def test_cleanup_removes_expired_media_but_retains_report(tmp_path) -> None:
    cfg = Settings(data_dir=tmp_path)
    for directory in (cfg.analyses_dir, cfg.uploads_dir, cfg.keypoints_dir):
        directory.mkdir(parents=True)
    analysis_id = "a" * 12
    report = cfg.analyses_dir / f"{analysis_id}.json"
    report.write_text(
        json.dumps(
            {
                "media_expires_at": (
                    datetime.now(timezone.utc) - timedelta(minutes=1)
                ).isoformat()
            }
        )
    )
    upload = cfg.uploads_dir / f"{analysis_id}.mp4"
    replay = cfg.keypoints_dir / f"{analysis_id}.json"
    upload.write_bytes(b"clip")
    replay.write_text("{}")

    assert cleanup_expired(cfg) == 2
    assert report.exists()
    assert not upload.exists()
    assert not replay.exists()
