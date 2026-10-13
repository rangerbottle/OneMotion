"""Abandoned HomeCourt source cleanup must spare active and persistent assets."""

import os
import tempfile
from pathlib import Path

import pytest

from app.compare import store
from app.core.config import Settings
from app.core.retention import cleanup_expired
from app.core.storage import analysis_lock


CLIP_ID = "a" * 32


def source_directory(directory: Path, *, expired: bool = True) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = Path(tempfile.mkdtemp(prefix=f".{CLIP_ID}-source-", dir=directory))
    (path / "original.mov").write_bytes(b"private original")
    (path / "selected.mp4").write_bytes(b"unfinished extraction")
    if expired:
        os.utime(path, (0, 0))
    return path


@pytest.mark.parametrize("directory_name", ["uploads_dir", "compare_videos_dir"])
def test_expired_source_directory_is_removed_without_expiring_compare_assets(tmp_path, directory_name):
    cfg = Settings(data_dir=tmp_path, media_ttl_hours=1)
    source = source_directory(getattr(cfg, directory_name))
    persistent_paths = [
        cfg.compare_videos_dir / f"{CLIP_ID}.mp4",
        cfg.compare_clips_dir / f"{CLIP_ID}.json",
        cfg.compare_clips_dir / f"{CLIP_ID}.pose.json",
    ]
    for path in persistent_paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"persistent history")
        os.utime(path, (0, 0))

    assert cleanup_expired(cfg) == 1
    assert not source.exists()
    assert all(path.read_bytes() == b"persistent history" for path in persistent_paths)
    assert cleanup_expired(cfg) == 0


@pytest.mark.parametrize("directory_name", ["uploads_dir", "compare_videos_dir"])
def test_recent_source_directory_is_kept_even_if_its_files_are_old(tmp_path, directory_name):
    cfg = Settings(data_dir=tmp_path, media_ttl_hours=1)
    source = source_directory(getattr(cfg, directory_name), expired=False)
    os.utime(source / "original.mov", (0, 0))

    assert cleanup_expired(cfg) == 0
    assert (source / "original.mov").read_bytes() == b"private original"


@pytest.mark.parametrize("directory_name", ["uploads_dir", "compare_videos_dir"])
def test_busy_upload_lock_defers_source_cleanup_and_preserves_lock_inodes(tmp_path, directory_name):
    cfg = Settings(data_dir=tmp_path, media_ttl_hours=1)
    source = source_directory(getattr(cfg, directory_name))
    # Exercise the actual wrappers used by each route, not a mocked acquired flag.
    lock = store.lock(cfg, CLIP_ID) if directory_name == "compare_videos_dir" else analysis_lock(cfg.data_dir, CLIP_ID)
    with lock:
        locks = {path.name: path.stat().st_ino for path in (cfg.data_dir / ".locks").glob("*.lock")}
        assert cleanup_expired(cfg) == 0
        assert source.is_dir()
        assert locks == {path.name: path.stat().st_ino for path in (cfg.data_dir / ".locks").glob("*.lock")}

    assert cleanup_expired(cfg) == 1
    assert not source.exists()
    assert locks == {path.name: path.stat().st_ino for path in (cfg.data_dir / ".locks").glob("*.lock")}


@pytest.mark.parametrize("directory_name", ["uploads_dir", "compare_videos_dir"])
def test_source_symlinks_never_remove_external_files_or_directories(tmp_path, directory_name):
    cfg = Settings(data_dir=tmp_path / "data", media_ttl_hours=1)
    directory = getattr(cfg, directory_name)
    source = source_directory(directory)
    outside = tmp_path / "outside"
    outside.mkdir()
    private = outside / "keep.mov"
    private.write_bytes(b"unrelated video")
    os.utime(outside, (0, 0))
    linked_source = directory / f".{'b' * 32}-source-linked"
    try:
        linked_source.symlink_to(outside, target_is_directory=True)
        (source / "linked-directory").symlink_to(outside, target_is_directory=True)
        (source / "linked-file.mov").symlink_to(private)
    except OSError as exc:
        pytest.skip(f"symlinks unavailable: {exc}")
    os.utime(source, (0, 0))

    assert cleanup_expired(cfg) == 1
    assert not source.exists()
    assert linked_source.is_symlink()
    assert private.read_bytes() == b"unrelated video"


@pytest.mark.parametrize("directory_name", ["uploads_dir", "compare_videos_dir"])
def test_cleanup_ignores_unrelated_directories_and_incomplete_source_names(tmp_path, directory_name):
    cfg = Settings(data_dir=tmp_path, media_ttl_hours=1)
    directory = getattr(cfg, directory_name)
    directory.mkdir(parents=True)
    keep = []
    for name in ("training", f"{CLIP_ID}-source-abandoned", ".not-an-id-source-abandoned", f".{CLIP_ID}-source-"):
        path = directory / name
        path.mkdir()
        (path / "keep.mov").write_bytes(b"not owned by the importer")
        os.utime(path, (0, 0))
        keep.append(path)

    assert cleanup_expired(cfg) == 0
    assert all((path / "keep.mov").is_file() for path in keep)
