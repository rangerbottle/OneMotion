# OneMotion — Architecture

Version: 0.3 · Date: 2026-10-04 · Companion to [PRD.md](PRD.md)

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
| Server pose (working dev) | Ultralytics YOLO-pose (yolo11n-pose) | Pure CPU, native COCO-17, zero config. Default `ONEMOTION_POSE_BACKEND=yolo` |
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

Versioning: benchmark JSON carries `{version, created_at, source_clips, backend, schema_version}`. The active registry exposes only `curry_v3`, built from exactly 0:00–0:03 of the source clip. The local source's playback speed is not independently verified: its timing mode remains `unknown`, and timing comparisons stay disabled. Retired template IDs return HTTP 410 so a stale client cannot silently compare against different timing semantics.

## 5. Player pipeline (online)

Two capture modes, one analysis path:

- **Upload**: browser POSTs the clip to `POST /api/v1/analysis` (multipart). Server runs pose extraction with the configured backend, then the shared path.
- **Camera**: browser records a clip, then uploads it through the same endpoint. Upload and record pages show a 90° side-view setup guide before analysis.

Shared path: `validate upload → pose → segment → compute_all → measurement_evidence → capture_quality → metric_deltas → comparison policy → confidence-weighted category scores → feedback.rank → AnalysisResult`. The input is capped at 50 MB and 12 seconds. Feedback is emitted only for reliable measurements and carries confidence, severity, benchmark evidence, and sample count. With Curry v3's current `n=1`, the UI deliberately labels values as a single reference rather than presenting a misleading IQR.

`analysis/results.py` owns pure result construction and comparison eligibility.
Fresh analysis, repeated comparison, legacy migration and compact reports whose
media expired all use the same policy. Raw measurement evidence is separate from
capture and reference-timing gates; migrations fill missing evidence without
upgrading a persisted rejection. Applying policy twice yields the same result
and does not require replay media. Routes retain storage, locking, inference,
artifact verification and rollback responsibilities.

`analysis.biomechanics` also derives a value record for every decoded pose frame. Each record contains elbow flexion, left/right knee flexion, forearm elevation, trunk lean, wrist vertical speed, and a release-angle proxy on the release frame. Every value includes units, confidence, reliability, and a nullable value. Missing or weak joints stay null instead of being imputed into apparent measurements.

Feedback engine is **rule-based** (v1): an ordered rule table maps delta patterns to cues, each rule carrying a priority weight and a drill cue. Rules are data (Python dicts/JSON), not scattered ifs, so trainers can tune them without code changes.

## 6. API surface (v1)

| Endpoint | Purpose | Status in skeleton |
| --- | --- | --- |
| `GET /health` / `GET /ready` | liveness / artifact and storage readiness | implemented |
| `POST /api/v1/pose/estimate` | frame/clip → `ShotSequence` | stub (501-style payload) |
| `GET /api/v1/benchmarks/current` | compatibility current benchmark profile | implemented |
| `GET /api/v1/templates` | active Curry v3 metadata | implemented |
| `GET /api/v1/templates/{id}/video` | canonical 3-second template video | implemented |
| `GET /api/v1/templates/{id}/source-video` | complete original footage, verified against provenance | implemented |
| `POST /api/v1/analysis` | video → Curry v3 evidence-aware `AnalysisResult` | implemented |
| `GET /api/v1/analysis/{id}` | fetch a stored result | implemented |
| `GET /api/v1/analysis/{id}/comparison` | retrieve the active v3 comparison | implemented |
| `GET /api/v1/analysis/{id}/replay` | both frame sequences, phase anchors, sync windows, frame metrics, and video URLs | implemented |
| `GET /api/v1/analysis/{id}/video` | TTL-bound original player video | implemented |
| `DELETE /api/v1/analysis/{id}` | remove result, keypoints, and uploaded media | implemented |
| `POST /api/v1/training/sessions` | immutable manual shooting outcomes, UUID-idempotent save, server-derived totals | implemented |
| `GET /api/v1/training/sessions?limit=100` | recent sessions and weighted all-history summary | implemented |

Request/response models live in `backend/app/schemas/`. Implemented analysis errors use HTTP status plus `{detail: string}`; the pose stub uses `{error: {code, message}}`. The web client normalizes both and preserves status for recovery.

## 7. Frontend structure

