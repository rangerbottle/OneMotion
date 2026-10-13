"""Source provenance, upload cleanup, and timing gates at the route boundary."""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.analysis.results import (
    SOURCE_TIMING_UNAVAILABLE_REASON, apply_comparison_policy, build_comparison,
)
from app.api import routes_analysis, routes_compare
from app.compare import store
from app.core.config import get_settings
from app.core.storage import atomic_write
from app.core.video import AnalysisBusy
from app.schemas.media_source import ClipImportRequest, MediaSource, SubjectROI
from test_analysis_results import comparison
from test_compare import cfg as compare_cfg, make_player, make_template, upload as compare_upload
from test_regressions import setup_analysis, upload


def declaration(timing_mode="unknown", *, roi=False):
    return ClipImportRequest(
        provider="homecourt", start_ms=1_000, end_ms=1_200,
        recorded_at=datetime(2026, 10, 4, 12, tzinfo=timezone.utc),
        camera_label="court sideline", timing_mode=timing_mode,
        subject_roi=SubjectROI(x=.1, y=.1, width=.5, height=.8) if roi else None,
    )


def source_metadata(request=None, original=b"original"):
    request = request or declaration()
    return MediaSource(
        **request.model_dump(), original_filename="HomeCourt.mov",
        original_sha256=hashlib.sha256(original).hexdigest(),
        selected_sha256=hashlib.sha256(b"selected full-frame clip").hexdigest(),
    )


def stub_preparer(monkeypatch, module):
    calls = []

    def prepare(video, target_dir, clip_id, source, *, concurrency):
        calls.append((source, concurrency, video))
        assert source is not None
        metadata = source_metadata(source, original=video.file.read())
        path = target_dir / f"{clip_id}.mp4"
        path.write_bytes(b"selected full-frame clip")
        return path, metadata

    monkeypatch.setattr(module, "prepare_upload", prepare)
    return calls


@pytest.mark.parametrize("mode", ["unknown", "slow_motion", "realtime"])
def test_source_policy_gates_timing_without_changing_pose_evidence(comparison, mode):
    base, template, values, evidence = comparison
    base.source = source_metadata(declaration(mode))
    result = build_comparison(base, template, values, evidence)
    tempo = next(metric for metric in result.metrics if metric.category == "timing")
    assert result.source == base.source
    assert result.measurement_evidence == evidence
    assert tempo.confidence == evidence[tempo.name]["confidence"]
    assert tempo.value == values[tempo.name]
    assert result.timing_reliable  # Reference metadata retains its established meaning.
    if mode == "realtime":
        assert tempo.reliable and result.timing_score == 100
    else:
        assert not tempo.reliable and tempo.delta is None
        assert tempo.unavailable_reason == SOURCE_TIMING_UNAVAILABLE_REASON
        assert result.timing_score is None
        assert all(item.metric != tempo.name for item in result.feedback)
        assert result.form_score == result.similarity_score == 83.3
    assert apply_comparison_policy(result) == result


def test_realtime_source_cannot_enable_unknown_reference_timing(comparison):
    base, template, values, evidence = comparison
    base.source = source_metadata(declaration("realtime"))
    template = template.model_copy(update={"timing_mode": "unknown", "timing_reliable": False})
    result = build_comparison(base, template, values, evidence)
    tempo = next(metric for metric in result.metrics if metric.category == "timing")
    assert not tempo.reliable and result.timing_score is None
    assert "reference playback speed" in tempo.unavailable_reason
    assert result.measurement_evidence == evidence


