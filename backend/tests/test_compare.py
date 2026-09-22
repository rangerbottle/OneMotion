"""API tests for the compare domain; no real model or benchmark required."""

import io
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, UploadFile

from app.api import routes_compare as routes
from app.core.config import Settings
from test_biomechanics import sequence


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path)
    monkeypatch.setattr(routes, "get_backend", lambda *_: Mock(estimate_video=lambda _: sequence()))
    monkeypatch.setattr(routes, "validate_video", lambda *_: None)
    return settings


def upload(name="clip.mp4", body=b"video fixture"):
    return UploadFile(filename=name, file=io.BytesIO(body))


def make_player(cfg, name="Zhang"):
    return routes.create_player({"name": name}, cfg)


def make_template(cfg, player_id, phases=("prep", "drive", "follow")):
    return routes.create_template(player_id, {"name": "跳投", "default_phases": list(phases)}, cfg)


def make_clip(cfg, player_id, template_id, kind="comparison", name="clip.mp4"):
    return routes.upload_clip(player_id, cfg, upload(name), template_id=template_id, kind=kind)


def test_player_template_clip_crud_and_cascade(cfg):
    player = make_player(cfg)
    template = make_template(cfg, player.player_id)
    clip = make_clip(cfg, player.player_id, template.template_id)
    detail = routes.player_detail(player.player_id, cfg)
    assert detail["templates"][0].template_id == template.template_id
    assert detail["clips"][0].clip_id == clip.clip_id
    assert clip.frame_count == 3 and clip.fps == 10

    pose = routes.clip_pose(clip.clip_id, cfg)
    assert len(pose.frames) == 3
    response = routes.clip_video(clip.clip_id, cfg)
    assert response.filename.endswith(".mp4")

    routes.delete_player(player.player_id, cfg)
    assert routes.list_players(cfg) == []
    assert not list(cfg.compare_clips_dir.glob("*.json"))
    assert not list(cfg.compare_videos_dir.glob("*"))


def test_clip_requires_known_template_and_valid_kind(cfg):
    player = make_player(cfg)
    with pytest.raises(HTTPException) as exc:
        routes.upload_clip(player.player_id, cfg, upload(), template_id="a" * 32, kind="comparison")
    assert exc.value.status_code == 404
    template = make_template(cfg, player.player_id)
    with pytest.raises(HTTPException) as exc:
        routes.upload_clip(player.player_id, cfg, upload(), template_id=template.template_id, kind="weird")
    assert exc.value.status_code == 422


