# OnMotion — Architecture

Version: 0.2 · Date: 2026-09-05 · Companion to [PRD.md](PRD.md)

## 1. System overview

```
┌────────────────────────────┐          ┌──────────────────────────────────────┐
│  apps/web (Next.js)        │          │  backend (FastAPI)                   │
│                            │  HTTPS   │                                      │
│  /record  getUserMedia ────┼────────► │  api/            REST routers        │
│  /upload  file input       │  JSON +  │  pose/           pluggable backends: │
│  /analysis report + replay │  video   │    yolo_backend (current default)    │
│  90° capture guidance      │          │  analysis/       phases → metrics →  │
│  synced/independent video  │          │    comparison → feedback + replay    │
│  + frame-level metrics     │          │  core/           artifacts + expiry  │
└────────────────────────────┘          │  benchmarks/     curry profile build │
                                        │  scripts/        CLI entry points    │
                                        └──────────────┬───────────────────────┘
                                                       │
                                        data/ (local filesystem, S3-compatible later)
                                          raw_videos/  keypoints/  benchmarks/
```

Two pipelines share one pose + metrics core:

- **Benchmark pipeline** (offline, batch): Curry clips → pose backend → phase segmentation → per-shot metrics → aggregated, versioned benchmark profile JSON.
- **Player pipeline** (online, per-request): uploaded clip → server-side pose → the same segmentation/metrics → comparison vs. benchmark → feedback and a timestamp-preserving replay payload.

## 2. Technology choices

| Concern | Choice | Rationale |
| --- | --- | --- |
| Player app | Next.js 16 (App Router, TypeScript, Tailwind) | Web-first; camera via getUserMedia; easy mobile wrap later |
| Backend | FastAPI (Python 3.13, uv) | Python owns the CV/ML ecosystem; async upload handling |
| Server pose (working dev) | Ultralytics YOLO-pose (yolo11n-pose) | Pure CPU, native COCO-17, zero config. Default `ONMOTION_POSE_BACKEND=yolo` |
| ~~Dev/fallback pose~~ | ~~MediaPipe BlazePose (Python)~~ | Rejected: mediapipe 1.x crashes on this macOS host (graph initializes Metal even with CPU delegate). `pose/mediapipe_backend.py` kept for browser parity only |
| Comparison | Phase anchors + normalized phase progress | Shots differ in speed; explicit anchors preserve timing semantics and avoid hiding tempo errors |
| Storage (MVP) | Local filesystem + JSON artifacts | Zero infra; S3/Postgres when sessions/users land |
| Deployment | Docker Compose: Nginx → Next.js + FastAPI | One browser origin, health-gated startup, immutable app images, host-mounted local artifacts |

## 3. Canonical pose schema

Backends adapt to one interchange format so analysis code is backend-agnostic.

- **Canonical schema: COCO-17** (`nose, eyes, ears, shoulders, elbows, wrists, hips, knees, ankles`). Sufficient for all v1 metrics.
- BlazePose-33 is mapped down to COCO-17 at the adapter boundary (mapping table lives in `pose/base.py`).
- Frame model: `PoseFrame { frame_idx, t_ms, keypoints: [{name, x, y, confidence}] }`, coordinates normalized to `[0,1]` image space; a `ShotSequence` adds fps and source dimensions. One record is emitted for every decoded video frame. A missed detection becomes a confidence-zero COCO-17 placeholder so source-frame mapping never drifts.

Key implementation rules:

- Every metric consumes only the canonical schema; never backend-specific indices.
- Low-confidence keypoints (< 0.5) may be interpolated only for trajectory continuity; raw confidence still gates phases, metrics, scores, and feedback. Unrecoverable frames mark the phase segment as degraded.

## 4. Benchmark pipeline (offline)

Entry point: `backend/scripts/build_curry_benchmark.py` → writes `data/benchmarks/curry_v{N}.json`.

Stages:

1. **Ingest** — scan `data/raw_videos/curry/*.mp4`, or pass exact repeated `--clip` paths for a single-reference template.
2. **Pose extraction** — configured backend (`yolo` by default); one timestamp-preserving `ShotSequence` per clip.
3. **Phase segmentation** — `analysis.phases.segment(sequence)`:
   - `dip`: visible descent before the dip bottom
   - `load`: timestamp window around minimum shooting-wrist height
   - `lift`: sustained wrist rise toward the apex
   - `release`: first frame reaching 97% of local maximum elbow extension near the wrist apex
   - `follow_through`: release → shooting wrist drops below its elbow, capped at one second; cap hits are marked censored