```
apps/web/app/
  page.tsx              # home: value prop + start CTA
  drills/               # searchable shooting library, court diagrams, 12 drill details
  training/             # per-drill runner and ordered workout stages
  progress/             # persistent manual session history and weighted totals
  record/page.tsx       # camera capture (getUserMedia) and upload
  upload/page.tsx       # file upload → POST /api/v1/analysis
  homecourt/page.tsx    # exported training video → selected shot → analysis
  homecourt/clip-selector.tsx # shared preview/window/subject selector for compare
  capture-guide.tsx     # 90° side-view recording guidance
  analysis/[id]/page.tsx# v3 report: scores, capture quality, evidence, phases
  analysis/[id]/skeleton-replay.tsx # video overlays + synced/independent controls
apps/web/lib/api.ts     # typed fetch client, browser/server API split
```

The report fetches heavy keypoint and per-frame metric sequences only from the replay endpoint; the persisted analysis response remains compact. Overlay drawing follows the video's presented frame via `requestVideoFrameCallback` where available, so skeletons and values do not advance on a UI timer. Sync mode maps the selected Curry/player phase anchor to a shared zero point while preserving each video's real playback rate. Independent mode exposes separate play, scrub, phase jump, and single-pose-frame controls.

Uploaded source videos and keypoint artifacts have an explicit media TTL. A startup cleanup and 15-minute background sweep remove expired media and replay keypoints while retaining the compact analysis report. Full deletion remains available through the API.

### Shooting practice and manual outcomes

The training catalog is original application data in `lib/drills.ts`. Three
workouts reference ordered drill IDs; each stage produces its own session.
Suggestions from an analysis require both an evidence-gated feedback item and
a reliable, non-null metric. A generic library remains available when no
specific correction clears that gate.

`lib/training-draft.ts` separates ordered make/miss outcomes from rendering.
The runner keeps one browser draft, restores it on reload, supports undo, and
uses a wall-clock deadline for rest rather than decrementing a timer that
would drift in a background tab. The first save freezes the entire request,
including completion time, for identical retries after uncertain failures.
Storage-change warnings and snapshot checks prevent ordinary stale-tab
overwrites; successful saves clear only the exact submitted draft.

`training/store.py` persists JSON with atomic writes and the existing fixed
lock stripes under `data/training/sessions/`. These records have no media TTL
and are gitignored. The schema accepts known drill IDs, UUIDv4 identity,
timezone-aware start/end clocks, a bounded plan, sequential boolean outcome
groups, and partial/completed status. Totals and weighted accuracy are server
derived; empty accuracy is null. The history response returns at most 100
records, retaining bounded record memory while scanning all saved records for
the summary. This local installation has one shared ledger; accounts, cloud
sync, automatic make/miss recognition, and linked analysis history are future
work. See [TRAINING.md](TRAINING.md) for limits and validation.

### HomeCourt video imports

The existing analysis and compare clip multipart endpoints accept an optional
`source` JSON field (`ClipImportRequest`). A HomeCourt declaration contains a
0-based source interval in milliseconds (positive, at most 12 seconds), playback
mode (`unknown` by default, `realtime`, or `slow_motion`), optional training
timestamp/camera label, and an optional normalized subject rectangle. Client
metadata cannot supply integrity hashes or unknown fields.

`core/media_import.py` streams a bounded original upload into temporary storage
(200 MiB, 10 minutes, 4K pixels, 120 fps), checks the declared interval, and runs
the bundled ffmpeg under the existing inference concurrency slot with a 60-second
timeout shared by timestamp scanning and extraction. The interval snaps to the
frame already presented at the start and the next frame boundary at the end;
actual boundaries and the requested interval are both retained. A snapped window
over 12 seconds is rejected with guidance to shorten it. Extraction keeps the
full frame and the intervals between presentation timestamps, uses H.264
yuv420p with faststart, removes audio, and pads odd dimensions by at most one
pixel. The selected clock starts at zero; playback speed and motion scale stay
unchanged. The temporary original is removed after success or failure; expired
temporary directories left by a process crash are swept under the clip lock.
The returned clip must pass the existing 50 MiB / 12-second decoder
validation before pose runs under its own concurrency slot. Extraction releases
its slot first to avoid nested-slot deadlock. Route rollback covers all retained
files if later inference/persistence fails.

`MediaSource` adds server-computed original and selected SHA-256 values and the
original filename. `AnalysisResult.source` and `ClipMeta.source` preserve this
metadata through reload, re-comparison, migration and report expiry. Old records
without source metadata retain their established behavior. Analysis clips follow
the media TTL; personal history clips remain persistent data assets.