def test_comparison_create_patch_and_report(cfg):
    player = make_player(cfg)
    template = make_template(cfg, player.player_id)
    clip_a = make_clip(cfg, player.player_id, template.template_id, kind="baseline")
    clip_b = make_clip(cfg, player.player_id, template.template_id)

    # Synthetic camera check + temporal suggestion keep the test model-free;
    # frame decoding of the fake video yields no pairs → mismatch is expected.
    state = routes.create_comparison(
        {"player_id": player.player_id, "template_id": template.template_id,
         "baseline_clip_id": clip_a.clip_id, "comparison_clip_id": clip_b.clip_id}, cfg)
    assert state.camera_check.status == "mismatch"  # tiny fixture video decodes to nothing
    assert [p.phase for p in state.phases_a] == ["prep", "drive", "follow"]

    # Camera check paths with controlled pairs (unit-level trust: algorithms
    # have their own tests); here verify PATCH validation only.
    patched = routes.patch_comparison(state.comparison_id, {
        "temporal": {"offset_ms_b": 400},
        "markers": [{"marker_id": "m1", "side": "both", "frame": 1, "t_ms": 100, "text": "wrist late"}],
    }, cfg)
    assert patched.temporal.offset_ms_b == 400
    assert patched.markers[0].text == "wrist late"
    assert patched.report is None

    with pytest.raises(HTTPException) as exc:
        routes.patch_comparison(state.comparison_id, {
            "phases_a": [{"phase": "prep", "start_frame": 5, "end_frame": 1}]}, cfg)
    assert exc.value.status_code == 422
    with pytest.raises(HTTPException) as exc:
        routes.patch_comparison(state.comparison_id, {
            "markers": [{"marker_id": "m2", "frame": 99, "t_ms": 0}]}, cfg)
    assert exc.value.status_code == 422

    # Metrics endpoint returns per-frame angle series for both sides.
    metrics = routes.comparison_metrics(state.comparison_id, cfg)
    assert set(metrics["a"].keys()) == {"left_elbow_deg", "right_elbow_deg", "left_knee_deg", "right_knee_deg"}
    assert len(metrics["a"]["left_elbow_deg"]) == 3

    # Report generation runs without a model; keyframes need decodable video,
    # so the fixture yields zero files but a complete summary.
    reported = routes.generate_report(state.comparison_id, cfg)
    assert reported.report is not None
    assert "Camera check: mismatch" in reported.report.summary_text
    assert len(reported.report.phase_offsets) == 3
    assert reported.report.phase_offsets[0].phase == "prep"

    video_a = routes.comparison_video(state.comparison_id, "a", cfg)
    assert video_a.filename.endswith(".mp4")
    with pytest.raises(HTTPException) as exc:
        routes.comparison_video(state.comparison_id, "x", cfg)
    assert exc.value.status_code == 404

    routes.delete_comparison(state.comparison_id, cfg)
    with pytest.raises(HTTPException) as exc:
        routes.get_comparison(state.comparison_id, cfg)
    assert exc.value.status_code == 404


def test_comparison_rejects_cross_player_clips(cfg):
    p1, p2 = make_player(cfg, "A"), make_player(cfg, "B")
    t1 = make_template(cfg, p1.player_id)
    t2 = make_template(cfg, p2.player_id)
    c1 = make_clip(cfg, p1.player_id, t1.template_id, kind="baseline")
    c2 = make_clip(cfg, p2.player_id, t2.template_id)
    with pytest.raises(HTTPException) as exc:
        routes.create_comparison(
            {"player_id": p1.player_id, "template_id": t1.template_id,
             "baseline_clip_id": c1.clip_id, "comparison_clip_id": c2.clip_id}, cfg)
    assert exc.value.status_code == 422


def test_upload_rolls_back_on_pose_failure(cfg, monkeypatch):
    player = make_player(cfg)
    template = make_template(cfg, player.player_id)
    monkeypatch.setattr(routes, "get_backend", Mock(side_effect=FileNotFoundError("missing model")))
    with pytest.raises(FileNotFoundError):
        routes.upload_clip(player.player_id, cfg, upload(), template_id=template.template_id)
    assert not list(cfg.compare_videos_dir.glob("*"))
    assert not list(cfg.compare_clips_dir.glob("*"))


def test_report_file_serving_and_traversal_guard(cfg):
    player = make_player(cfg)
    template = make_template(cfg, player.player_id)
    clip_a = make_clip(cfg, player.player_id, template.template_id, kind="baseline")
    clip_b = make_clip(cfg, player.player_id, template.template_id)
    state = routes.create_comparison(
        {"player_id": player.player_id, "template_id": template.template_id,
         "baseline_clip_id": clip_a.clip_id, "comparison_clip_id": clip_b.clip_id}, cfg)
    (cfg.compare_reports_dir / state.comparison_id).mkdir(parents=True)
    (cfg.compare_reports_dir / state.comparison_id / "kf_0.png").write_bytes(b"png")
    response = routes.report_file(state.comparison_id, "kf_0.png", cfg)
    assert response.filename == "kf_0.png"
    with pytest.raises(HTTPException) as exc:
        routes.report_file(state.comparison_id, "../secret.png", cfg)
    assert exc.value.status_code == 404
