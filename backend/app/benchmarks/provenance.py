"""Validate an explicit source manifest before extracting benchmark poses."""

import hashlib
import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class ReferenceClip(BaseModel):
    path: str
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_url: str | None = None
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    timing_mode: Literal["realtime", "slow_motion", "unknown"] = "unknown"
    time_scale_to_realtime: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def interval_and_speed(self):
        if self.end_ms <= self.start_ms:
            raise ValueError("reference interval must have positive duration")
        if self.timing_mode == "realtime" and self.time_scale_to_realtime != 1:
            raise ValueError("real-time reference must explicitly declare time scale 1")
        return self


def file_sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def load_sources(manifest: Path, clips: list[Path]) -> dict[str, ReferenceClip]:
    entries = [ReferenceClip.model_validate(item) for item in json.loads(manifest.read_text(encoding="utf-8"))["clips"]]
    resolved = [(manifest.parent / item.path).resolve() for item in entries]
    requested = [clip.resolve() for clip in clips]
    if len(set(resolved)) != len(resolved) or set(resolved) != set(requested):
        raise ValueError("source manifest must match the exact input clips without duplicates")
    sources = {}
    for path, item in zip(resolved, entries):
        if file_sha256(path) != item.sha256:
            raise ValueError(f"reference checksum mismatch: {path.name}")
        sources[path.stem] = item
    return sources
