"""Exercise exported-video import with real inference in isolated storage.

Any local supported long video can validate the import plumbing. This does not
attest that the input came from HomeCourt or that its playback is real time.
"""

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app.benchmarks.templates import ACTIVE_TEMPLATE_ID, load_template, template_video_path
from app.core.config import Settings, get_settings
from app.main import create_app
from app.schemas.media_source import ClipImportRequest, SubjectROI


def checked(response, status=200):
    assert response.status_code == status, response.text
    return response.json()


def smoke(cfg: Settings, video: Path, start_ms: int, end_ms: int) -> dict:
    profile = load_template(cfg, ACTIVE_TEMPLATE_ID)
    reference = template_video_path(cfg, profile)
    assert reference is not None, "reference video is required"
    declaration = ClipImportRequest(
        start_ms=start_ms, end_ms=end_ms, timing_mode="unknown",
        camera_label="local import smoke test",
        subject_roi=SubjectROI(x=0.0, y=0.0, width=1.0, height=1.0),
    ).model_dump_json()
    with video.open("rb") as handle:
        original_hash = hashlib.file_digest(handle, "sha256").hexdigest()
    with tempfile.TemporaryDirectory(prefix="onemotion-homecourt-smoke-") as directory:
        root = Path(directory)
        copies = {
            cfg.model_path: root / "models/yolo11n-pose.pt",
            cfg.benchmark_path: root / "data/benchmarks/curry_v3.json",
            cfg.artifact_manifest: root / "infra/artifacts.json",
            reference: root / "data/raw_videos/curry" / reference.name,
        }
        for original, destination in copies.items():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, destination)
        isolated = Settings(
            data_dir=root / "data", model_path=copies[cfg.model_path],
            artifact_manifest=copies[cfg.artifact_manifest],
            ball_model_path=cfg.ball_model_path if cfg.ball_model_path.is_file()
            else root / "models/yolo11n.pt",
        )
        app = create_app()
        app.dependency_overrides[get_settings] = lambda: isolated
        with TestClient(app) as client:
            checked(client.get("/ready"))
            started = time.perf_counter()
            with video.open("rb") as handle:
                result = checked(client.post("/api/v1/analysis",
                    files={"video": (video.name, handle, "video/mp4")},
                    data={"source": declaration}))
            elapsed = time.perf_counter() - started
            path = f"/api/v1/analysis/{result['analysis_id']}"
            assert result["source"]["original_sha256"] == original_hash
            requested_start = result["source"].get("requested_start_ms")
            assert (requested_start if requested_start is not None else result["source"]["start_ms"]) == start_ms
            assert result["timing_score"] is None
            assert all(not metric["reliable"] for metric in result["metrics"]
                       if metric["category"] == "timing")
            compared = checked(client.get(f"{path}/comparison"))
            assert compared["source"] == result["source"]
            assert compared["metrics"] == result["metrics"]
            replay = checked(client.get(f"{path}/replay"))
            assert all(frame["wrist_vertical_velocity_height_s"]["value"] is None
                       for frame in replay["player_biomechanics"])
            media = client.get(f"{path}/video")
            assert media.status_code == 200
            assert hashlib.sha256(media.content).hexdigest() == result["source"]["selected_sha256"]
            ranged = client.get(f"{path}/video", headers={"Range": "bytes=0-99"})
            assert ranged.status_code == 206 and len(ranged.content) == 100
            assert len(list(isolated.uploads_dir.iterdir())) == 1

            player = checked(client.post("/api/v1/compare/players", json={"name": "Import smoke"}), 201)
            player_path = f"/api/v1/compare/players/{player['player_id']}"
            template = checked(client.post(f"{player_path}/templates",
                json={"name": "Jump shot", "default_phases": ["shot"]}), 201)
            clips = []
            for kind in ("baseline", "comparison"):
                with video.open("rb") as handle:
                    clip = checked(client.post(f"{player_path}/clips",
                        files={"video": (video.name, handle, "video/mp4")},
                        data={"template_id": template["template_id"], "kind": kind,
                              "source": declaration}), 201)
                assert clip["source"]["original_sha256"] == original_hash
                clips.append(clip)
            comparison = checked(client.post("/api/v1/compare/comparisons", json={
                "player_id": player["player_id"], "template_id": template["template_id"],
                "baseline_clip_id": clips[0]["clip_id"], "comparison_clip_id": clips[1]["clip_id"],
            }), 201)
            exported = checked(client.post(
                f"/api/v1/compare/comparisons/{comparison['comparison_id']}/report"))
            report = exported["report"]
            assert report["phase_offsets"] == []
            assert "phase timing comparison is disabled" in report["summary_text"]
            assert report["keyframes"], "input must contain a detectable person"
            for frame in report["keyframes"]:
                assert client.get(frame["url"]).status_code == 200
            assert len(list(isolated.compare_videos_dir.iterdir())) == 2
            assert not list(isolated.data_dir.rglob("*-source-*"))
            assert client.delete(path).status_code == 204
            assert not list(isolated.uploads_dir.iterdir())
            assert not list(isolated.keypoints_dir.iterdir())
            return {
                "input": str(video), "input_original_sha256": original_hash,
                "source_interval_ms": [start_ms, end_ms],
                "actual_source_interval_ms": [result["source"]["start_ms"], result["source"]["end_ms"]],
                "analysis_latency_s": round(elapsed, 3),
                "pose_frames": len(replay["player_sequence"]["frames"]),
                "repeated_comparison_consistent": True, "source_hash_verified": True,
                "selected_hash_verified": True, "temporary_originals_removed": True,
                "uncertain_clock_gated": True, "media_range": 206,
                "history_clips": len(clips), "report_keyframes": len(report["keyframes"]),
                "isolated_analysis_deleted": True,
            }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--start-ms", type=int, default=0)
    parser.add_argument("--end-ms", type=int, default=3000)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = smoke(Settings(), args.source.resolve(), args.start_ms, args.end_ms)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))
