# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OneMotion compares a player's basketball jump shot against a biomechanical benchmark built from Stephen Curry footage ("Curry v3" — the first 3 real-time seconds of one source clip). Monorepo: `apps/web` (Next.js 16 player app), `backend` (FastAPI pose + analysis service), `docs` (PRD, ARCHITECTURE, IMPROVEMENTS, EVALUATION — read `docs/ARCHITECTURE.md` first for the big picture).

## Commands

### Backend (`cd backend`, Python 3.13+, uv)

```bash
uv sync                                        # install (uv sync --frozen in CI)
uv run uvicorn app.main:app --reload           # dev server :8000
uv run pytest -q                               # full suite
uv run pytest tests/test_api.py -q             # one file
uv run pytest tests/test_regressions.py::test_name  # one test
python scripts/check_branding.py               # brand-spelling gate (also runs in CI)
uv run python scripts/smoke_analysis.py        # real-inference API round trip in isolated storage
uv run python scripts/evaluate.py <manifest.json>  # frozen-pose accuracy/regression cases
```

`pytest` needs no model or benchmark: model-backed analysis paths are covered only by `smoke_analysis.py` / real-clip round trips, not unit tests. Tests inject an isolated `Settings(data_dir=tmp_path)` via `app.dependency_overrides[get_settings]`; there is no conftest.

### Web (`cd apps/web`, Node 20+/22)

```bash
npm ci
npm run dev                    # :3000
npm run lint
npm run typecheck              # next typegen && tsc --noEmit
npx playwright install chromium && npm test   # Playwright; synthetic fixtures, ports 3109/8129
npm run build                  # next build --webpack
```

`apps/web/CLAUDE.md` re-exports `apps/web/AGENTS.md`, which `next dev` regenerates — commit that block with your changes rather than fighting it. This is Next.js 16; consult `node_modules/next/dist/docs/` rather than assuming older App Router behavior.

### Full stack

```bash
./dev.sh deps                  # check/install toolchain (uv, node) + project deps
./dev.sh start | status | stop | restart | logs   # run both servers locally (bare metal)
./dev.sh benchmark <video>     # build curry_v3 reference clip + benchmark from a source video, re-pin hashes
docker compose up --build      # or: Nginx gateway → Next.js + FastAPI, http://localhost:3000
```

`dev.sh` writes PIDs/logs to `.run/` (gitignored) and starts the web app pointed at the local API. It binds to loopback by default; `ONEMOTION_PUBLIC_HOST=<LAN ip> ./dev.sh start` binds to `0.0.0.0` and fixes the browser API URL + CORS for other devices.

Requires local-only artifacts (`models/yolo11n-pose.pt`, `data/benchmarks/curry_v3.json`, `data/raw_videos/curry/curry_v3_reference.mp4`) whose hashes are pinned in `infra/artifacts.json`. `GET /health` = liveness; `GET /ready` = artifacts + storage. See README "Local development" for the `prepare_reference_clip.py` → `build_curry_benchmark.py` → `release_artifacts.py` sequence that produces the benchmark.

## Architecture

### Two pipelines, one core (`backend/app/analysis/`)

- **Benchmark (offline):** `scripts/build_curry_benchmark.py` → Curry clips → pose → `phases.segment` → `metrics.compute_all` → median+IQR aggregate → `data/benchmarks/curry_vN.json`.
- **Player (online):** `POST /api/v1/analysis` (multipart upload; camera flow records then uses the same endpoint) → `validate_video` → pose → `segment` → `compute_all` → `measurement_evidence` → `assess_capture` → `compare.metric_deltas` → `compare.similarity_score` → `feedback.rank` → `AnalysisResult`.

Shared analysis path order matters and is duplicated in `routes_analysis._compare_result` (fresh + repeated comparison) and `_active_result_locked` (legacy migration).

### Pose backends (`backend/app/pose/`)

`PoseBackend` Protocol in `base.py`; `get_backend(cfg)` resolves and `lru_cache`s the configured one (`ONEMOTION_POSE_BACKEND`, default `yolo`). All backends adapt their output to the **canonical COCO-17 schema** (`PoseFrame` / `ShotSequence` in `schemas/pose.py`), coords normalized to `[0,1]`. One frame record per decoded video frame — missed detections become confidence-zero placeholders so frame indices map back to the source video without drift. Analysis code must consume only canonical keypoint names, never backend indices. YOLO is the only working backend on macOS (MediaPipe crashes on the dev host; `mediapipe_backend.py` / `rfdetr_backend.py` are kept but unused).

