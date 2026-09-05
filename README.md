# OnMotion

Learn Stephen Curry's one-motion jump shot with computer vision.

OnMotion builds a biomechanical benchmark from Stephen Curry's shooting footage, captures your own shot from an uploaded clip or live camera, and compares the two motions — release posture, shot tempo, lower-body loading, and more — to give concrete, Curry-specific feedback. The current reference is Curry v3: the first three real-time seconds of the configured source clip.

## Monorepo layout

- `apps/web` — Next.js player-facing app (camera capture, upload, analysis report)
- `backend` — FastAPI service (pose estimation backends, benchmark pipeline, comparison engine)
- `docs` — [PRD](docs/PRD.md) and [Architecture](docs/ARCHITECTURE.md)
- `data` — local-only artifacts: raw clips, extracted keypoints, benchmark profiles (gitignored)
- `infra` — environment templates, deployment assets

## Quickstart with Docker (recommended)

Docker Compose runs the API, Next.js app, and an Nginx gateway behind one origin. It requires the following local-only artifacts, whose expected hashes are recorded in `infra/artifacts.json`:

- `models/yolo11n-pose.pt`
- `data/benchmarks/curry_v3.json`
- `data/raw_videos/curry/curry_v3_reference.mp4`

Prepare the model once if it is missing, then start the stack:

```bash
curl -L -o models/yolo11n-pose.pt \
  https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo11n-pose.pt
docker compose up --build
```

Open http://localhost:3000. `GET /health` is the liveness probe; `GET /ready` verifies the model, v3 benchmark, reference video, manifest checksums, and writable data directories. Set `ONMOTION_PORT` to publish a different host port and `ONMOTION_MEDIA_TTL_HOURS` to change the default 24-hour upload/replay retention period.

## Local development

Backend (Python 3.13+, [uv](https://docs.astral.sh/uv/)):

```bash
cd backend
uv sync

# one-time: pose model weights (auto-downloads on first use instead if missing)
curl -L -o ../models/yolo11n-pose.pt \
  https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo11n-pose.pt

# v3 uses exactly 0:00–0:03 of the requested real-time source file
uv run python scripts/prepare_reference_clip.py \
  ../data/raw_videos/curry/curry_v3_source.mp4 \
  ../data/raw_videos/curry/curry_v3_reference.mp4 --start-ms 0 --end-ms 3000
uv run python scripts/build_curry_benchmark.py \
  --clip ../data/raw_videos/curry/curry_v3_reference.mp4 \
  --out ../data/benchmarks/curry_v3.json

uv run uvicorn app.main:app --reload   # http://localhost:8000/health
uv run pytest                          # smoke tests
```

Web app (Node 20+):

```bash
cd apps/web
npm install
npm run dev                            # http://localhost:3000
```

Record or upload a clip at http://localhost:3000, get a similarity score,
you-vs-Curry metrics, and prioritized corrections. For a meaningful 2D
comparison, record one complete shot from a stable camera placed at chest height,
perpendicular to the shooting plane. Keep the player's full body, shooting hand,
ball, and basket-side motion in frame.

## Status

MVP working end-to-end: YOLO-pose extraction → shot-phase segmentation →
biomechanical metrics → comparison against Curry v3 → evidence-aware feedback.
The report overlays the skeleton and frame-level measurements directly on both
source videos. The two clips can follow a shared dip/release anchor or be played,
scrubbed, phase-jumped, and advanced one pose frame at a time independently.

Important interpretation limits: Curry v3 is currently one reference shot, so
its values are a reference, not a population distribution. `release_angle_deg`
is a 2D forearm-elevation proxy rather than measured ball launch angle. The app
does not synthesize a side view from an oblique upload: monocular view generation
can hallucinate joint geometry and would make the resulting biomechanics unsafe
to compare. See [the architecture notes](docs/ARCHITECTURE.md) for the validation
gate required before that experiment can be exposed.
