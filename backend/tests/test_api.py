"""API smoke tests. Pose-free paths only — model-backed analysis is verified
end-to-end with real clips (see README), not in unit tests."""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.main import create_app
from app.schemas.benchmark import BenchmarkProfile, MetricStats


@pytest.fixture
def client(tmp_path):
    """App with an isolated empty data dir (no benchmark built)."""
    app = create_app()
    app.dependency_overrides[get_settings] = lambda: Settings(data_dir=tmp_path)
    return TestClient(app)


def test_health(client) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_pose_estimate_stub_returns_501(client) -> None:
    resp = client.post("/api/v1/pose/estimate")
    assert resp.status_code == 501
    assert resp.json()["error"]["code"] == "not_implemented"


def test_benchmark_missing_until_built(client) -> None:
    resp = client.get("/api/v1/benchmarks/current")
    assert resp.status_code == 404


def test_analysis_rejects_non_video_extension(client) -> None:
    resp = client.post(
        "/api/v1/analysis",
        files={"video": ("notes.txt", b"hello", "text/plain")},
    )
    assert resp.status_code == 422


def test_analysis_unavailable_when_v3_missing(client) -> None:
    resp = client.post(
        "/api/v1/analysis",
        files={"video": ("shot.mp4", b"not-a-real-video", "video/mp4")},
    )
    assert resp.status_code == 503


def test_get_unknown_analysis_404(client) -> None:
    resp = client.get("/api/v1/analysis/doesnotexist")
    assert resp.status_code == 404


def test_template_registry_exposes_only_v3(tmp_path) -> None:
    benchmark = BenchmarkProfile(
        version="curry_v3",
        created_at=datetime.now(timezone.utc),
        source_clips=["clip"],
        backend="test",
        metrics={"shot_tempo_s": MetricStats(median=1.4, p25=1.3, p75=1.5, n=3)},
        phase_timing=[],
        canonical_clip_id="clip",
    )
    directory = tmp_path / "benchmarks"
    directory.mkdir()
    (directory / "curry_v3.json").write_text(benchmark.model_dump_json())
    app = create_app()
    app.dependency_overrides[get_settings] = lambda: Settings(data_dir=tmp_path)
    response = TestClient(app).get("/api/v1/templates")
    assert response.status_code == 200
    item = response.json()[0]
    assert len(response.json()) == 1
    assert item["template_id"] == "curry_v3"
    assert item["timing_mode"] == "realtime"
    assert item["timing_reliable"] is True


def test_retired_template_returns_410(client) -> None:
    response = client.get("/api/v1/templates/curry_v2")
    assert response.status_code == 410


def test_readiness_reports_missing_artifacts(client) -> None:
    response = client.get("/ready")
    assert response.status_code == 503
    assert response.json()["status"] == "not_ready"