### Phases (`analysis/phases.py`)

`dip → load → lift → release → follow_through`, driven by shooting-wrist height + elbow angle. Occlusion-aware (raw confidence < 0.5 = missing). `release` = first frame at 97% of local-max elbow extension in a short window around the wrist apex. Occluded dips fall back to the shot-window start and mark affected phases `degraded`; a 1s-capped follow-through is marked `censored`.

### Confidence gating is load-bearing

Every metric and derived value carries confidence, coverage, reliability, and a nullable value. Unreliable measurements stay **visible with a reason** but must not influence scores or feedback. Weak joints stay `null` — never imputed into apparent measurements. `measurement_evidence` is persisted separately from template-dependent deltas so re-comparing a legacy report keeps its original reliability decisions. Curry v3 is `n=1`, so the UI labels values as a single reference, not an IQR/distribution.

### Templates / versioning (`benchmarks/templates.py`)

Only `curry_v3` is active (`ACTIVE_TEMPLATE_ID`). Any other template ID returns **HTTP 410** so a stale client can't compare against different timing semantics. A version name never establishes playback speed — source manifests default to `unknown` timing unless explicitly attested; `provenance` carries source/model/algorithm hashes.

### Storage & retention (`backend/app/core/`)

Local filesystem + JSON artifacts under `data/` (all gitignored). `storage.atomic_write` (unique temp + fsync + replace) and `storage.analysis_lock` (64 fixed fcntl stripes — never unlink a live lock) serialize analysis creation, deletion, legacy migration, and the retention sweep across threads/processes. Uploaded videos + replay keypoints have a media TTL (`ONEMOTION_MEDIA_TTL_HOURS`, default 24); `main.py` lifespan runs a startup cleanup + 15-min sweep that removes expired media while keeping the compact report. Analysis creation rolls back all its files on any failure.

### Config (`backend/app/core/config.py`)

All settings use the `ONEMOTION_` env prefix. `get_settings()` is `lru_cache`d; tests override it. Key vars: `ONEMOTION_DATA_DIR`, `ONEMOTION_POSE_BACKEND`, `ONEMOTION_MODEL_PATH`, `ONEMOTION_ARTIFACT_MANIFEST`, `ONEMOTION_ANALYSIS_CONCURRENCY` (default 1), `ONEMOTION_ANALYSIS_TIMEOUT_S` (default 120), `ONEMOTION_ALLOWED_ORIGINS`, `ONEMOTION_WARM_MODEL`. Frontend: `NEXT_PUBLIC_API_BASE` (browser, build-time), `ONEMOTION_API_BASE` (server render, runtime) — resolved in `apps/web/lib/api.ts`.

### Resource limits

Upload capped at 50 MB / 12 s. YOLO decoder budget: 12 s, 1440 frames, 4K px, 120 fps. Timeout is checked cooperatively between frame calls (not a hard interrupt of native code). `inference_slot` bounds concurrency; a busy request returns **429 with Retry-After**. Keep one Uvicorn worker.

### Frontend (`apps/web/app/`)

App Router. `record/` (getUserMedia) and `upload/` both POST to `/api/v1/analysis`; `analysis/[id]/page.tsx` renders the report (compact response) and `skeleton-replay.tsx` fetches the heavy keypoint/per-frame-metric sequences separately from `/replay`. Overlay drawing follows `requestVideoFrameCallback` (not a UI timer) so skeletons don't drift from the video. Sync mode maps a chosen dip/release anchor to a shared zero while keeping each video's real rate; independent mode gives per-video play/scrub/phase-jump/single-frame controls. API errors: implemented routes use `{detail: string}` + HTTP status; the pose stub uses `{error: {code, message}}`; `lib/api.ts` `responseError` normalizes both.

## Conventions

- Brand is **OneMotion** / `onemotion` / `ONEMOTION` — `scripts/check_branding.py` fails CI on the retired spelling in any tracked text file.
- Reference media stays local-only (distribution rights not asserted). Rebuilding artifacts changes file hashes via creation timestamps — run `release_artifacts.py` after reviewing a rebuild; don't disable integrity checks.
- The "convert my oblique clip to a 90° side view" feature is **intentionally not built** — see the validation gate in `docs/ARCHITECTURE.md` §11 before touching anything in that direction.
- `POST /api/v1/pose/estimate` is a deliberate 501 stub; analysis runs pose inline.
