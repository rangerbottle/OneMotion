# AGENTS.md

Guidance for AI coding agents working in this repository. Assumes no prior
knowledge of the project. Read `docs/ARCHITECTURE.md` for the deep dive; this
file is the practical orientation.

## Project overview

OneMotion compares a player's basketball jump shot against a biomechanical
benchmark built from Stephen Curry footage ("Curry v3" — the first 3 real-time
seconds of one source clip). It extracts 2D pose, segments the shot into
phases, computes biomechanical metrics, compares them against the benchmark,
and produces evidence-aware feedback with skeleton overlays on both videos.

Monorepo layout:

- `apps/web` — Next.js 16 (App Router, React 19, TypeScript, Tailwind 4)
  player-facing app: camera capture, upload, analysis report.
- `backend` — FastAPI service (Python 3.13+, uv): pose estimation, benchmark
  pipeline, comparison engine.
- `docs` — PRD, ARCHITECTURE, IMPROVEMENTS, EVALUATION.
- `data` — local-only artifacts (raw clips, benchmarks, uploads, keypoints).
  Gitignored except `.gitkeep`.
- `models` — pose model weights (`yolo11n-pose.pt`) and the optional ball
  detection model (`yolo11n.pt`, COCO "sports ball" class for the
  lift→release ball-trajectory overlay), local-only.
- `infra` — `.env.example`, `nginx.conf`, Dockerfiles. `infra/artifacts.json`
  (checksum manifest) is gitignored and regenerated per machine.
- `dev.sh` — local dev orchestrator (see below).

Key configuration files:

- `backend/pyproject.toml` — backend deps, pytest config (`testpaths=["tests"]`,
  `pythonpath=["."]`), torch pinned to the pytorch-cpu index via
  `[tool.uv.sources]`.
- `apps/web/package.json` — web scripts and deps (Next.js 16.3.4, React 19).
- `apps/web/playwright.config.ts` — browser tests: ports 3109 (web) and 8129
  (stub API), single worker, synthetic fixtures.
- `compose.yaml` — three services: `api` (FastAPI), `web` (Next.js),
  `gateway` (Nginx, published on `${ONEMOTION_PORT:-3000}`).
- `.github/workflows/ci.yml` — CI (see Testing).

## Build and test commands

### Backend (`cd backend`, Python 3.13+, uv)

```bash
uv sync                                        # install (uv sync --frozen in CI)
uv run uvicorn app.main:app --reload           # dev server on :8000
uv run pytest -q                               # full suite
uv run pytest tests/test_api.py -q             # one file
uv run pytest tests/test_regressions.py::test_name   # one test
python scripts/check_branding.py               # brand-spelling gate (runs in CI)
uv run python scripts/smoke_analysis.py        # real-inference API round trip in isolated storage
uv run python scripts/evaluate.py <manifest.json>    # frozen-pose accuracy/regression cases
```

`pytest` needs no model or benchmark: model-backed paths are covered only by
`smoke_analysis.py` / real-clip round trips, not unit tests. Tests inject an
isolated `Settings(data_dir=tmp_path)` via
`app.dependency_overrides[get_settings]`; there is no conftest.py.

### Web (`cd apps/web`, Node 20+/22)

```bash
npm ci
npm run dev                    # :3000
npm run lint                   # eslint
npm run typecheck              # next typegen && tsc --noEmit
npx playwright install chromium && npm test   # Playwright; ports 3109/8129
npm run build                  # next build --webpack
```

### Full stack

```bash
./dev.sh deps                              # check/install toolchain (uv, node) + deps
./dev.sh start | status | stop | restart | logs   # run both servers (bare metal)
./dev.sh media                             # verify local artifacts; rebuild/re-pin gaps
./dev.sh benchmark <video> [--start-ms N --end-ms N]  # rebuild Curry v3 benchmark
docker compose up --build                  # Nginx gateway → Next.js + FastAPI, :3000
```

`dev.sh` writes PIDs/logs to `.run/` (gitignored). It binds loopback by
default; `ONEMOTION_PUBLIC_HOST=<LAN ip> ./dev.sh start` binds `0.0.0.0` and
fixes the browser API URL + CORS. Ports: `ONEMOTION_API_PORT` (8000),
`ONEMOTION_WEB_PORT` (3000).