4. **Metrics** — `analysis.metrics.compute_all(sequence, phases)` → per-shot metric dict (definitions in PRD §6).
5. **Aggregate** — median + IQR per metric across clips; store per-phase timing profile and the median pose sequence (for overlay replay) as the benchmark.

Versioning: benchmark JSON carries `{version, created_at, source_clips, backend, schema_version}`. The active registry exposes only `curry_v3`, built from exactly 0:00–0:03 of the requested real-time clip. Retired template IDs return HTTP 410 so a stale client cannot silently compare against different timing semantics.

## 5. Player pipeline (online)

Two capture modes, one analysis path:

- **Upload**: browser POSTs the clip to `POST /api/v1/analysis` (multipart). Server runs pose extraction with the configured backend, then the shared path.
- **Camera**: browser records a clip, then uploads it through the same endpoint. Upload and record pages show a 90° side-view setup guide before analysis.

Shared path: `validate upload → pose → segment → compute_all → capture_quality → measurement_evidence → metric_deltas → confidence-weighted category scores → feedback.rank → AnalysisResult`. The input is capped at 50 MB and 12 seconds. Feedback is emitted only for reliable measurements and carries confidence, severity, benchmark evidence, and sample count. With Curry v3's current `n=1`, the UI deliberately labels values as a single reference rather than presenting a misleading IQR.

`analysis.biomechanics` also derives a value record for every decoded pose frame. Each record contains elbow flexion, left/right knee flexion, forearm elevation, trunk lean, wrist vertical speed, and a release-angle proxy on the release frame. Every value includes units, confidence, reliability, and a nullable value. Missing or weak joints stay null instead of being imputed into apparent measurements.

Feedback engine is **rule-based** (v1): an ordered rule table maps delta patterns to cues, each rule carrying a priority weight and a drill cue. Rules are data (Python dicts/JSON), not scattered ifs, so trainers can tune them without code changes.

## 6. API surface (v1)

| Endpoint | Purpose | Status in skeleton |
| --- | --- | --- |
| `GET /health` / `GET /ready` | liveness / artifact and storage readiness | implemented |
| `POST /api/v1/pose/estimate` | frame/clip → `ShotSequence` | stub (501-style payload) |
| `GET /api/v1/benchmarks/current` | compatibility current benchmark profile | implemented |
| `GET /api/v1/templates` | active Curry v3 metadata | implemented |
| `GET /api/v1/templates/{id}/video` | canonical template source video | implemented |
| `POST /api/v1/analysis` | video → Curry v3 evidence-aware `AnalysisResult` | implemented |
| `GET /api/v1/analysis/{id}` | fetch a stored result | implemented |
| `GET /api/v1/analysis/{id}/comparison` | retrieve the active v3 comparison | implemented |
| `GET /api/v1/analysis/{id}/replay` | both frame sequences, phase anchors, sync windows, frame metrics, and video URLs | implemented |
| `GET /api/v1/analysis/{id}/video` | TTL-bound original player video | implemented |
| `DELETE /api/v1/analysis/{id}` | remove result, keypoints, and uploaded media | implemented |

Request/response models live in `backend/app/schemas/`. Errors use RFC-7807-ish `{error: {code, message, details}}`.

## 7. Frontend structure

```
apps/web/app/
  page.tsx              # home: value prop + start CTA
  record/page.tsx       # camera capture (getUserMedia) and upload
  upload/page.tsx       # file upload → POST /api/v1/analysis
  capture-guide.tsx     # 90° side-view recording guidance
  analysis/[id]/page.tsx# v3 report: scores, capture quality, evidence, phases
  analysis/[id]/skeleton-replay.tsx # video overlays + synced/independent controls
apps/web/lib/api.ts     # typed fetch client, browser/server API split
```

The report fetches heavy keypoint and per-frame metric sequences only from the replay endpoint; the persisted analysis response remains compact. Overlay drawing follows the video's presented frame via `requestVideoFrameCallback` where available, so skeletons and values do not advance on a UI timer. Sync mode maps the selected Curry/player phase anchor to a shared zero point while preserving each video's real playback rate. Independent mode exposes separate play, scrub, phase jump, and single-pose-frame controls.

Uploaded source videos and keypoint artifacts have an explicit media TTL. A startup cleanup and 15-minute background sweep remove expired media and replay keypoints while retaining the compact analysis report. Full deletion remains available through the API.

## 8. Data layout