YOLO chooses only person detections with box centers inside the subject rectangle,
using the same largest-person/nearest-center rule among eligible people. A frame
without an eligible person retains a confidence-zero placeholder. Coordinates
remain normalized to the full source frame; another person never replaces a
missing selected subject outside the rectangle. Other backends reject a subject
rectangle rather than silently ignoring it.

Unknown or slowed source playback disables timing comparison, timing scores and
timing feedback, without modifying raw measurement evidence or joint confidence.
Replay wrist velocity is unavailable unless the source clock is declared real
time; the reference has its independent attestation gate. Phase times remain
visible as video times. History replay offsets are playback alignment, and report
phase-start offsets are omitted when either clip has an uncertain clock. Frame
boundaries use stored presentation timestamps rather than average frame rate.
The Nginx gateway permits 201 MiB only on the two upload paths, leaving application
limits authoritative. The first version consumes exported video; it has no
HomeCourt account integration, stats schema or automatic shot discovery.

### Player history comparison

`/compare/[id]` compares two clips from the same camera position using a spatial
affine B→A and a global temporal offset. `comparison-controller.ts` owns loading,
the serialized save/export queue, retry drafts and request lifetime;
`use-comparison-workbench.ts` subscribes through React's external-store hook.
Controls and dialogs render that state separately from the canvas stage and
timeline. An old comparison's pending save retains its own ID and cannot update
a newly mounted comparison. A lightweight map retains only unfinished write
promises across mounts; returning to the same comparison waits for those writes
before loading, preventing an earlier page instance from overwriting new edits.

Compare request schemas validate finite transforms, positive scale, nonnegative
anchors, ordered phase ranges, unique phase/marker identifiers and clip bounds.
Invalid requests return HTTP 422 with a string `detail`. Temporal PATCH fields
merge with stored anchors; spatial PATCH retains replacement semantics with
identity defaults.

`compare/report.py` measures canonical joints in native source pixels before
the B→A affine and normalizes the residual by A's dimensions. Both report and
canvas select the latest pose at or before source time; fewer than eight shared
confident joints exclude a frame. Export reuses two video readers and writes
atomic PNGs with unique generation filenames. The comparison lock covers
generation and metadata commit. Old images are removed only after commit;
failure removes uncommitted images and keeps the previous report. Screenshot
serving accepts only URLs referenced by the current report.

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

`backend/app/core/config.py` reads `ONEMOTION_DATA_DIR`, `ONEMOTION_POSE_BACKEND`, `ONEMOTION_MODEL_PATH`, `ONEMOTION_ARTIFACT_MANIFEST`, `ONEMOTION_MEDIA_TTL_HOURS`, `ONEMOTION_ALLOWED_ORIGINS`, `ONEMOTION_WARM_MODEL`, and the optional Roboflow key. Frontend reads `NEXT_PUBLIC_API_BASE` in the browser and `ONEMOTION_API_BASE` for server rendering. No secrets are committed.

The Compose stack mounts `data/` read/write and `models/` read-only, starts the API only after artifact verification, and publishes only the Nginx gateway. The API and web containers run as an unprivileged user.

## 10. Testing strategy

- Backend: pytest covers API behavior, v3 retirement semantics, phase/comparison evidence, per-frame biomechanics, and capture-quality bounds; a real-clip endpoint round trip validates analysis, replay, media range requests, and cleanup.
- Frontend: ESLint, generated Next.js route types, TypeScript, Playwright browser regressions, and a production container build.
- Browser video fixtures are procedural source recipes. `npm test` generates
  ignored VP8/WebM outputs with FFmpeg/libvpx, including explicit VFR timestamps.
  Public source archives contain zero video files. Root `tests/test_packaging.py`
  verifies separation of source, private assets, credentials and temporary data.

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
- `POST /api/v1/pose/estimate` remains a 501 stub — analysis runs pose inline.

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

### Reliability and storage updates (2026-09-05)

Measurement evidence is persisted separately from template-dependent deltas.
Legacy reports retain their existing reliability decisions when compared again.
Tempo depends on load, lift, and release; benchmark aggregation applies the same
checks as player scoring. Frame velocity requires a reliable body scale, adjacent
wrist samples and strictly increasing local timestamps.

Uploads are preflighted and YOLO checks resource limits while decoding. Analysis
creation rolls back its files on failure, writes use unique atomic temporaries,
and fixed advisory-lock stripes serialize migration, deletion, and retention
across threads/processes on the local filesystem. Old orphan files are swept;
active analysis work is protected by the same lock. Video and skeleton access
check the deadline directly, including legacy inline skeletons.

