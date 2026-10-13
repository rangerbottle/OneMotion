"""Regression cases from the repository review; no downloaded model required."""

import io
import hashlib
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
    cfg = Settings(data_dir=tmp_path / "data", model_path=tmp_path / "models/yolo11n-pose.pt",
                   artifact_manifest=tmp_path / "infra/artifacts.json")
    artifacts = {
        "models/yolo11n-pose.pt": cfg.model_path,
        "data/benchmarks/curry_v3.json": cfg.benchmark_path,
        "data/raw_videos/curry/curry_v3_reference.mp4": cfg.raw_videos_dir / "curry_v3_reference.mp4",
    }
    for name, path in artifacts.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(name.encode())
    cfg.artifact_manifest.parent.mkdir(parents=True)
    cfg.artifact_manifest.write_text(json.dumps({"artifacts": [
        {"path": name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "size": path.stat().st_size}
        for name, path in artifacts.items()
    ]}))
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
    from app.pose.ball_detector import unavailable_track
    monkeypatch.setattr(routes, "track_window", lambda *_: unavailable_track(0, 1, "test: no ball model"))
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
    assert (cfg.uploads_dir / routes.analysis_video(created.analysis_id, cfg).filename).is_file()
    routes.delete_analysis(created.analysis_id, cfg)
    assert not list(cfg.analyses_dir.glob("*.json"))
    assert not list(cfg.uploads_dir.glob("*"))
    assert not list(cfg.keypoints_dir.glob("*"))


def test_ball_track_persists_to_replay(setup_analysis, monkeypatch):
    from app.schemas.pose import BallDetection, BallTrack
    cfg, _, _, _ = setup_analysis
    track = BallTrack(available=True, start_frame=1, end_frame=2, frames=[
        BallDetection(frame_idx=1, t_ms=100, x=0.5, y=0.4, confidence=0.9, radius=0.05),
        BallDetection(frame_idx=2, t_ms=200, x=None, y=None, confidence=0.0),
    ])
    monkeypatch.setattr(routes, "track_window", lambda *_: track)
    created = routes.create_analysis(upload(), cfg)
    assert routes.replay(created.analysis_id, cfg).player_sequence.ball_track == track


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
    monkeypatch.setattr(routes_health, "verify_analysis_artifacts", lambda *_: [])
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


@pytest.mark.parametrize("damaged", ["manifest", "model", "benchmark", "video", "unpinned"])
def test_analysis_integrity_gate_rejects_before_inference(setup_analysis, monkeypatch, damaged):
    cfg, _, _, _ = setup_analysis
    backend = Mock()
    monkeypatch.setattr(routes, "get_backend", backend)
    if damaged == "manifest":
        cfg.artifact_manifest.unlink()
    elif damaged == "unpinned":
        release = json.loads(cfg.artifact_manifest.read_text())
        release["artifacts"].pop()
        cfg.artifact_manifest.write_text(json.dumps(release))
    else:
        path = {"model": cfg.model_path, "benchmark": cfg.benchmark_path,
                "video": cfg.raw_videos_dir / "curry_v3_reference.mp4"}[damaged]
        path.write_bytes(b"tampered")
    request = upload()
    with pytest.raises(HTTPException) as exc:
        routes.create_analysis(request, cfg)
    assert exc.value.status_code == 503
    assert request.file.closed
    backend.assert_not_called()
    assert not list(cfg.uploads_dir.glob("*"))


