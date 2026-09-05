"""Run a real-video API round trip in isolated storage, leaving user data untouched."""

import argparse
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


def smoke(source: Settings) -> dict:
    profile = load_template(source, ACTIVE_TEMPLATE_ID)
    video = template_video_path(source, profile)
    if video is None:
        raise ValueError("reference video is required")
    with tempfile.TemporaryDirectory(prefix="onemotion-smoke-") as temporary:
        root = Path(temporary)
        copies = {
            source.model_path: root / "models/yolo11n-pose.pt",
            source.benchmark_path: root / "data/benchmarks/curry_v3.json",
            source.artifact_manifest: root / "infra/artifacts.json",
            video: root / "data/raw_videos/curry" / video.name,
        }
        for src, dst in copies.items():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        cfg = Settings(data_dir=root / "data", model_path=copies[source.model_path], artifact_manifest=copies[source.artifact_manifest])
        app = create_app()
        app.dependency_overrides[get_settings] = lambda: cfg
        with TestClient(app) as client:
            ready = client.get("/ready")
            assert ready.status_code == 200, ready.text
            started = time.perf_counter()
            with video.open("rb") as clip:
                response = client.post("/api/v1/analysis", files={"video": (video.name, clip, "video/mp4")})
            elapsed = time.perf_counter() - started
            assert response.status_code == 200, response.text
            result = response.json()
            path = f"/api/v1/analysis/{result['analysis_id']}"
            compared = client.get(f"{path}/comparison")
            assert compared.status_code == 200, compared.text
            assert compared.json()["metrics"] == result["metrics"]
            assert compared.json()["similarity_score"] == result["similarity_score"]
            replay = client.get(f"{path}/replay")
            assert replay.status_code == 200, replay.text
            media = client.get(f"{path}/video", headers={"Range": "bytes=0-99"})
            assert media.status_code == 206 and len(media.content) == 100
            assert client.delete(path).status_code == 204
            assert client.get(path).status_code == 404
            return {"ready": 200, "analysis": 200, "latency_s": round(elapsed, 3),
                    "similarity_score": result["similarity_score"],
                    "pose_frames": len(replay.json()["player_sequence"]["frames"]),
                    "comparison_consistent": True, "media_range": 206, "deleted": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = smoke(Settings())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