@pytest.mark.parametrize("mode", ["unknown", "slow_motion", "realtime"])
def test_imported_analysis_keeps_source_through_load_recompare_and_migration(setup_analysis, monkeypatch, mode):
    cfg, _, _, _ = setup_analysis
    calls = stub_preparer(monkeypatch, routes_analysis)
    request = declaration(mode)
    file = upload()
    created = routes_analysis.create_analysis(file, cfg, source=request.model_dump_json())
    assert file.file.closed
    assert calls[0][0] == request
    assert calls[0][1] == cfg.analysis_concurrency
    assert created.source.timing_mode == mode
    assert created.source.original_sha256 == hashlib.sha256(b"video fixture").hexdigest()
    assert created.source.selected_sha256 == hashlib.sha256(b"selected full-frame clip").hexdigest()
    assert list(cfg.uploads_dir.iterdir()) == [cfg.uploads_dir / f"{created.analysis_id}.mp4"]
    for result in (
        routes_analysis.get_analysis(created.analysis_id, cfg),
        routes_analysis.compare_with_template(created.analysis_id, cfg),
    ):
        assert result.source == created.source
        assert result.metrics == created.metrics
        assert result.measurement_evidence == created.measurement_evidence
    legacy = created.model_copy(update={"template_id": "curry_v2", "benchmark_version": "curry_v2"})
    atomic_write(cfg.analyses_dir / f"{created.analysis_id}.json", legacy.model_dump_json())
    migrated = routes_analysis.get_analysis(created.analysis_id, cfg)
    assert migrated.source == created.source
    assert migrated.measurement_evidence == created.measurement_evidence
    assert migrated.metrics == created.metrics


def test_expired_source_report_cannot_bypass_timing_gate_without_replay(setup_analysis, monkeypatch):
    cfg, _, _, _ = setup_analysis
    stub_preparer(monkeypatch, routes_analysis)
    created = routes_analysis.create_analysis(upload(), cfg, source=declaration().model_dump_json())
    stale = created.model_copy(update={
        "capture_quality": None, "timing_score": 100,
        "media_expires_at": datetime.now(timezone.utc) - timedelta(hours=1),
        "metrics": [metric.model_copy(update={"reliable": True, "delta": 0})
                    if metric.category == "timing" else metric for metric in created.metrics],
    })
    atomic_write(cfg.analyses_dir / f"{created.analysis_id}.json", stale.model_dump_json())
    (cfg.keypoints_dir / f"{created.analysis_id}.json").unlink()
    loaded = routes_analysis.get_analysis(created.analysis_id, cfg)
    assert loaded.source == created.source
    assert loaded.timing_score is None
    assert not next(metric for metric in loaded.metrics if metric.category == "timing").reliable
    assert loaded.measurement_evidence == created.measurement_evidence


@pytest.mark.parametrize("mode", ["unknown", "slow_motion", "realtime"])
def test_replay_velocity_obeys_player_source_speed(setup_analysis, monkeypatch, mode):
    cfg, _, _, _ = setup_analysis
    stub_preparer(monkeypatch, routes_analysis)
    created = routes_analysis.create_analysis(upload(), cfg, source=declaration(mode).model_dump_json())
    replay = routes_analysis.replay(created.analysis_id, cfg)
    velocity = [frame.wrist_vertical_velocity_height_s for frame in replay.player_biomechanics]
    if mode == "realtime":
        assert any(item.reliable for item in velocity)
    else:
        assert all(not item.reliable and item.value is None for item in velocity)


def test_imported_compare_clip_keeps_source_and_selected_path(compare_cfg, monkeypatch):
    player = make_player(compare_cfg)
    template = make_template(compare_cfg, player.player_id)
    calls = stub_preparer(monkeypatch, routes_compare)
    file = compare_upload(name="HomeCourt.mov")
    clip = routes_compare.upload_clip(
        player.player_id, compare_cfg, file, template_id=template.template_id,
        source=declaration("slow_motion").model_dump_json(),
    )
    assert file.file.closed
    assert clip.source == store.load_clip_meta(compare_cfg, clip.clip_id).source
    assert clip.source.timing_mode == "slow_motion"
    assert calls[0][1] == compare_cfg.analysis_concurrency
    assert routes_compare.clip_video(clip.clip_id, compare_cfg).filename == f"{clip.clip_id}.mp4"
    assert list(compare_cfg.compare_videos_dir.iterdir()) == [compare_cfg.compare_videos_dir / f"{clip.clip_id}.mp4"]


