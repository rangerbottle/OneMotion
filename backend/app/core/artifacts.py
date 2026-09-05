"""Immutable local artifact manifest verification."""

import hashlib
import json
from pathlib import Path


def verify_manifest(manifest_path: Path, resolved_paths: dict[str, Path] | None = None) -> list[str]:
    if not manifest_path.is_file():
        return [f"artifact manifest missing: {manifest_path}"]
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return [f"artifact manifest is invalid: {exc}"]
    if not isinstance(manifest, dict) or not isinstance(manifest.get("artifacts"), list) or not manifest["artifacts"]:
        return ["artifact manifest must contain a nonempty artifact list"]
    root = manifest_path.parent.parent
    failures = []
    seen = set()
    for artifact in manifest["artifacts"]:
        if not isinstance(artifact, dict) or not isinstance(artifact.get("path"), str):
            failures.append("invalid artifact entry")
            continue
        name = artifact["path"]
        if name in seen:
            failures.append(f"duplicate artifact: {name}")
            continue
        seen.add(name)
        path = (resolved_paths or {}).get(name, root / name)
        if not path.is_file():
            failures.append(f"artifact missing: {path}")
            continue
        expected_size = artifact.get("size")
        if expected_size is not None and path.stat().st_size != expected_size:
            failures.append(f"artifact size mismatch: {path}")
            continue
        with path.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        if digest != artifact.get("sha256"):
            failures.append(f"artifact checksum mismatch: {path}")
    if resolved_paths:
        failures.extend(f"required artifact not pinned: {name}" for name in resolved_paths if name not in seen)
    return failures
