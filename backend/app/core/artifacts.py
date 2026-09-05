"""Immutable local artifact manifest verification."""

import hashlib
import json
from pathlib import Path


def verify_manifest(manifest_path: Path) -> list[str]:
    if not manifest_path.is_file():
        return [f"artifact manifest missing: {manifest_path}"]
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return [f"artifact manifest is invalid: {exc}"]
    root = manifest_path.parent.parent
    failures = []
    for artifact in manifest.get("artifacts", []):
        path = root / artifact["path"]
        if not path.is_file():
            failures.append(f"artifact missing: {path}")
            continue
        expected_size = artifact.get("size")
        if expected_size is not None and path.stat().st_size != expected_size:
            failures.append(f"artifact size mismatch: {path}")
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != artifact.get("sha256"):
            failures.append(f"artifact checksum mismatch: {path}")
    return failures
