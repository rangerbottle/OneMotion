"""Pin a reviewed local model/profile/video release, or check the current manifest."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.benchmarks.provenance import file_sha256
from app.benchmarks.templates import ACTIVE_TEMPLATE_ID, load_template, template_video_path
from app.core.artifacts import verify_manifest
from app.core.config import settings
from app.core.storage import atomic_write


def release(manifest_path: Path) -> None:
    profile = load_template(settings, ACTIVE_TEMPLATE_ID)
    video = template_video_path(settings, profile)
    if video is None or not profile.provenance:
        raise ValueError("build the reference with an input manifest before publishing")
    root = manifest_path.resolve().parent.parent
    paths = [settings.model_path, settings.benchmark_path, video]
    entries = [{"id": path.stem, "path": path.resolve().relative_to(root).as_posix(),
                "size": path.stat().st_size, "sha256": file_sha256(path)} for path in paths]
    atomic_write(manifest_path, json.dumps({
        "schema_version": 1, "active_template": ACTIVE_TEMPLATE_ID, "distribution": "local_only",
        "notes": "Reference media must not be redistributed until its reuse rights are confirmed.",
        "artifacts": entries,
    }, indent=2) + "\n")
    # atomic_write lands 0600 (tempfile default); the manifest is non-sensitive
    # (paths + sizes + checksums) and compose.yaml bind-mounts it read-only into
    # the API container, which runs as a different uid and must be able to read it.
    manifest_path.chmod(0o644)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=settings.artifact_manifest)
    parser.add_argument("--check", action="store_true", help="verify without changing the release")
    args = parser.parse_args()
    if args.check:
        failures = verify_manifest(args.manifest)
        if failures:
            raise SystemExit("\n".join(failures))
    else:
        release(args.manifest)
    print("Artifact release verified." if args.check else "Pinned model, benchmark and video release.")


if __name__ == "__main__":
    main()
