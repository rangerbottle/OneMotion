"""Regression cases from the repository review; no downloaded model required."""

import io
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, UploadFile

from app.api import routes_analysis as routes
from app.analysis.metrics import measurement_evidence
from app.analysis.biomechanics import compute_frame_biomechanics
from app.core.config import Settings
from app.core.retention import cleanup_expired
from app.core.storage import atomic_write
from app.core.video import inference_slot, AnalysisBusy, check_decode_budget
from app.schemas.analysis import AnalysisResult, CaptureQuality
from app.schemas.benchmark import BenchmarkProfile, MetricStats
from test_biomechanics import sequence, phases


@pytest.fixture
def setup_analysis(tmp_path, monkeypatch):
    cfg = Settings(data_dir=tmp_path)
    seq, segments = sequence(), phases()
    template = BenchmarkProfile(
        version="curry_v3", created_at=datetime.now(timezone.utc), source_clips=["fixture"],
        backend="test", metrics={name: MetricStats(median=value, p25=value, p75=value, n=1)
            for name, value in {"shot_tempo_s": .2, "release_angle_deg": 0, "set_point_ratio": .2}.items()},
        phase_timing=[], canonical_clip_id="fixture", canonical_sequence=seq, canonical_phases=segments,
        timing_mode="realtime", timing_reliable=True,
    )
    monkeypatch.setattr(routes, "_resolve_template", lambda *_: template)
    monkeypatch.setattr(routes, "validate_video", lambda *_: None)
    monkeypatch.setattr(routes, "get_backend", lambda *_: Mock(estimate_video=lambda _: seq))
    monkeypatch.setattr(routes, "segment", lambda _: segments)
    return cfg, seq, segments, template


def upload():
    return UploadFile(filename="clip.mp4", file=io.BytesIO(b"video fixture"))


def test_analysis_round_trip_comparison_replay_and_delete(setup_analysis):
    cfg, _, _, _ = setup_analysis
    created = routes.create_analysis(upload(), cfg)
    loaded = routes.get_analysis(created.analysis_id, cfg)
    compared = routes.compare_with_template(created.analysis_id, cfg)
    assert loaded.metrics == compared.metrics == created.metrics
    assert compared.similarity_score == created.similarity_score
    assert compared.feedback == created.feedback
    assert len(routes.replay(created.analysis_id, cfg).player_sequence.frames) == 3
    assert routes.analysis_video(created.analysis_id, cfg).path.is_file()
    routes.delete_analysis(created.analysis_id, cfg)
    assert not list(cfg.analyses_dir.glob("*.json"))
    assert not list(cfg.uploads_dir.glob("*"))
    assert not list(cfg.keypoints_dir.glob("*"))


def test_comparison_keeps_degraded_metrics_excluded(setup_analysis):
    cfg, _, segments, _ = setup_analysis
    segments[2].degraded = True
    created = routes.create_analysis(upload(), cfg)
    # Also exercise legacy reports that have no stored raw evidence.
    for raw_evidence in (created.measurement_evidence, {}):
        report = created.model_copy(update={"measurement_evidence": raw_evidence})
        atomic_write(cfg.analyses_dir / f"{report.analysis_id}.json", report.model_dump_json())
        compared = routes.compare_with_template(report.analysis_id, cfg)
        assert compared.metrics == report.metrics
        assert compared.feedback == report.feedback
        assert compared.similarity_score == report.similarity_score


def test_tempo_gates_load_and_release_independently():
    for phase_index in (1, 3):
        segments = phases()
        segments[phase_index].degraded = True
        evidence = measurement_evidence(sequence(), segments)["shot_tempo_s"]
        assert evidence["coverage"] == 1
        assert not evidence["reliable"]
        assert segments[phase_index].phase in evidence["reason"]


@pytest.mark.parametrize("failure", ["model", "keypoints", "report"])
def test_failure_rolls_back_all_artifacts(setup_analysis, monkeypatch, failure):
    cfg, _, _, _ = setup_analysis
    if failure == "model":
        monkeypatch.setattr(routes, "get_backend", Mock(side_effect=FileNotFoundError("missing model")))
    else:
        original = routes._atomic_write
        def write(path, content):
            if path.parent == (cfg.keypoints_dir if failure == "keypoints" else cfg.analyses_dir):
                raise OSError("disk unavailable")
            original(path, content)
        monkeypatch.setattr(routes, "_atomic_write", write)
    with pytest.raises(OSError):
        routes.create_analysis(upload(), cfg)
    assert not list(cfg.uploads_dir.glob("*"))
    assert not list(cfg.keypoints_dir.glob("*"))
    assert not list(cfg.analyses_dir.glob("*"))


def test_preflight_rejects_before_model(setup_analysis, monkeypatch):
    cfg, _, _, _ = setup_analysis
    backend = Mock()
    monkeypatch.setattr(routes, "get_backend", backend)
    monkeypatch.setattr(routes, "validate_video", Mock(side_effect=ValueError("too long")))
    with pytest.raises(HTTPException) as exc:
        routes.create_analysis(upload(), cfg)
    assert exc.value.status_code == 422
    backend.assert_not_called()
    assert not list(cfg.uploads_dir.glob("*"))


def test_atomic_concurrent_writes_are_complete(tmp_path):
    path = tmp_path / "report.json"
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda i: atomic_write(path, json.dumps({"id": i, "body": "x" * 10000})), range(30)))
    assert json.loads(path.read_text())["body"] == "x" * 10000
    assert not list(tmp_path.glob("*.tmp"))