```
data/
  raw_videos/curry/        # source clips (manual collection, gitignored)
  uploads/<analysis_id>.*  # original player clips, TTL-bound (gitignored)
  analyses/<analysis_id>.json # compact results (gitignored)
  keypoints/<analysis_id>.json # replay ShotSequence (gitignored)
  benchmarks/curry_vN.json # versioned benchmark profiles (gitignored for now)
```

The active v3 benchmark and reference video are required for readiness and analysis. They remain local-only because source distribution rights are not asserted. `infra/artifacts.json` pins their byte sizes and SHA-256 checksums, along with the pose model, so deployment fails readiness checks instead of accepting an accidental replacement.

## 9. Configuration & secrets

`backend/app/core/config.py` reads `ONMOTION_DATA_DIR`, `ONMOTION_POSE_BACKEND`, `ONMOTION_MODEL_PATH`, `ONMOTION_ARTIFACT_MANIFEST`, `ONMOTION_MEDIA_TTL_HOURS`, `ONMOTION_ALLOWED_ORIGINS`, `ONMOTION_WARM_MODEL`, and the optional Roboflow key. Frontend reads `NEXT_PUBLIC_API_BASE` in the browser and `ONMOTION_API_BASE` for server rendering. No secrets are committed.

The Compose stack mounts `data/` read/write and `models/` read-only, starts the API only after artifact verification, and publishes only the Nginx gateway. The API and web containers run as an unprivileged user.

## 10. Testing strategy

- Backend: pytest covers API behavior, v3 retirement semantics, phase/comparison evidence, per-frame biomechanics, and capture-quality bounds; a real-clip endpoint round trip validates analysis, replay, media range requests, and cleanup.
- Frontend: ESLint plus a full Next.js production type/build check.

## 11. Roadmap

1. **M0** — repo, docs, runnable skeleton, stubbed APIs. ✅
2. **M1** — pose backend + phase segmentation + metrics + benchmark script. ✅ (landed with YOLO-pose instead of MediaPipe — MediaPipe's Python package crashes on this macOS host; YOLO-pose outputs COCO-17 natively and runs on CPU)
3. **M2** — evaluate a higher-accuracy pose backend on an annotated shot set; promote it only after it beats YOLO on joint error and phase accuracy.
4. **M3** — upload analysis end-to-end; comparison + feedback rules; report UI. ✅
5. **M4** — camera record flow, 90° capture guide, frame-locked skeleton/metric replay, and synchronized Curry comparison. ✅ (live pose-based capture pre-check remains)
6. **M5** — sessions/history, trend charts; accounts if needed.

### MVP notes / known limitations (measured on the first Curry clip)

- **Release detection** = first frame reaching 97% of local maximum elbow extension
  in a bounded window around the wrist apex. The shorter post-apex window avoids
  later arm swings and left/right label swaps.
- **`release_angle_deg`** is the forearm elevation proxy, not the ball launch
  angle — the wrist joint is nearly stationary during the release snap, so a
  velocity proxy reads ~0/down. Ball tracking (v2) replaces this.
- **Occluded dips**: when the true dip is not visible, `load` falls back to the
  confidence-bounded shot-window start and affected phases are degraded. Those
  measurements lose reliability instead of silently influencing feedback.
- **Metrics are confidence-gated**: each result reports pose confidence,
  keypoint coverage, benchmark sample count, IQR, delta percentage, and robust
  z-score where possible. Unreliable values remain visible with a reason but do
  not affect scores or coaching suggestions.
- `GET /api/v1/pose/estimate` remains a 501 stub — analysis runs pose inline.

### View-normalization experiment gate

The app intentionally does not offer a “convert my clip to 90°” checkbox yet.
A single oblique RGB view does not contain enough information to reconstruct the
occluded body and ball trajectory uniquely; a generative model can create a
plausible-looking side view while changing the elbow, knee, release, or timing
evidence being measured. That would turn a presentation effect into fabricated
biomechanics.

This can graduate from research only if an implementation:

1. reconstructs a metric-preserving 3D pose/ball representation rather than
   measuring pixels from a generated video;
2. is validated against synchronized multi-camera ground truth across camera
   yaw, body types, handedness, occlusion, and clothing;
3. reports uncertainty per joint/frame and disables affected coaching when the
   threshold is missed; and
4. keeps the original clip and labels any rendered 90° view as synthetic.

Until then, capture-quality guidance is the accurate product behavior: detect
whether a clip is likely usable for 2D side-view comparison, explain the limits,
and ask for a better recording when necessary.