@pytest.mark.parametrize("module", [routes_analysis, routes_compare])
@pytest.mark.parametrize("invalid", ["", "null", "not json", '{"provider":"other","start_ms":0,"end_ms":1}',
                                     '{"start_ms":0,"end_ms":12001}', '{"start_ms":true,"end_ms":100}'])
def test_invalid_source_closes_file_before_any_upload(module, invalid, setup_analysis, compare_cfg, monkeypatch):
    prepare = Mock()
    monkeypatch.setattr(module, "prepare_upload", prepare)
    file = upload()
    with pytest.raises(HTTPException) as exc:
        if module is routes_analysis:
            module.create_analysis(file, setup_analysis[0], source=invalid)
        else:
            module.upload_clip("a" * 32, compare_cfg, file, template_id="b" * 32, source=invalid)
    assert exc.value.status_code == 422
    assert isinstance(exc.value.detail, str)
    assert file.file.closed
    prepare.assert_not_called()


@pytest.mark.parametrize("module", [routes_analysis, routes_compare])
def test_invalid_source_over_multipart_returns_detail_string(module, setup_analysis, compare_cfg):
    cfg = setup_analysis[0] if module is routes_analysis else compare_cfg
    app = FastAPI()
    app.include_router(module.router, prefix="/api/v1")
    app.dependency_overrides[get_settings] = lambda: cfg
    url = "/api/v1/analysis" if module is routes_analysis else "/api/v1/compare/players/" + "a" * 32 + "/clips"
    with TestClient(app) as client:
        response = client.post(url, files={"video": ("HomeCourt.mov", b"source", "video/quicktime")},
                               data={"source": '{"start_ms":0,"end_ms":20000}', "template_id": "b" * 32})
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)


@pytest.mark.parametrize("module", [routes_analysis, routes_compare])
def test_multipart_source_file_part_is_a_string_detail_validation_error(module, setup_analysis, compare_cfg):
    cfg = setup_analysis[0] if module is routes_analysis else compare_cfg
    app = FastAPI()
    app.include_router(module.router, prefix="/api/v1")
    app.dependency_overrides[get_settings] = lambda: cfg
    url = "/api/v1/analysis" if module is routes_analysis else "/api/v1/compare/players/" + "a" * 32 + "/clips"
    with TestClient(app) as client:
        response = client.post(url, files={
            "video": ("HomeCourt.mov", b"source", "video/quicktime"),
            "source": ("source.json", declaration().model_dump_json().encode(), "application/json"),
        }, data={"template_id": "b" * 32})
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)


@pytest.mark.parametrize("module", [routes_analysis, routes_compare])
@pytest.mark.parametrize("source_form", [None, "", "homecourt"])
def test_multipart_import_and_optional_source_compatibility(module, source_form, setup_analysis, compare_cfg, monkeypatch):
    cfg = setup_analysis[0] if module is routes_analysis else compare_cfg
    calls = stub_preparer(monkeypatch, module) if source_form == "homecourt" else None
    app = FastAPI()
    app.include_router(module.router, prefix="/api/v1")
    app.dependency_overrides[get_settings] = lambda: cfg
    data = {}
    if module is routes_analysis:
        url = "/api/v1/analysis"
    else:
        player = make_player(cfg)
        template = make_template(cfg, player.player_id)
        url = f"/api/v1/compare/players/{player.player_id}/clips"
        data["template_id"] = template.template_id
    if source_form is not None:
        data["source"] = declaration().model_dump_json() if source_form == "homecourt" else ""
    with TestClient(app) as client:
        response = client.post(url, data=data, files={"video": ("HomeCourt.mov", b"source", "video/quicktime")})
    assert response.status_code == (200 if module is routes_analysis else 201)
    if source_form == "homecourt":
        assert response.json()["source"]["provider"] == "homecourt"
        assert response.json()["source"]["original_sha256"] == hashlib.sha256(b"source").hexdigest()
        assert calls[0][2].file.closed
    else:
        # FastAPI treats an empty optional Form field as omitted; it retains normal limits.
        assert response.json()["source"] is None


