"""Atomic local writes and bounded, cross-process per-analysis locking."""

import hashlib
import os
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

if sys.platform == "win32":
    # fcntl is Unix-only; msvcrt byte-region locking is the Windows equivalent.
    import msvcrt

    def _lock(handle, *, blocking: bool) -> None:
        handle.seek(0)
        try:
            msvcrt.locking(
                handle.fileno(), msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1
            )
        except OSError as exc:
            raise BlockingIOError(exc.errno, str(exc)) from exc

    def _unlock(handle) -> None:
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
else:
    import fcntl

    def _lock(handle, *, blocking: bool) -> None:
        fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))

    def _unlock(handle) -> None:
        fcntl.flock(handle, fcntl.LOCK_UN)


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
        # os.replace over an existing target can transiently fail on Windows
        # (WinError 5) when another thread is mid-replace on the same path.
        for attempt in range(50):
            try:
                temporary.replace(path)
                break
            except PermissionError:
                if sys.platform != "win32" or attempt == 49:
                    raise
                time.sleep(0.002 * (attempt + 1))
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
            _lock(handle, blocking=blocking)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            _unlock(handle)