## Runtime architecture

### Two pipelines, one analysis core (`backend/app/analysis/`)

- **Benchmark (offline):** `scripts/prepare_reference_clip.py` →
  `scripts/build_curry_benchmark.py` (pose → `phases.segment` →
  `metrics.compute_all` → aggregate) → `data/benchmarks/curry_v3.json` →
  `scripts/release_artifacts.py` pins hashes into `infra/artifacts.json`.
- **Player (online):** `POST /api/v1/analysis` (multipart upload; the camera
  flow records then uses the same endpoint) → `validate_video` → pose →
  `segment` → `compute_all` → `measurement_evidence` → `assess_capture` →
  `compare.metric_deltas` → `compare.similarity_score` → `feedback.rank` →
  `AnalysisResult`.

The shared analysis path order is duplicated in `routes_analysis._compare_result`
(fresh + repeated comparison) and `_active_result_locked` (legacy migration) —
keep them in sync when changing it.

### Pose backends (`backend/app/pose/`)

`PoseBackend` Protocol in `base.py`; `get_backend(cfg)` resolves and
`lru_cache`s the configured backend (`ONEMOTION_POSE_BACKEND`, default
`yolo`). All backends adapt to the **canonical COCO-17 schema** (`PoseFrame` /
`ShotSequence` in `schemas/pose.py`), coordinates normalized to `[0,1]`. One
frame record per decoded video frame — missed detections become
confidence-zero placeholders so frame indices map back to the source video.
Analysis code must consume only canonical keypoint names, never backend
indices. YOLO is the only working backend (MediaPipe crashes on the dev host;
`mediapipe_backend.py` / `rfdetr_backend.py` are kept but unused).

### Ball tracking (`backend/app/pose/ball_detector.py`)