def test_legacy_report_without_source_field_keeps_existing_timing_semantics(setup_analysis):
    cfg, _, _, _ = setup_analysis
    created = routes_analysis.create_analysis(upload(), cfg)
    payload = created.model_dump(mode="json")
    payload.pop("source")
    atomic_write(cfg.analyses_dir / f"{created.analysis_id}.json", json.dumps(payload))
    loaded = routes_analysis.get_analysis(created.analysis_id, cfg)
    assert loaded.source is None
    assert loaded.metrics == created.metrics
    assert loaded.timing_score == created.timing_score


@pytest.mark.parametrize("module", [routes_analysis, routes_compare])
@pytest.mark.parametrize("failure", ["pose", "slot", "roi_backend"])
def test_selected_clip_failure_rolls_back_and_closes_file(module, failure, setup_analysis, compare_cfg, monkeypatch):
    cfg = setup_analysis[0] if module is routes_analysis else compare_cfg
    stub_preparer(monkeypatch, module)
    file = upload()
    source = declaration(roi=failure == "roi_backend")
    if failure == "slot":
        def busy(*_, **__):
            raise AnalysisBusy("busy")
        monkeypatch.setattr(module, "prepare_upload", busy)
    elif failure == "roi_backend":
        monkeypatch.setattr(module, "get_backend", lambda *_: Mock(name="other"))
    else:
        monkeypatch.setattr(module, "get_backend", Mock(side_effect=ValueError("pose failed")))
    with pytest.raises(HTTPException) as exc:
        if module is routes_analysis:
            module.create_analysis(file, cfg, source=source.model_dump_json())
        else:
            player = make_player(cfg)
            template = make_template(cfg, player.player_id)
            module.upload_clip(player.player_id, cfg, file, template_id=template.template_id, source=source.model_dump_json())
    assert exc.value.status_code == (429 if failure == "slot" else 422)
    assert file.file.closed
    if module is routes_analysis:
        directories = (cfg.uploads_dir, cfg.keypoints_dir, cfg.analyses_dir)
    else:
        directories = (cfg.compare_videos_dir, cfg.compare_clips_dir)
    assert all(not list(directory.glob("*")) for directory in directories)


@pytest.mark.parametrize("module", [routes_analysis, routes_compare])
def test_roi_is_forwarded_only_to_yolo(module, setup_analysis, compare_cfg, monkeypatch):
    cfg, seq, _, _ = setup_analysis
    if module is routes_compare:
        cfg = compare_cfg
    stub_preparer(monkeypatch, module)
    backend = Mock()
    backend.name = "yolo"
    backend.estimate_video.return_value = seq
    monkeypatch.setattr(module, "get_backend", lambda *_: backend)
    source = declaration(roi=True)
    if module is routes_analysis:
        result = module.create_analysis(upload(), cfg, source=source.model_dump_json())
        directory, identifier = cfg.uploads_dir, result.analysis_id
    else:
        player = make_player(cfg)
        template = make_template(cfg, player.player_id)
        result = module.upload_clip(player.player_id, cfg, upload(), template_id=template.template_id,
                                    source=source.model_dump_json())
        directory, identifier = cfg.compare_videos_dir, result.clip_id
    backend.estimate_video.assert_called_once_with(directory / f"{identifier}.mp4", subject_roi=source.subject_roi)
    assert result.source.subject_roi == source.subject_roi


@pytest.mark.parametrize("module", [routes_analysis, routes_compare])
def test_early_route_rejection_always_closes_upload(module, setup_analysis, compare_cfg):
    file = compare_upload(name="notes.txt")
    with pytest.raises(HTTPException):
        if module is routes_analysis:
            module.create_analysis(file, setup_analysis[0])
        else:
            module.upload_clip("bad id", compare_cfg, file, template_id="b" * 32)
    assert file.file.closed
