"""Build a media-free GitHub snapshot and a separate private local snapshot.

Uses only the Python standard library and local Git reads. Never downloads,
uploads, changes the active artifact release, or copies Git history.
"""

import argparse
import hashlib
import json
import os
import stat
import subprocess
import tempfile
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".mpeg", ".mpg", ".ogv"}
PRIVATE_PARTS = {".git", ".run", ".venv", "node_modules", ".next", "__pycache__",
                 ".pytest_cache", ".ruff_cache", "test-results", "playwright-report", "dist"}
MODEL_EXTENSIONS = {".pt", ".pth", ".onnx", ".tflite"}
PINNED = {"models/yolo11n-pose.pt", "data/benchmarks/curry_v3.json",
          "data/raw_videos/curry/curry_v3_reference.mp4"}
WRITABLE_DIRS = ["data/analyses", "data/uploads", "data/keypoints", "data/.locks",
                 "data/training/sessions", *[f"data/compare/{item}" for item in
                 ("players", "templates", "clips", "videos", "comparisons", "reports")]]


def digest_file(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def safe_file(root: Path, name: str) -> Path:
    relative = Path(name)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"unsafe bundle path: {name}")
    path = root / relative
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != root):
        raise ValueError(f"symlink not allowed in bundle: {name}")
    if not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"missing or external bundle file: {name}")
    return path


def disposable(name: str) -> bool:
    p = Path(name)
    return (any(part in PRIVATE_PARTS for part in p.parts) or p.name == ".DS_Store"
            or p.suffix in {".pyc", ".pyo", ".tmp", ".part", ".log", ".tsbuildinfo"}
            or p.name == ".generated.json" or ".tmp." in p.name)


def public_file(name: str) -> bool:
    p = Path(name)
    if disposable(name) or p.suffix.lower() in VIDEO_EXTENSIONS | MODEL_EXTENSIONS | {".zip", ".pem", ".key", ".pfx"}:
        return False
    if p.name.startswith(".env") and p.name != ".env.example":
        return False
    return not ((p.parts[0] in {"data", "models"} and name != "data/.gitkeep") or name == "infra/artifacts.json")


def media_header(header: bytes) -> bool:
    return (header[4:8] == b"ftyp" or header.startswith(b"\x1aE\xdf\xa3")
            or (header.startswith(b"RIFF") and header[8:12] == b"AVI "))


def source_files(root: Path) -> list[str]:
    # Include newly authored, non-ignored source files as well as tracked files.
    result = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                            cwd=root, check=True, capture_output=True)
    return sorted({name for name in result.stdout.decode().split("\0")
                   if name and public_file(name) and (root / name).is_file()})


def select_files(root: Path, kind: str, sources: list[str]) -> list[str]:
    files = {name for name in sources if public_file(name)}
    if kind == "local":
        for folder in (root / "data", root / "models", root / "apps/web/tests/fixtures"):
            if not folder.exists():
                continue
            for base, dirs, names in os.walk(folder, followlinks=False):
                dirs[:] = [d for d in dirs if d not in PRIVATE_PARTS and d != ".locks"]
                for name in names:
                    relative = (Path(base) / name).relative_to(root).as_posix()
                    if not disposable(relative) and (folder != root / "apps/web/tests/fixtures" or Path(name).suffix.lower() in VIDEO_EXTENSIONS):
                        files.add(relative)
        files.add("infra/artifacts.json")
    elif kind != "github":
        raise ValueError(f"unknown package kind: {kind}")
    for name in files:
        safe_file(root, name)
    return sorted(files)


def verify_local_artifacts(root: Path) -> None:
    manifest = json.loads(safe_file(root, "infra/artifacts.json").read_text(encoding="utf-8"))
    if manifest.get("active_template") != "curry_v3":
        raise ValueError("local package requires the existing curry_v3 release")
    entries = manifest["artifacts"]
    if not PINNED.issubset({entry["path"] for entry in entries}):
        raise ValueError("local release manifest is missing required pins")
    for entry in entries:
        path = safe_file(root, entry["path"])
        if path.stat().st_size != entry.get("size") or digest_file(path) != entry["sha256"]:
            raise ValueError(f"local artifact integrity failure: {entry['path']}")


