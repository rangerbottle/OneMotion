"""Compare request regressions exercised through the JSON HTTP boundary."""

from datetime import datetime, timezone
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api import routes_compare as routes
from app.compare import store
from app.core.config import get_settings
from app.schemas.compare import KeyframeRef, ReportRef
from test_biomechanics import sequence
from test_compare import cfg, make_clip, make_player, make_template, upload


@pytest.fixture
def client(cfg):
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    app.dependency_overrides[get_settings] = lambda: cfg
    with TestClient(app) as client:
        yield client


@pytest.fixture
def comparison(cfg, monkeypatch):
    monkeypatch.setattr(routes, "_decode_samples", lambda *_: {})
    player = make_player(cfg)
    template = make_template(cfg, player.player_id)
    a = make_clip(cfg, player.player_id, template.template_id, kind="baseline")
    b = make_clip(cfg, player.player_id, template.template_id)
    return routes.create_comparison({
        "player_id": player.player_id,
        "template_id": template.template_id,
        "baseline_clip_id": a.clip_id,
        "comparison_clip_id": b.clip_id,
    }, cfg)


@pytest.mark.parametrize("body", [
    {"spatial": None},
    {"spatial": "bad"},
    {"spatial": {"scale": 0}},
    {"spatial": {"scale": -1}},
    {"spatial": {"tx": "bad"}},
    {"spatial": {"rotation_deg": "NaN"}},
    {"opacity_default": None},
    {"opacity_default": []},
    {"opacity_default": "dark"},
    {"opacity_default": 2},
    {"temporal": None},
    {"temporal": "bad"},
    {"temporal": {"offset_ms_b": None}},
    {"temporal": {"offset_ms_b": -1}},
    {"temporal": {"offset_ms_b": 1.5}},
    {"temporal": {"offset_ms_b": True}},
    {"temporal": {"offset_ms_b": 201}},
    {"temporal": {"suggested_offset_ms_b": 201}},
    {"temporal": {"suggestion_confidence": "Infinity"}},
    {"phases_a": None},
    {"phases_a": []},
    {"phases_a": [{}]},
    {"phases_a": [{"phase": "prep", "start_frame": 2, "end_frame": 1}]},
    {"phases_a": [{"phase": "prep", "start_frame": 0, "end_frame": 3}]},
    {"phases_a": [{"phase": " ", "start_frame": 0, "end_frame": 1}]},
    {"markers": None},
    {"markers": [1]},
    {"markers": [{"marker_id": "m", "frame": 1, "t_ms": 201}]},
    {"markers": [{"marker_id": "m", "frame": 3, "t_ms": 100}]},
])
def test_invalid_patch_is_422_and_leaves_persisted_state_unchanged(client, cfg, comparison, body):
    path = store.comparison_path(cfg, comparison.comparison_id)
    before = path.read_bytes()
    response = client.patch(f"/api/v1/compare/comparisons/{comparison.comparison_id}", json=body)
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)
    assert path.read_bytes() == before


@pytest.mark.parametrize("value", ["NaN", "Infinity", "-Infinity"])
def test_nonfinite_json_numbers_cannot_be_persisted(client, cfg, comparison, value):
    path = store.comparison_path(cfg, comparison.comparison_id)
    before = path.read_bytes()
    response = client.patch(
        f"/api/v1/compare/comparisons/{comparison.comparison_id}",
        content='{"spatial":{"tx":' + value + '}}',
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)
    assert path.read_bytes() == before


def test_partial_temporal_patch_and_spatial_replacement_keep_existing_semantics(client, comparison):
    url = f"/api/v1/compare/comparisons/{comparison.comparison_id}"
    response = client.patch(url, json={
        "temporal": {"offset_ms_a": 100, "offset_ms_b": 200},
        "spatial": {"tx": 5, "ty": 6, "scale": 1.2, "rotation_deg": 8},
    })
    assert response.status_code == 200
    response = client.patch(url, json={"temporal": {"offset_ms_b": 50}, "spatial": {"tx": 10}})
    assert response.status_code == 200
    state = response.json()
    assert state["temporal"]["offset_ms_a"] == 100
    assert state["temporal"]["offset_ms_b"] == 50
    assert state["spatial"] == {"tx": 10, "ty": 0, "scale": 1, "rotation_deg": 0}
    # Omitted fields do not clear state; optional suggestion metadata can be cleared.
    response = client.patch(url, json={"temporal": {"suggestion_confidence": None}})
    assert response.status_code == 200
    assert response.json()["temporal"]["offset_ms_a"] == 100
    assert response.json()["temporal"]["suggestion_confidence"] is None


def test_markers_keep_default_creation_time_and_empty_list_clears(client, comparison):
    url = f"/api/v1/compare/comparisons/{comparison.comparison_id}"
    response = client.patch(url, json={"markers": [{"marker_id": "m1", "frame": 1, "t_ms": 100}]})
    assert response.status_code == 200
    assert response.json()["markers"][0]["created_at"]
    assert client.patch(url, json={"markers": []}).json()["markers"] == []


def test_duplicate_markers_and_phase_names_are_rejected(client, comparison):
    url = f"/api/v1/compare/comparisons/{comparison.comparison_id}"
    for body in (
        {"markers": [{"marker_id": "m", "frame": 0, "t_ms": 0}] * 2},
        {"phases_b": [{"phase": "prep", "start_frame": 0, "end_frame": 0}] * 2},
    ):
        assert client.patch(url, json=body).status_code == 422