def test_expiry_is_enforced_without_cleanup_and_removes_inline_pose(setup_analysis):
    cfg, seq, _, _ = setup_analysis
    result = routes.create_analysis(upload(), cfg).model_copy(update={
        "media_expires_at": datetime.now(timezone.utc) - timedelta(seconds=1), "player_sequence": seq,
    })
    atomic_write(cfg.analyses_dir / f"{result.analysis_id}.json", result.model_dump_json())
    for endpoint in (routes.replay, routes.analysis_video):
        with pytest.raises(HTTPException) as exc:
            endpoint(result.analysis_id, cfg)
        assert exc.value.status_code == 410
    assert routes.get_analysis(result.analysis_id, cfg).player_sequence is None
    assert cleanup_expired(cfg) == 2
    assert (cfg.analyses_dir / f"{result.analysis_id}.json").is_file()


def test_cleanup_recovers_old_orphans_but_keeps_recent_files(tmp_path):
    cfg = Settings(data_dir=tmp_path, media_ttl_hours=1)
    cfg.uploads_dir.mkdir()
    old = cfg.uploads_dir / ("a" * 32 + ".mp4")
    fresh = cfg.uploads_dir / ("b" * 32 + ".mp4")
    for path in (old, fresh):
        path.write_bytes(b"clip")
    os.utime(old, (0, 0))
    assert cleanup_expired(cfg) == 1
    assert fresh.exists() and not old.exists()


def test_velocity_requires_scale_and_neighbor_evidence():
    seq = sequence()
    for frame in seq.frames:
        for point in frame.keypoints:
            if point.name.endswith("ankle"):
                point.confidence = 0
    assert all(not item.wrist_vertical_velocity_height_s.reliable for item in compute_frame_biomechanics(seq, phases()))
    seq = sequence()
    for point in seq.frames[1].keypoints:
        if point.name.endswith("wrist"):
            point.confidence = 0
    assert not compute_frame_biomechanics(seq, phases())[0].wrist_vertical_velocity_height_s.reliable
    seq = sequence()
    seq.frames[1].t_ms = 0
    assert not compute_frame_biomechanics(seq, phases())[0].wrist_vertical_velocity_height_s.reliable


def test_inference_backpressure_and_decoding_budget():
    import time
    with inference_slot(1):
        with pytest.raises(AnalysisBusy):
            with inference_slot(1):
                pass
    with inference_slot(1):
        pass
    for index, timestamp, started in [(1440, 0, time.monotonic()), (1, 12000, time.monotonic()), (1, 100, 0)]:
        with pytest.raises(ValueError):
            check_decode_budget(index, timestamp, started, 1)



def test_registry_does_not_invent_timing_or_replace_provenance(setup_analysis):
    from app.benchmarks.templates import decorate_template
    _, _, _, template = setup_analysis
    unknown = template.model_copy(update={"timing_mode": "unknown", "timing_reliable": False, "source_url": "https://example.test/reference"})
    decorated = decorate_template(unknown)
    assert decorated.timing_mode == "unknown" and not decorated.timing_reliable
    assert decorated.source_url == unknown.source_url


def test_source_manifest_rejects_wrong_clip_hash(tmp_path):
    from app.benchmarks.provenance import load_sources
    clip = tmp_path / "reference.mp4"
    clip.write_bytes(b"video")
    manifest = tmp_path / "source.json"
    manifest.write_text(json.dumps({"clips": [{"path": clip.name, "sha256": "0" * 64,
        "source_sha256": "1" * 64, "start_ms": 0, "end_ms": 3000,
        "timing_mode": "realtime", "time_scale_to_realtime": 1}]}))
    with pytest.raises(ValueError, match="checksum mismatch"):
        load_sources(manifest, [clip])


def test_benchmark_omits_metrics_with_degraded_dependencies(monkeypatch):
    from app.benchmarks import curry
    segments = phases()
    segments[1].degraded = True
    monkeypatch.setattr(curry, "segment", lambda _: segments)
    _, _, metrics = curry.analyze_clip(Mock(estimate_video=lambda _: sequence()), None)
    assert "shot_tempo_s" not in metrics


def test_readiness_checks_each_media_directory(setup_analysis, monkeypatch):
    from app.api import routes_health
    cfg, _, _, template = setup_analysis
    monkeypatch.setattr(routes_health, "verify_manifest", lambda *_: [])
    monkeypatch.setattr(routes_health, "load_template", lambda *_: template)
    monkeypatch.setattr(routes_health, "template_video_path", lambda *_: cfg.model_path)
    cfg.uploads_dir.write_text("a file cannot be an upload directory")
    assert routes_health.ready(cfg).status_code == 503


def test_concurrent_legacy_reads_migrate_once(setup_analysis):
    cfg, seq, _, _ = setup_analysis
    created = routes.create_analysis(upload(), cfg)
    legacy = created.model_copy(update={"capture_quality": None, "player_sequence": seq})
    atomic_write(cfg.analyses_dir / f"{legacy.analysis_id}.json", legacy.model_dump_json())
    with ThreadPoolExecutor(max_workers=8) as pool:
        loaded = list(pool.map(lambda _: routes.get_analysis(legacy.analysis_id, cfg), range(16)))
    assert all(item.capture_quality is not None for item in loaded)
    assert not list(cfg.analyses_dir.glob("*.tmp"))
