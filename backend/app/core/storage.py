"""Atomic local writes and bounded, cross-process per-analysis locking."""

import fcntl
import hashlib
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=f"{path.name}.", suffix=".tmp", delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


@contextmanager
def analysis_lock(data_dir: Path, analysis_id: str, *, blocking: bool = True):
    # Fixed stripes bound the number of lock files. Never unlink a live lock:
    # replacing its inode would allow a second process into the critical section.
    directory = data_dir / ".locks"
    directory.mkdir(parents=True, exist_ok=True)
    stripe = int(hashlib.sha256(analysis_id.encode()).hexdigest(), 16) % 64
    with (directory / f"{stripe}.lock").open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