@pytest.mark.parametrize("status", ["fail", "warn"])
def test_capture_gates_new_repeated_and_persisted_reports(setup_analysis, monkeypatch, status):
    cfg, _, _, _ = setup_analysis
    capture = CaptureQuality(status=status, side_view_score=.65 if status == "warn" else .2,
                             confidence=.95, body_visibility=1, reasons=["unsuitable view"])
    monkeypatch.setattr(routes, "assess_capture", lambda *_: capture)
    created = routes.create_analysis(upload(), cfg)
    assert created.similarity_score is None  # fewer than three usable metrics
    assert created.form_score is None
    assert created.feedback == []
    assert any(item["reliable"] for item in created.measurement_evidence.values())
    for result in (created, routes.get_analysis(created.analysis_id, cfg),
                   routes.compare_with_template(created.analysis_id, cfg)):
        assert all(not m.reliable and m.delta is None for m in result.metrics if m.category == "form")
        assert result.measurement_evidence == created.measurement_evidence
        if status == "fail":
            assert result.timing_score is None
    # Legacy reports with old scores must obey the new policy, even after media expires.
    old = created.model_copy(update={"similarity_score": 100, "form_score": 100,
        "media_expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)})
    atomic_write(cfg.analyses_dir / f"{old.analysis_id}.json", old.model_dump_json())
    loaded = routes.get_analysis(old.analysis_id, cfg)
    assert loaded.similarity_score is None and loaded.form_score is None
    assert routes.get_analysis(old.analysis_id, cfg) == loaded


def test_frontal_capture_is_a_failure():
    from app.analysis.capture_quality import assess_capture
    seq = sequence()
    for frame in seq.frames:
        for kp in frame.keypoints:
            if kp.name in {"left_shoulder", "left_hip"}:
                kp.x = .2
            elif kp.name in {"right_shoulder", "right_hip"}:
                kp.x = .8
    assert assess_capture(seq, phases()).status == "fail"


def test_full_source_is_optional_and_must_match_provenance(setup_analysis):
    from app.api.routes_templates import template_source_video
    from app.benchmarks.templates import template_source_video_path
    cfg, _, _, profile = setup_analysis
    source = cfg.raw_videos_dir / "curry_v3_source.mp4"
    source.write_bytes(b"full original")
    profile.canonical_video_filename = "curry_v3_reference.mp4"
    profile.provenance = {"clips": [{"path": "curry_v3_reference.mp4",
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest()}]}
    assert template_source_video_path(cfg, profile) == source
    source.write_bytes(b"different original")
    assert template_source_video_path(cfg, profile) is None
    source.unlink()
    assert template_source_video_path(cfg, profile) is None
    with pytest.raises(HTTPException) as exc:
        template_source_video("retired", cfg)
    assert exc.value.status_code == 410


def test_persisted_unknown_timing_does_not_claim_slow_motion(setup_analysis):
    cfg, _, _, profile = setup_analysis
    profile.timing_mode = "unknown"
    profile.timing_reliable = False
    created = routes.create_analysis(upload(), cfg)
    for metric in created.metrics:
        if metric.category == "timing":
            metric.unavailable_reason = "selected template is slow-motion; timing comparison is disabled"
    atomic_write(cfg.analyses_dir / f"{created.analysis_id}.json", created.model_dump_json())
    loaded = routes.get_analysis(created.analysis_id, cfg)
    assert all("not verified" in metric.unavailable_reason for metric in loaded.metrics if metric.category == "timing")
    assert loaded.metrics == routes.compare_with_template(created.analysis_id, cfg).metrics


@pytest.mark.parametrize("expired", [False, True])
def test_no_capture_or_replay_cannot_bypass_persisted_timing_gate(setup_analysis, monkeypatch, expired):
    cfg, seq, _, _ = setup_analysis
    created = routes.create_analysis(upload(), cfg)
    deadline = datetime.now(timezone.utc) + timedelta(hours=-1 if expired else 1)
    old = created.model_copy(update={
        "capture_quality": None, "timing_mode": "unknown", "timing_reliable": False,
        "timing_score": 100, "similarity_score": 100, "player_sequence": seq if expired else None,
        "media_expires_at": deadline,
    })
    atomic_write(cfg.analyses_dir / f"{old.analysis_id}.json", old.model_dump_json())
    (cfg.keypoints_dir / f"{old.analysis_id}.json").unlink()
    assess = Mock(side_effect=AssertionError("replay is unavailable"))
    monkeypatch.setattr(routes, "assess_capture", assess)
    writer = Mock(wraps=routes._atomic_write)
    monkeypatch.setattr(routes, "_atomic_write", writer)
    loaded = routes.get_analysis(old.analysis_id, cfg)
    tempo = next(metric for metric in loaded.metrics if metric.category == "timing")
    assert not tempo.reliable and tempo.delta is None
    assert "not verified" in tempo.unavailable_reason
    assert loaded.timing_score is None and loaded.similarity_score is None
    assert loaded.player_sequence is None
    assert loaded.media_expires_at == deadline
    assert loaded.measurement_evidence == created.measurement_evidence
    assert routes.get_analysis(old.analysis_id, cfg) == loaded
    assert writer.call_count == 1
    assess.assert_not_called()


def test_repeated_comparison_keeps_unreliable_metric_missing_from_partial_evidence(setup_analysis):
    cfg, _, _, _ = setup_analysis
    created = routes.create_analysis(upload(), cfg)
    evidence = {name: item for name, item in created.measurement_evidence.items() if name != "set_point_ratio"}
    metrics = [metric.model_copy(update={
        "reliable": False, "delta": None, "delta_pct": None, "robust_z_score": None,
        "unavailable_reason": "original evidence rejected this measurement",
    }) if metric.name == "set_point_ratio" else metric for metric in created.metrics]
    old = created.model_copy(update={"metrics": metrics, "measurement_evidence": evidence})
    atomic_write(cfg.analyses_dir / f"{old.analysis_id}.json", old.model_dump_json())
    loaded = routes.get_analysis(old.analysis_id, cfg)
    repeated = routes.compare_with_template(old.analysis_id, cfg)
    assert repeated.metrics == loaded.metrics
    assert repeated.feedback == loaded.feedback
    assert repeated.similarity_score == loaded.similarity_score
    assert repeated.measurement_evidence["set_point_ratio"]["reliable"] is False


@pytest.mark.parametrize("raw_evidence", [True, False])
def test_retired_report_migration_does_not_upgrade_rejected_measurements(setup_analysis, raw_evidence):
    cfg, _, _, _ = setup_analysis
    created = routes.create_analysis(upload(), cfg)
    rejected = {"confidence": .6, "coverage": .5, "reliable": False,
                "reason": "the original recording had missing joints"}
    metrics = [metric.model_copy(update={
        "reliable": False, "confidence": .6, "coverage": .5, "delta": None,
        "unavailable_reason": rejected["reason"],
    }) if metric.name == "set_point_ratio" else metric for metric in created.metrics]
    evidence = {"set_point_ratio": rejected} if raw_evidence else {}
    old = created.model_copy(update={
        "benchmark_version": "curry_v2", "template_id": "curry_v2",
        "metrics": metrics, "measurement_evidence": evidence,
    })
    atomic_write(cfg.analyses_dir / f"{old.analysis_id}.json", old.model_dump_json())
    migrated = routes.get_analysis(old.analysis_id, cfg)
    set_point = next(metric for metric in migrated.metrics if metric.name == "set_point_ratio")
    assert migrated.template_id == "curry_v3"
    assert not set_point.reliable and set_point.delta is None
    assert set_point.unavailable_reason == rejected["reason"]
    assert migrated.measurement_evidence["set_point_ratio"] == rejected
    assert "release_angle_deg" in migrated.measurement_evidence  # Missing raw entries were measured.
    assert migrated.media_expires_at == created.media_expires_at
    assert routes.get_analysis(old.analysis_id, cfg) == migrated
    assert routes.compare_with_template(old.analysis_id, cfg).metrics == migrated.metrics


def test_read_does_not_trust_stale_metric_over_raw_rejection(setup_analysis):
    cfg, _, _, _ = setup_analysis
    created = routes.create_analysis(upload(), cfg)
    evidence = {**created.measurement_evidence, "set_point_ratio": {
        **created.measurement_evidence["set_point_ratio"], "reliable": False,
        "reason": "the original evidence rejected this measurement",
    }}
    old = created.model_copy(update={"measurement_evidence": evidence})
    atomic_write(cfg.analyses_dir / f"{old.analysis_id}.json", old.model_dump_json())
    loaded = routes.get_analysis(old.analysis_id, cfg)
    set_point = next(metric for metric in loaded.metrics if metric.name == "set_point_ratio")
    assert not set_point.reliable and set_point.delta is None
    repeated = routes.compare_with_template(old.analysis_id, cfg)
    assert repeated.metrics == loaded.metrics
    assert repeated.similarity_score == loaded.similarity_score
    assert repeated.feedback == loaded.feedback
    assert loaded.measurement_evidence == evidence
