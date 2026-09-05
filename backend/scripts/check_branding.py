"""Reject the retired brand spelling in version-controlled text files."""

import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[2]
pattern = re.compile("on" + "motion", re.IGNORECASE)
failures = []
for name in subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0"):
    if not name:
        continue
    try:
        lines = (root / name).read_text().splitlines()
    except (UnicodeError, OSError):
        continue
    failures.extend(f"{name}:{i}" for i, line in enumerate(lines, 1) if pattern.search(line))
if failures:
    raise SystemExit("Use OneMotion consistently:\n" + "\n".join(failures))
print("OneMotion naming check passed.")