`track_window(cfg, video_path, phases)` runs a separate COCO detection model
(`ONEMOTION_BALL_MODEL_PATH`, default `models/yolo11n.pt`; class 32 "sports
ball", threshold `ONEMOTION_BALL_MIN_CONF`) only over the **lift → release**
frame window, for both player uploads (`routes_analysis.create_analysis`) and
the benchmark canonical clip (`benchmarks/curry.py`). The result rides on
`ShotSequence.ball_track` (`BallTrack` in `schemas/pose.py`), so it persists
with the keypoints/benchmark JSON and flows through `/replay` automatically.
Missed detections stay `None` (never interpolated). A missing model file
yields `available=False` with a reason — analysis and `/ready` are unaffected,
and the ball model is deliberately not pinned in `infra/artifacts.json`.

### Frame-by-frame comparison (`backend/app/compare/`, `/api/v1/compare`)

Player-vs-own-history comparison for coaches: upload two clips of the same
action from the **same camera position** (V1 constraint) and compare them
frame by frame. Entities (JSON under `data/compare/`, no TTL — data assets):
`Player` / `ActionTemplate` (named, ordered default phases) / `Clip`
(`ClipMeta` + separate `.pose.json` `ShotSequence` + video in
`data/compare/videos/`) / `ComparisonState` (spatial affine, temporal
offsets, per-clip phase boundaries, event markers, camera check, report).
Pipeline: clip upload reuses the pose backend; comparison creation runs
`compare/alignment.py` (ORB background matching with the person masked out,
RANSAC homography → inlier-ratio grading via `ONEMOTION_COMPARE_CAMERA_*`
thresholds, homography reduced to a best-fit **affine** — B→A,
origin-centered `x' = s·R·x + t` in clip A pixels — because Canvas 2D cannot
apply projective transforms; both renderers share this convention) and
`compare/signals.py` (normalized pose-signal cross-correlation proposing a
**global** time offset — no time warping, by design; the lag is split
between `offset_ms_a`/`offset_ms_b` so neither anchor is ever negative). The workbench (`apps/web/app/compare/[id]/`) renders
split/overlay/difference views on canvas from rVFC clocks, with keyboard
frame stepping, draggable phase boundaries, event markers, per-frame joint
angle charts (`GET …/metrics`), and `compare/report.py` keyframe export
(max-deviation frames with both skeletons drawn).

### Phases (`analysis/phases.py`)

`dip → load → lift → release → follow_through`, driven by shooting-wrist
height + elbow angle. Occlusion-aware (raw confidence < 0.5 = missing).
`release` = first frame at 97% of local-max elbow extension near the wrist
apex. Occluded dips fall back to the shot-window start and mark affected
phases `degraded`; a 1s-capped follow-through is marked `censored`.

### Confidence gating is load-bearing

Every metric carries confidence, coverage, reliability, and a nullable value.
Unreliable measurements stay **visible with a reason** but must not influence
scores or feedback. Weak joints stay `null` — never imputed.
`measurement_evidence` is persisted separately from template-dependent deltas
so re-comparing a legacy report keeps its original reliability decisions.
Curry v3 is `n=1`, so the UI labels values as a single reference, not a
distribution.

### Templates / versioning (`benchmarks/templates.py`)

Only `curry_v3` is active (`ACTIVE_TEMPLATE_ID`); any other template ID
returns **HTTP 410**. A version name never establishes playback speed — source
manifests default to `unknown` timing unless explicitly attested; `provenance`
carries source/model/algorithm hashes.

### Storage & retention (`backend/app/core/`)

Local filesystem + JSON under `data/` (gitignored). `storage.atomic_write`
(unique temp + fsync + replace, with a Windows retry on transient replace
failures) and `storage.analysis_lock` (64 fixed lock stripes — never unlink a
live lock; fcntl on Unix, msvcrt byte-region locking on Windows) serialize
analysis creation, deletion, legacy migration, and the retention sweep. All
JSON artifact reads are explicit UTF-8 (Windows locale defaults would
mis-decode). Uploaded videos + replay keypoints have a media TTL
(`ONEMOTION_MEDIA_TTL_HOURS`, default 24 h); the FastAPI
lifespan in `main.py` runs a startup cleanup + 15-minute sweep that removes
expired media while keeping the compact report. Analysis creation rolls back
all its files on any failure.

### Resource limits

Upload capped at 50 MB / 12 s. YOLO decoder budget: 12 s, 1440 frames, 4K px,
120 fps (including clips with incomplete metadata). The timeout is checked
cooperatively between frame calls, not a hard interrupt of native code.
`inference_slot` bounds concurrency (`ONEMOTION_ANALYSIS_CONCURRENCY`, default
1); a busy request returns **429 with Retry-After**. Keep one Uvicorn worker.

### Frontend (`apps/web/`)

App Router: `record/` (getUserMedia) and `upload/` both POST to
`/api/v1/analysis`; `analysis/[id]/page.tsx` renders the compact report and
`skeleton-replay.tsx` fetches the heavy keypoint/per-frame-metric sequences
separately from `/replay`. Overlay drawing follows
`requestVideoFrameCallback` (not a UI timer) so skeletons don't drift. Sync
mode maps a chosen dip/release anchor to a shared zero while keeping each
video's real rate; independent mode gives per-video play/scrub/phase-jump/
single-frame controls. API error shapes: implemented routes use
`{detail: string}` + HTTP status; the pose stub uses `{error: {code, message}}`;
`lib/api.ts` `responseError` normalizes both.

## Code style guidelines

- Brand is **OneMotion** / `onemotion` / `ONEMOTION` —
  `backend/scripts/check_branding.py` fails CI on the retired spelling in any
  tracked text file.
- All backend settings use the `ONEMOTION_` env prefix (`core/config.py`,
  pydantic-settings, `get_settings()` `lru_cache`d so tests can override).
  Key vars: `ONEMOTION_DATA_DIR`, `ONEMOTION_POSE_BACKEND`,
  `ONEMOTION_MODEL_PATH`, `ONEMOTION_ARTIFACT_MANIFEST`,
  `ONEMOTION_BALL_MODEL_PATH`, `ONEMOTION_BALL_MIN_CONF`,
  `ONEMOTION_ANALYSIS_CONCURRENCY`, `ONEMOTION_ANALYSIS_TIMEOUT_S`,
  `ONEMOTION_ALLOWED_ORIGINS`, `ONEMOTION_WARM_MODEL`,
  `ONEMOTION_MEDIA_TTL_HOURS`. Frontend: `NEXT_PUBLIC_API_BASE` (browser,
  build-time) and `ONEMOTION_API_BASE` (server render, runtime), resolved in
  `apps/web/lib/api.ts`. See `infra/.env.example`.
- Backend is plain typed Python (pydantic v2); torch/torchvision come from
  the pytorch-cpu index — don't repoint to GPU wheels casually.
- `apps/web/AGENTS.md` (re-exported by `apps/web/CLAUDE.md`) is written and
  re-added by `next dev` — commit that block with your changes rather than
  fighting it. This is Next.js 16 with breaking changes vs. older App Router:
  consult `node_modules/next/dist/docs/` before assuming behavior.
- Deliberate API stubs: `POST /api/v1/pose/estimate` is an intentional 501
  (analysis runs pose inline); non-active template IDs return 410. Don't
  "fix" these.
- The "convert an oblique clip to a 90° side view" feature is **intentionally
  not built** — monocular view synthesis can hallucinate joint geometry. See
  the validation gate in `docs/ARCHITECTURE.md` §11 before touching anything
  in that direction.

## Testing instructions

- Backend: `uv run pytest -q` from `backend/`. Unit tests need no model or
  benchmark media. Model-backed inference is verified by
  `uv run python scripts/smoke_analysis.py` (real API round trip in isolated
  storage) and `uv run python scripts/evaluate.py <manifest.json>`
  (frozen-pose accuracy/regression cases, see `docs/EVALUATION.md`).
- Web: `npm run lint`, `npm run typecheck`, then
  `npx playwright install chromium && npm test`. Playwright uses synthetic
  fixtures and a stub API server (`tests/api-server.mjs`) on ports 3109/8129,
  single worker, no retries locally.
- CI (`.github/workflows/ci.yml`) runs on every push/PR: branding gate +
  `uv sync --frozen` + `uv run pytest -q` (backend); `npm ci`, lint,
  typecheck, Playwright, `npm run build` (web); and builds both Docker images
  (without private reference media).

## Deployment

- `docker compose up --build` (project name `onemotion`) runs three services:
  Nginx gateway on `${ONEMOTION_PORT:-3000}` → Next.js → FastAPI. The
  gateway/web/API each have healthchecks; the API's hits `/ready`.
- Docker requires the local-only artifacts on the host first:
  `models/yolo11n-pose.pt`, `data/benchmarks/curry_v3.json`,
  `data/raw_videos/curry/curry_v3_reference.mp4`, and `infra/artifacts.json`.
  The whole `infra/` directory is bind-mounted read-only (a single-file mount
  would pin the old inode when `release_artifacts.py` re-pins via
  `atomic_write`); if `artifacts.json` is missing, `/ready` never passes.
  The gateway resolves `api`/`web` through Docker's embedded DNS, so
  recreated containers keep working without a gateway restart.
- On Linux, create `data/analyses`, `data/uploads`, `data/keypoints`,
  `data/.locks` and chown them to the API container's UID/GID 10001 before
  starting Compose. `/ready` checks all four.
- Upgrading an existing deployment: stop the previous Compose project at
  cutover before starting the new one on the same host port; keep the mounted
  data directories.

## Security considerations

- Reference media (Curry footage, benchmark, model weights) and
  `infra/artifacts.json` are local-only and gitignored (distribution rights
  not asserted). Never commit them; `release_artifacts.py` regenerates and
  pins the manifest per machine. Don't disable integrity checks.
- `GET /health` = liveness; `GET /ready` verifies model, benchmark, reference
  video, manifest checksums, and writable data dirs. When artifacts are
  missing, `/health` still works but analysis returns 503.
- CORS is explicit via `ONEMOTION_ALLOWED_ORIGINS`; `dev.sh` binds loopback
  unless `ONEMOTION_PUBLIC_HOST` is set.
- Analysis storage uses atomic writes + fcntl lock stripes to survive
  concurrent processes; never unlink a live lock file, and preserve the
  rollback-on-failure behavior of analysis creation.
- User uploads are untrusted video: size/duration/frame budgets above are the
  guardrails — don't relax them without a reason.