def source_links(root: Path) -> dict:
    catalog = json.loads((root / "docs/research/curry-reference-candidates.json").read_text(encoding="utf-8"))
    return {
        "schema_version": 1, "rights_status": "unverified; links do not grant redistribution permission",
        "active_reference": {"id": "curry_v3", "url": "https://www.bilibili.com/video/BV14u411J7qS/",
                             "upstream_url": "https://www.youtube.com/shorts/7Glg7bmKUsQ", "timing_mode": "unknown"},
        "candidates": [{key: item[key] for key in ("id", "url", "title", "publisher", "source_family", "review_status", "timing")}
                       for item in catalog["candidates"]],
        "related_sources": [{key: item[key] for key in ("url", "title", "source_family", "linked_original", "use")}
                            for item in catalog["related_sources"]],
    }


def verify_archive(path: Path, prefix: str, kind: str) -> dict:
    with zipfile.ZipFile(path) as archive:
        if archive.testzip():
            raise ValueError("archive CRC verification failed")
        manifest = json.loads(archive.read(f"{prefix}/PACKAGE_CONTENTS.json"))
        expected = {f"{prefix}/{item['path']}" for item in manifest["files"]}
        expected |= {f"{prefix}/PACKAGE_CONTENTS.json", f"{prefix}/VIDEO_SOURCES.json"}
        actual = {item.filename for item in archive.infolist() if not item.is_dir()}
        if actual != expected or len(archive.namelist()) != len(set(archive.namelist())):
            raise ValueError("archive inventory does not match")
        for item in archive.infolist():
            p = Path(item.filename)
            if p.is_absolute() or ".." in p.parts or stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError("unsafe archive member")
            if kind == "github" and not item.is_dir() and not public_file(p.relative_to(prefix).as_posix()):
                raise ValueError(f"private file in GitHub package: {item.filename}")
        for entry in manifest["files"]:
            with archive.open(f"{prefix}/{entry['path']}") as source:
                if hashlib.file_digest(source, "sha256").hexdigest() != entry["sha256"]:
                    raise ValueError(f"archive content hash failure: {entry['path']}")
            if kind == "github":
                with archive.open(f"{prefix}/{entry['path']}") as source:
                    if media_header(source.read(16)):
                        raise ValueError("video content disguised as a source file")
        return manifest


def build_bundle(root: Path, kind: str, sources: list[str], destination: Path, revision: str) -> dict:
    if destination.exists():
        raise FileExistsError(f"refusing to replace existing bundle: {destination}")
    if kind == "local":
        verify_local_artifacts(root)
    files = select_files(root, kind, sources)
    prefix = f"OneMotion-{kind}"
    manifest = {"schema_version": 1, "kind": kind, "source_revision": revision,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "distribution": "source_only" if kind == "github" else "private_local_only",
                "video_files_included": sum(Path(name).suffix.lower() in VIDEO_EXTENSIONS for name in files),
                "downloads_performed": False,
                "dependencies_bundled": False,
                "files": [{"path": name, "size": safe_file(root, name).stat().st_size,
                           "sha256": digest_file(root / name)} for name in files]}
    links = source_links(root)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name in files:
                method = zipfile.ZIP_STORED if Path(name).suffix.lower() in VIDEO_EXTENSIONS | MODEL_EXTENSIONS | {".png"} else zipfile.ZIP_DEFLATED
                archive.write(root / name, f"{prefix}/{name}", compress_type=method)
            for name, data in (("PACKAGE_CONTENTS.json", manifest), ("VIDEO_SOURCES.json", links)):
                archive.writestr(f"{prefix}/{name}", json.dumps(data, ensure_ascii=False, indent=2) + "\n")
            for name in WRITABLE_DIRS:
                archive.writestr(f"{prefix}/{name}/", b"")
        verify_archive(temporary, prefix, kind)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return {"archive": destination.name, "size_bytes": destination.stat().st_size,
            "sha256": digest_file(destination), "source_files": len(files),
            "video_files": manifest["video_files_included"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", choices=("github", "local", "both"), default="both")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    parser.add_argument("--date", default=date.today().isoformat())
    args = parser.parse_args()
    date.fromisoformat(args.date)
    sources = source_files(ROOT)
    revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    results = []
    for kind in (("github", "local") if args.kind == "both" else (args.kind,)):
        results.append(build_bundle(ROOT, kind, sources, args.output / f"OneMotion-{kind}-{args.date}.zip", revision))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
