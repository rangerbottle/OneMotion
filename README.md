# OneMotion

Learn Stephen Curry's one-motion jump shot with computer vision.

OneMotion builds a biomechanical benchmark from Stephen Curry's shooting footage, captures your own shot from an uploaded clip or live camera, and compares the two motions — release posture, shot tempo, lower-body loading, and more — to give concrete, Curry-specific feedback. The current reference is Curry v3: the first three real-time seconds of the configured source clip.

## Monorepo layout

- `apps/web` — Next.js player-facing app (camera capture, upload, analysis report)
- `backend` — FastAPI service (pose estimation backends, benchmark pipeline, comparison engine)
- `docs` — [PRD](docs/PRD.md) and [Architecture](docs/ARCHITECTURE.md)
- `data` — local-only artifacts: raw clips, extracted keypoints, benchmark profiles (gitignored)
- `infra` — environment templates, deployment assets

## Quickstart with Docker (recommended)

Docker Compose runs the API, Next.js app, and an Nginx gateway behind one origin. It requires the following local-only artifacts:

- `models/yolo11n-pose.pt`
- `data/benchmarks/curry_v3.json`
- `data/raw_videos/curry/curry_v3_reference.mp4`
- `infra/artifacts.json` — the checksum manifest for the three files above. It is **generated locally and gitignored** (not committed): `scripts/release_artifacts.py` pins it from whatever media you built, and `./dev.sh start` / `./dev.sh media` runs that for you. `compose.yaml` bind-mounts it, so it must exist on the host before `docker compose up` (otherwise Docker creates an empty directory there and the API never passes `/ready`).

Prepare the model once if it is missing. Obtain the approved local source and build/pin its benchmark using the local-development commands below before starting the stack:

```bash
mkdir -p models
curl -L --fail -o models/yolo11n-pose.pt \
  https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo11n-pose.pt
docker compose up --build
```

Open http://localhost:3000. `GET /health` is the liveness probe; `GET /ready` verifies the model, v3 benchmark, reference video, manifest checksums, and writable data directories. Set `ONEMOTION_PORT` to publish a different host port and `ONEMOTION_MEDIA_TTL_HOURS` to change the default 24-hour upload/replay retention period.

## Local development

Backend (Python 3.13+, [uv](https://docs.astral.sh/uv/)):

```bash
cd backend
uv sync

# one-time: pose model weights (auto-downloads on first use instead if missing)
mkdir -p ../models
curl -L --fail -o ../models/yolo11n-pose.pt \
  https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo11n-pose.pt

# v3 uses exactly 0:00–0:03 of the requested real-time source file
uv run python scripts/prepare_reference_clip.py \
  ../data/raw_videos/curry/curry_v3_source.mp4 \
  ../data/raw_videos/curry/curry_v3_reference.mp4 --start-ms 0 --end-ms 3000 \
  --provenance ../data/raw_videos/curry/curry_v3_sources.json \
  --timing-mode realtime --time-scale 1 \
  --source-url https://www.bilibili.com/video/BV14u411J7qS/
uv run python scripts/build_curry_benchmark.py \
  --clip ../data/raw_videos/curry/curry_v3_reference.mp4 \
  --out ../data/benchmarks/curry_v3.json \
  --input-manifest ../data/raw_videos/curry/curry_v3_sources.json

# Review the new profile, then explicitly pin its model/profile/video hashes.
# This writes infra/artifacts.json (local-only, gitignored). ./dev.sh start and
# ./dev.sh media run this automatically whenever the manifest is missing or stale.
uv run python scripts/release_artifacts.py
uv run python scripts/release_artifacts.py --check

uv run uvicorn app.main:app --reload   # http://localhost:8000/health
uv run pytest                          # smoke tests
```

Web app (Node 20+):

```bash
cd apps/web
npm ci
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

## Verification and operation

Run `uv run pytest -q` from `backend`; run `npm run lint`, `npm run typecheck`,
`npx playwright install chromium`, `npm test`, and `npm run build` from `apps/web`.
CI runs these checks and builds both containers without private reference media.
Browser tests use synthetic fixtures on ports 3109 and 8129.

All application settings use the `ONEMOTION_` prefix. Update existing deployment
variables when upgrading. `ONEMOTION_ANALYSIS_CONCURRENCY` defaults to 1 per API
process; `ONEMOTION_ANALYSIS_TIMEOUT_S` defaults to 120 seconds. The supported
YOLO decoder enforces a 12-second, 1440-frame, 4K-pixel/120-fps budget, including
clips with incomplete metadata. Inference checks the timeout between frame calls;
it is not a hard interruption of a native decoder or model call. Busy requests
return 429 with Retry-After. Keep one Uvicorn worker for the configured CPU budget.

On Linux, prepare writable bind mounts for the API's UID/GID 10001. For a new
installation, create `data/analyses`, `data/uploads`, `data/keypoints`, and
`data/.locks`, and assign these directories to that UID/GID before starting
Compose. `/ready` checks all four locations and actual configured artifact paths.

Reference files stay local, and so does the `infra/artifacts.json` manifest that
pins them (gitignored — each machine regenerates it from its own media via
`./dev.sh start` / `./dev.sh media` / `release_artifacts.py`). Rebuilding changes
creation metadata and therefore the release hash; use `release_artifacts.py`
after reviewing a rebuild rather than disabling integrity checks. A version name
alone never establishes playback speed. Source manifests default to unknown
timing unless explicitly attested.

See [the improvement ledger](docs/IMPROVEMENTS.md) for verification status and
[the evaluation guide](docs/EVALUATION.md) for frozen-pose accuracy/regression cases.

The Compose project is named `onemotion`. When upgrading an existing deployment,
stop its previous Compose project at the chosen cutover time before starting the
new project on the same host port. Keep the mounted data directories. Renaming a
local checkout also requires updating the saved workspace path and any external
bind mounts; it is separate from changing source/configuration names.
