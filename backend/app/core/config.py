"""Runtime settings, read from ONMOTION_* environment variables."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ONMOTION_", env_file=".env", extra="ignore"
    )

    data_dir: Path = REPO_ROOT / "data"
    pose_backend: Literal["rfdetr", "mediapipe", "yolo"] = "yolo"
    model_path: Path = REPO_ROOT / "models" / "yolo11n-pose.pt"
    artifact_manifest: Path = REPO_ROOT / "infra" / "artifacts.json"
    media_ttl_hours: int = 24
    allowed_origins: str = "http://localhost:3000"
    warm_model: bool = False
    # Roboflow API key, required only when pose_backend = "rfdetr".
    rf_api_key: str | None = None

    @property
    def benchmark_path(self) -> Path:
        return self.data_dir / "benchmarks" / "curry_v3.json"

    @property
    def benchmarks_dir(self) -> Path:
        return self.data_dir / "benchmarks"

    @property
    def analyses_dir(self) -> Path:
        return self.data_dir / "analyses"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def keypoints_dir(self) -> Path:
        return self.data_dir / "keypoints"

    @property
    def raw_videos_dir(self) -> Path:
        return self.data_dir / "raw_videos" / "curry"


@lru_cache
def get_settings() -> Settings:
    """Shared settings instance; routes depend on this so tests can override it."""
    return Settings()


settings = get_settings()
