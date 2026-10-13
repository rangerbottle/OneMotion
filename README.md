# OneMotion

Learn Stephen Curry's one-motion jump shot with computer vision.

OneMotion builds a biomechanical benchmark from Stephen Curry's shooting footage, captures your own shot from an uploaded clip or live camera, and compares the two motions — release posture, shot tempo, lower-body loading, and more — to give concrete, Curry-specific feedback. The current reference is Curry v3: the first three seconds of the configured source clip; timing comparison is enabled only when real-time playback is independently attested.

## Monorepo layout

For a minimal local archive or a GitHub submission archive containing **no
video files**, see [packaging instructions](docs/PACKAGING.md). Both include a
video-link inventory; local media, model weights and personal data stay out of
the GitHub archive. [Third-party notices](THIRD_PARTY_NOTICES.md) document the
separate font and media licensing scope.

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
- `infra/artifacts.json` — the checksum manifest for the three files above. It is **generated locally and gitignored** (not committed): `scripts/release_artifacts.py` pins it from whatever media you built, and `./dev.sh start` / `./dev.sh media` creates it on first setup only; an existing manifest with mismatched hashes must be reviewed and explicitly re-pinned. `compose.yaml` bind-mounts it, so it must exist on the host before `docker compose up` (otherwise Docker creates an empty directory there and the API never passes `/ready`).

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

# one-time: install pose model weights before the analysis integrity gate
mkdir -p ../models
curl -L --fail -o ../models/yolo11n-pose.pt \
  https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo11n-pose.pt

# Keep the full approved source at curry_v3_source.mp4; v3 uses 0:00–0:03.
# H.264 encoding preserves the selected frames and source playback rate.
uv run python scripts/prepare_reference_clip.py \
  ../data/raw_videos/curry/curry_v3_source.mp4 \
  ../data/raw_videos/curry/curry_v3_reference.mp4 --start-ms 0 --end-ms 3000 \
  --provenance ../data/raw_videos/curry/curry_v3_sources.json \
  --timing-mode unknown \
  --source-url https://www.bilibili.com/video/BV14u411J7qS/
uv run python scripts/build_curry_benchmark.py \
  --clip ../data/raw_videos/curry/curry_v3_reference.mp4 \
  --out ../data/benchmarks/curry_v3.json \
  --input-manifest ../data/raw_videos/curry/curry_v3_sources.json

# Review the new profile, then explicitly pin its model/profile/video hashes.
# This writes infra/artifacts.json (local-only, gitignored). ./dev.sh start and
# ./dev.sh media creates an initial manifest but refuses to accept changed hashes.
# Use --timing-mode realtime --time-scale 1 only after verifying the source rate.
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

## Shooting practice

The dashboard at `/` is the shared entry to **Training**, **Progress**,
**Analyze**, and **Compare**. `/analyze` brings camera recording, clip upload,
and HomeCourt import into one video entry. All pages share English interface
copy, the self-hosted Geist Sans font, and one light/dark color palette.
Existing report and capture URLs remain usable; user-entered names and source
metadata are preserved in their original language.

Start at `/drills` for 12 original shooting drills, court diagrams, and three
ordered workouts. `/training` records makes and misses manually, supports undo
and rest breaks, and restores unfinished work from this browser's draft.
Saving writes an immutable local session; retries reuse its UUID and cannot
double-count the same record. `/progress` shows weighted totals and recent
sessions. Empty accuracy stays unavailable rather than reporting 0%.

Reliable analysis feedback links to matching drills. These practice records
are separate from pose scores and do not imply automatic shot recognition or
a HomeCourt account connection. See [the training contract](docs/TRAINING.md)
for persistence, shared-installation limits, and the next validation steps.

## HomeCourt imports

Open `/homecourt` to import a video exported from HomeCourt. Preview the original
and select one complete shot (at most 12 seconds), then choose Curry analysis or
your own history comparison. For multiple people, pause the video, mark the
shooter's area and confirm the subject. This selects detections in the original
frame; it does not crop or synthesize a camera angle.

Imports accept MP4, MOV or WebM sources up to 200 MiB and 10 minutes, with the
existing 4K-pixel and 120-fps limits. The server aligns the window to actual video
frame boundaries and extracts a full-frame H.264 clip,
then applies the normal 50 MiB / 12-second inference limits. Only the selected
clip is retained; temporary original uploads are deleted after extraction or
failure. Filename, original/selected SHA-256, source interval, optional training
timestamp and camera label remain in the analysis or clip metadata. When frame
alignment changes the interval, both the requested and actual boundaries are
recorded. The actual retained window must also fit within 12 seconds.