The template registry preserves artifact timing/source metadata. New benchmark
builds record source/model/algorithm hashes. Explicit release pinning is separate
from numerical reproducibility because creation timestamps change file hashes.
See `docs/EVALUATION.md` for the evaluation contract and remaining human labels.

## 12. View-matched Curry reference library (proposed)

The [footage shortlist](CURRY_REFERENCES.md) and its
[research catalog](research/curry-reference-candidates.json) describe sources
reviewed on 2026-10-08. They are research artifacts, not runtime configuration.
Only `curry_v3` remains active. None of the new sources has a validated complete
shot, camera calibration or attested real-time clock.

The viewing stage is implemented at `/references`. It is linked from `/analyze`
and every available analysis report, keeps Analyze active in the shared
navigation, and preserves a validated report ID in its return link. URL filters
compose camera view and platform; an explicit source selection survives reload.
Pure side-view coverage is an honest empty state, and sources without visual
review are grouped under View unreviewed.

`apps/web/lib/curry-references.ts` contains curated English display metadata
inside the standalone web package. Browser regressions check source identity,
speed uncertainty, review status and bookmarks against the research catalog;
the app does not import research documents at runtime. YouTube/Bilibili embeds
load only after a user action, do not autoplay, and are unloaded when the source
changes. Source links remain available independently of embedded playback. The
existing full local Curry source viewer is shared with reports; the library
does not infer the current report's timing eligibility from playback.

### Why more views need separate admission

`analysis/metrics.py` measures projected 2D elbow/knee angles, forearm elevation
and trunk displacement. A front or rear projection changes those quantities
even when the underlying movement is identical. Body-height normalization does
not remove that projection error. Rear views can also lack the eye evidence
used to estimate standing height.

`analysis/capture_quality.py` estimates side-view likelihood from projected
shoulder/hip width relative to torso height. It cannot classify exact yaw or
reliably distinguish front from rear. Its current rejection and score policies
must remain in force until a replacement is evaluated. The ORB camera check in
`compare/alignment.py` matches the same scene across personal-history clips;
different courts and backgrounds prevent reusing it as a Curry view classifier.

The benchmark builder currently aggregates same-named metrics across its input
clips without a reference-view admission check. It also uses default pose
subject selection, without a per-shot ROI. A high-confidence skeleton can be
the wrong person in a crowded workout. New source files therefore must not be
added to the builder's scanned directory as if they were ready benchmark clips.

### Admission sequence

1. **Select and annotate individual shots.** Prefer publisher sources and trace
   reposts to a source family. Deduplicate actual shots, not URLs. Record the
   shooting action, athlete identity, source timestamps, native image/padding,
   camera view, mirrored status, usable joints, camera motion and foreground
   occlusion. Inspection points and video chapters are only review bookmarks.
2. **Preserve provenance and the source clock.** Keep local media and hashes
   outside Git. Record requested and actual extracted boundaries. Validate
   presentation timestamps before any conversion: the current
   `prepare_reference_clip.py` writes at nominal FPS and does not preserve an
   arbitrary variable-frame-rate timeline. Reuse and verify the HomeCourt
   timestamp strategy before supporting such references. Source FPS, browser
   playback rate and a normal-looking motion do not attest real-time recording.
   Explicit slow motion with unknown scale remains ineligible for tempo.
3. **Offer reference viewing first — implemented.** Users can manually choose
   camera-view categories and play candidate sources independently. The library
   displays review, visibility and timing limitations. A view selection grants
   no scoring eligibility and does not assert an automatic camera match.
4. **Validate each view before scoring.** Build separate view/action cohorts,
   manually verified phase boundaries and metric eligibility lists. Split
   evaluation by source/recording session and player to avoid duplicate-shot
   leakage. Evaluate athlete selection, joint evidence, phase accuracy and
   metric error on held-out examples using the contract in
   [EVALUATION.md](EVALUATION.md). Similar-looking views alone are insufficient.
   A view without validated metrics stays display-only; never pool projected
   side/front/rear angles into one median or use one clip as a distribution.
5. **Version and release admitted references.** Add an explicit view-aware
   schema and registry only after evaluation. The current `ReferenceClip`
   provenance schema does not retain arbitrary camera fields. Integrate
   per-shot subject selection, capture/evidence gates, integrity checks,
   rollback and replay metadata before activating any new template. Retain the
   original measurement evidence when re-comparing existing reports.

Source admission, calibration and scoring validation remain future work. The
viewing library does not implement a view classifier, enable front/rear scoring,
normalize a clip into a synthetic side view or change the artifact release.