@pytest.mark.parametrize("body", [{}, {"name": None}, {"name": " "}, {"name": ["A"]}])
def test_player_creation_rejects_malformed_names_without_writing(client, cfg, body):
    response = client.post("/api/v1/compare/players", json=body)
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)
    assert store.list_players(cfg) == []


@pytest.mark.parametrize("phases", [None, 1, "prep", [], [" "], [1], ["prep", " prep "]])
def test_template_creation_requires_a_list_of_distinct_named_phases(client, cfg, phases):
    player = make_player(cfg)
    response = client.post(f"/api/v1/compare/players/{player.player_id}/templates", json={
        "name": " jump shot ", "default_phases": phases,
    })
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)
    assert store.list_templates(cfg, player.player_id) == []


def test_invalid_comparison_ids_return_422_and_unknown_route_ids_stay_404(client, cfg):
    response = client.post("/api/v1/compare/comparisons", json={
        "player_id": "../outside", "template_id": {},
        "baseline_clip_id": "a" * 32, "comparison_clip_id": "b" * 32,
    })
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)
    assert not list(cfg.compare_comparisons_dir.glob("*.json"))
    assert client.get("/api/v1/compare/comparisons/bad-id").status_code == 404


def test_clip_upload_rejects_another_players_template_before_storing_video(cfg):
    player_a, player_b = make_player(cfg, "A"), make_player(cfg, "B")
    template = make_template(cfg, player_b.player_id)
    with pytest.raises(HTTPException) as exc:
        routes.upload_clip(player_a.player_id, cfg, upload(), template_id=template.template_id)
    assert exc.value.status_code == 422
    assert not list(cfg.compare_videos_dir.glob("*"))


def test_empty_pose_upload_returns_422_and_rolls_back(cfg, monkeypatch):
    player = make_player(cfg)
    template = make_template(cfg, player.player_id)
    empty = sequence().model_copy(update={"frames": []})
    monkeypatch.setattr(routes, "get_backend", lambda *_: Mock(estimate_video=lambda _: empty))
    with pytest.raises(HTTPException) as exc:
        routes.upload_clip(player.player_id, cfg, upload(), template_id=template.template_id)
    assert exc.value.status_code == 422
    assert not list(cfg.compare_videos_dir.glob("*"))
    assert not list(cfg.compare_clips_dir.glob("*"))


def test_missing_pose_or_metadata_produces_recovery_status(client, cfg, comparison):
    store.clip_pose_path(cfg, comparison.baseline_clip_id).unlink()
    response = client.post("/api/v1/compare/comparisons", json={
        "player_id": comparison.player_id, "template_id": comparison.template_id,
        "baseline_clip_id": comparison.baseline_clip_id,
        "comparison_clip_id": comparison.comparison_clip_id,
    })
    assert response.status_code == 410
    store.clip_meta_path(cfg, comparison.baseline_clip_id).unlink()
    response = client.patch(f"/api/v1/compare/comparisons/{comparison.comparison_id}", json={"opacity_default": .8})
    assert response.status_code == 410


@pytest.mark.parametrize("filename", ["kf_0.png", "kf_" + "a" * 32 + "_1.png"])
def test_report_route_serves_referenced_old_and_new_generation_filenames(client, cfg, comparison, filename):
    directory = cfg.compare_reports_dir / comparison.comparison_id
    directory.mkdir(parents=True)
    (directory / filename).write_bytes(b"png")
    url = f"/api/v1/compare/reports/{comparison.comparison_id}/{filename}"
    comparison.report = ReportRef(
        created_at=datetime.now(timezone.utc), phase_offsets=[], summary_text="fixture",
        keyframes=[KeyframeRef(url=url, t_ms_a=0, t_ms_b=0, deviation=0)],
    )
    store.save_comparison(cfg, comparison)
    response = client.get(url)
    assert response.status_code == 200
    assert response.content == b"png"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("fail_during", ["build", "save"])
def test_report_failure_preserves_old_report_and_removes_uncommitted_images(cfg, comparison, monkeypatch, fail_during):
    directory = cfg.compare_reports_dir / comparison.comparison_id
    directory.mkdir(parents=True)
    old_image = directory / "kf_0.png"
    new_image = directory / ("kf_" + "b" * 32 + "_0.png")
    old_image.write_bytes(b"old png")
    comparison.report = ReportRef(
        created_at=datetime.now(timezone.utc), phase_offsets=[], summary_text="old report",
        keyframes=[KeyframeRef(
            url=f"/api/v1/compare/reports/{comparison.comparison_id}/{old_image.name}",
            t_ms_a=0, t_ms_b=0, deviation=0,
        )],
    )
    store.save_comparison(cfg, comparison)
    path = store.comparison_path(cfg, comparison.comparison_id)
    before = path.read_bytes()

    def build(*_):
        new_image.write_bytes(b"new png")
        if fail_during == "build":
            raise RuntimeError("report assembly failed")
        return comparison.report.model_copy(update={"keyframes": [KeyframeRef(
            url=f"/api/v1/compare/reports/{comparison.comparison_id}/{new_image.name}",
            t_ms_a=0, t_ms_b=0, deviation=0,
        )]})

    monkeypatch.setattr(routes, "build_report", build)
    if fail_during == "save":
        monkeypatch.setattr(store, "save_comparison", Mock(side_effect=RuntimeError("storage failed")))
    with pytest.raises(RuntimeError):
        routes.generate_report(comparison.comparison_id, cfg)
    assert path.read_bytes() == before
    assert old_image.read_bytes() == b"old png"
    assert not new_image.exists()