Playback speed defaults to unknown. Unknown or slow-motion sources cannot
produce timing scores, timing feedback or wrist-speed measurements; replay and
eligible pose measurements remain available. A user's real-time declaration
does not override an unverified Curry reference. History comparisons still
require the same camera position. The import handles exported videos; it does
not connect a HomeCourt account or import training statistics.

## Status

MVP working end-to-end: YOLO-pose extraction → shot-phase segmentation →
biomechanical metrics → comparison against Curry v3 → evidence-aware feedback.
The report overlays the skeleton and frame-level measurements directly on both
source videos. The analysis page also offers the complete local source when its checksum matches
the benchmark provenance. The two reference/player clips can follow a shared dip/release anchor or be played,
scrubbed, phase-jumped, and advanced one pose frame at a time independently.

Important interpretation limits: Curry v3 is currently one reference shot, so
its values are a reference, not a population distribution. `release_angle_deg`
is a 2D forearm-elevation proxy rather than measured ball launch angle. The app
does not synthesize a side view from an oblique upload: monocular view generation
can hallucinate joint geometry and would make the resulting biomechanics unsafe
to compare. See [the architecture notes](docs/ARCHITECTURE.md) for the validation
gate required before that experiment can be exposed.

## Verification and operation

Run `uv run pytest -q` from `backend`; run `python3 -m unittest discover -s tests -v`
from the repository root for package-boundary checks. Install FFmpeg with libvpx
(or set `FFMPEG_PATH`) so `npm test` can generate synthetic video fixtures locally.
Run `npm run lint`, `npm run typecheck`,
`npx playwright install chromium`, `npm test`, and `npm run build` from `apps/web`.
CI runs these checks and builds both containers without private reference media.
Browser tests use synthetic fixtures on ports 3109 and 8129.

`uv run python scripts/smoke_homecourt.py --source <local-video> --output <result.json>`
verifies extraction, source hashes, speed gates, replay and personal-history
report export using real pose inference in isolated storage. It does not verify
the origin or playback speed of the supplied video.

All application settings use the `ONEMOTION_` prefix. Update existing deployment
variables when upgrading. `ONEMOTION_ANALYSIS_CONCURRENCY` defaults to 1 per API
process; `ONEMOTION_ANALYSIS_TIMEOUT_S` defaults to 120 seconds. The supported
YOLO decoder enforces a 12-second, 1440-frame, 4K-pixel/120-fps budget, including
clips with incomplete metadata. Inference checks the timeout between frame calls;
it is not a hard interruption of a native decoder or model call. Busy requests
return 429 with Retry-After. Keep one Uvicorn worker for the configured CPU budget.

On Linux, prepare writable bind mounts for the API's UID/GID 10001. For a new
installation, create `data/analyses`, `data/uploads`, `data/keypoints`, and
`data/.locks`, `data/training/sessions`, plus `data/compare/{players,templates,clips,videos,comparisons,reports}`,
and assign these directories to that UID/GID before starting Compose. `/ready`
checks every writable storage location and the configured artifact paths.

Reference files stay local, and so does the `infra/artifacts.json` manifest that
pins them (gitignored — initial setup can generate it via `./dev.sh media`;
subsequent changes require an explicit `release_artifacts.py` invocation). Rebuilding changes
creation metadata and therefore the release hash; use `release_artifacts.py`
after reviewing a rebuild rather than disabling integrity checks. A version name
alone never establishes playback speed. Source manifests default to unknown
timing unless explicitly attested.

See [the improvement ledger](docs/IMPROVEMENTS.md) for verification status and
[the evaluation guide](docs/EVALUATION.md) for frozen-pose accuracy/regression cases.

**Analyze → Explore Curry references** opens `/references`: a library of eight
YouTube and Bilibili sources, with camera-view/platform filters, review bookmarks,
on-demand external players and links back to an analysis report. The full local
Curry source is also available there. The [footage shortlist](docs/CURRY_REFERENCES.md)
records cropped or occluded footage, speed disclosures and duplicate source
families. These videos support visual study; the
[view admission plan](docs/ARCHITECTURE.md#12-view-matched-curry-reference-library-proposed)
describes the validation still needed before multi-angle scoring. Library
selections do not change the active `curry_v3` benchmark or report scores.

The Compose project is named `onemotion`. When upgrading an existing deployment,
stop its previous Compose project at the chosen cutover time before starting the
new project on the same host port. Keep the mounted data directories. Renaming a
local checkout also requires updating the saved workspace path and any external
bind mounts; it is separate from changing source/configuration names.
