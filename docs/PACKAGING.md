# Minimal local and GitHub packages

Build both with Python 3.13+ from the repository root:

```bash
python3 scripts/package_release.py --date 2026-10-13 --output dist/2026-10-13
```

Use `--kind github` or `--kind local` to build one package. Existing archives
are not overwritten. The exporter uses the current working source tree, reads
local Git metadata, and never accesses a remote repository. Commit reviewed
source changes before producing a final release snapshot.

## GitHub submission package

`OneMotion-github-<date>.zip` contains code, tests, lockfiles, configuration
templates, documentation, font license and video source URLs. It contains **no
video files**, reference benchmarks, model weights, personal records, actual
environment files, Git history, dependencies, build output or caches.

`VIDEO_SOURCES.json` lists the active Curry source, all eight library candidates
and the related sources. `PACKAGE_CONTENTS.json` records every included file's
size and SHA-256. The exporter checks every archived payload and rejects private
paths, videos and symlinks in the submission package. Generated archives remain
under the Git-ignored `dist/` folder. Do not upload the separate local package.

Extract the GitHub package into a fresh directory for submission. This avoids
including any old binary fixtures from the existing local commit history.
`git init`, staging and publishing the new directory are separate user actions;
the packaging command performs none of them.

The source-only UI can run with Node 20+/22:

```bash
cd apps/web
npm ci
npm run dev
```

The dashboard/reference library can be browsed without local Curry media. The
API's analysis readiness remains unavailable until independently obtained,
usable artifacts are installed and verified. See the root README for setup.
Dependencies are not bundled, so a fresh installation needs network access.

For browser tests, install FFmpeg with libvpx or set `FFMPEG_PATH`, then run:

```bash
npx playwright install chromium
npm test
```

`pretest` procedurally generates the five synthetic videos in the ignored
fixture directory; no downloaded footage or encoded-video payload is committed.
VFR recipes retain explicit frame presentation timestamps. CI installs FFmpeg.

## Private local package

`OneMotion-local-<date>.zip` adds the current `data/`, `models/`, the existing
artifact manifest and any generated test video files. This preserves all
existing local videos, compact analyses, training records and comparison assets.
It deliberately excludes caches, temporary downloads and lock files. The pinned
model, benchmark and canonical clip are checksum-verified before export.

Online reference candidates remain links unless usable, authorized copies
have already been placed in local storage. This package does not download them,
infer original timing, or grant redistribution rights. Keep it private: it may
contain personal data and third-party media. It also excludes installed
dependencies; use `./dev.sh deps` before `./dev.sh start` after extraction.

## Copyright scope

Public viewing and a source URL do not establish a license to rehost a video.
YouTube distinguishes enabled playback/embedding from download and redistribution
permissions in its [Terms of Service](https://www.youtube.com/t/terms).
GitHub publishes a [DMCA takedown policy](https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy).
The submission package therefore references hosted videos without copying them.
An uploader's attribution or a slow-motion edit does not establish the uploader
owns the underlying footage. All candidate reuse rights remain unverified.

The repository MIT license applies to project code, not third-party footage,
model weights or fonts. Geist retains its separate OFL notice in
`apps/web/app/fonts/OFL.txt`. Other installed dependencies retain their own
licenses; their files are not distributed in these source archives.
