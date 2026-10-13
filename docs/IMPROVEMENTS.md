# OneMotion improvement ledger

Implementation started 2026-09-05 on the existing working tree. Existing edits
were preserved. The rows distinguish implemented code from external validation
or rollout work; they do not claim a completed production rollout.

| Task | State | Implementation / verification |
| --- | --- | --- |
| 01 Naming | Repository updated | OneMotion / onemotion / ONEMOTION throughout source, docs, environment examples, package metadata, locks and Docker definitions. CI checks spelling. Local workspace directory and existing container names require a separate operational migration. |
| 02 Repeated comparison | Implemented, tested | Preserve raw measurement evidence; legacy fallback keeps prior reliability. First/repeated scores, metrics and feedback agree. |
| 03 Metric dependencies | Implemented, tested | Load/lift/release and scale/neighbor evidence propagate; benchmark aggregation uses the same gate. |
| 04 Input/resource limits | Implemented, tested | Browser size/metadata checks; server preflight, frame/time/pixel budgets, finite inference slots and 429 responses. Native calls use cooperative timeout checks. |
| 05 Storage integrity | Implemented, tested | Unique atomic temporaries, advisory locks, rollback, aged orphan cleanup, concurrent legacy migration. |
| 06 Capture lifecycle | Implemented, browser-tested | Late permission stops tracks; pending/recording states and cleanup prevent duplicate captures; submitted file is locked. |
| 07 Clean deployment | Images built | Optional public directory handled; all data directories probed; preparation/UID instructions supplied. Running service rollout is separate. |
| 08 Benchmark provenance | Implemented, exercised | Explicit source hashes/interval/speed; registry preserves metadata; separate release pinning. Real reference rebuilt and released in isolated storage. Active local release is retained. |
| 09 Expiry/recovery | Implemented, tested | Video/replay expiry agrees; inline legacy poses removed on expiry; 404/410/service/network recovery UI. |
| 10 Replay controls | Implemented, browser-tested | Pixel-space arcs, independent stop boundary, immediate paused-overlay redraw. |
| 11 Regression/CI | Local checks passed | Backend regression suite, Playwright capture/upload/report/replay checks, route types, lint and both container builds. GitHub execution awaits pushing changes. |
| 12 Evaluation | Runner implemented; labels pending | Frozen-case hashes, annotation-source separation, phase/metric/feedback checks and latency. Two local baseline cases pass; independent human labels remain necessary for accuracy claims. |

Reproduction commands and limits live in the root README and EVALUATION.md.
The original implementation retained the existing reference videos, model weights and player data.
The local follow-up below regenerated only the derived reference/profile release.

Local verification: 34 backend tests and 9 browser tests passed; lint, generated
route types/TypeScript, branding and whitespace checks passed. Both final Docker
images built successfully. The isolated real-reference API round trip returned
90 pose frames, preserved comparison metrics, served a 206 media range, and
completed deletion. Analysis took 2.43 seconds for that one 3-second clip on this
host; this is not a general latency guarantee. Two local frozen baseline cases
passed with zero human-labeled cases.


Local follow-up, 2026-10-02: repaired the artifact gate at the actual analysis
entry point as well as readiness. Changed release hashes are now rejected by
`dev.sh media` rather than silently re-pinned. Full source footage stays in
`data/raw_videos/curry/curry_v3_source.mp4`; the analysis page can play it only
when its source digest matches canonical provenance. The derived 0–3 s reference
is encoded as browser-compatible H.264, with the source timing still unknown.

Capture failures exclude every comparison metric, score and correction. Oblique
warnings exclude form comparisons while retaining valid timing evidence. This
policy also applies to persisted and expired compact reports; raw measurement
evidence is preserved for repeated comparisons. Optional ball-model initialization
errors degrade the overlay without failing analysis.

Compare rendering uses CORS-enabled videos and B's native dimensions before
applying the B→A affine. Paused view switches redraw immediately; pending seeks
wait for metadata, and initial playback starts at the configured anchors. Saves
are serialized, retain unacknowledged edits, and restore displayed server values
on failure. Report export flushes pending saves and regenerates the report;
spatial/time/phase edits invalidate old report metadata and screenshot URLs.
Compare data is gitignored, and Linux deployment notes cover every storage folder.

Verification: 74 backend tests and 19 browser tests pass, with lint, route types /
TypeScript and the production web build passing. Synthetic browser videos use
real decoding, CORS and HTTP Range requests, including unequal resolutions and
save failure/order cases. The isolated real-inference round trip produced 90
frames in 2.517 s, preserved repeated comparison, served a 206 range and deleted
its temporary report. Stop works with OS unset, and a changed manifest was
rejected without replacing its pins. Container images were not rebuilt in this
follow-up. This checkout has no Git metadata; no remote Git operations occurred.

Evaluation rejects unannotated cases. Independent human labels and a larger
validated reference sample remain pending; these checks do not establish
biomechanical accuracy or independently attest the source playback rate.

Local refactor, 2026-10-04: `analysis/results.py` centralizes evidence recovery,
quality, comparison gates, scoring and feedback for fresh, repeated, migrated
and expired reports. Partial evidence and persisted raw rejections stay
conservative; repeated reads are idempotent. Routes retain inference, storage,
locking, artifact verification and rollback.

The compare workbench separates its controller, subscription hook, dialogs and
controls; the main component is now 184 lines, down from 588. Pending writes are
serialized by comparison ID across page mounts, including report generation.
Returning to the same comparison waits for an earlier page's write. Failed
drafts survive server rollback and later edits, with explicit retry and newer
field values taking precedence. Typed compare request models reject invalid
types, nonfinite transforms, duplicate identifiers and out-of-bounds timelines
with a string HTTP 422 detail rather than corrupting persisted data.

Report deviation is computed in batches with canonical joint-name indexing and
the same source-time floor as the canvas. Screenshot decoding uses the selected
pose's source-frame index. Each export opens its two videos once and writes
unique atomic PNGs; decoding, write or metadata failures preserve the previous
report. Summary-only export is valid when no pose pairs are eligible, whereas a
selected frame that cannot be decoded fails the export. A seven-run local
720-frame microbenchmark measured median deviation calculation of 4.425 ms
versus 18.521 ms before the refactor (about 4.2 times faster).

Verification: 149 backend tests and 25 browser tests pass; lint, route types /
TypeScript and the production web build pass. Real inference in isolated
storage returned 90 pose frames in 2.789 s with consistent repeated comparison,
HTTP 206 media serving and complete temporary-report deletion. The live local
stack serves the full original footage with HTTP Range, produces 90-frame
replay and five report screenshots, and preserves compact reports after media
expiry. The original footage hash and pinned release artifacts remain intact;
source timing remains unknown. No reference/model/manifest was rebuilt or
repinned, and no remote Git operation occurred. Container images were not
rebuilt in this refactor.

HomeCourt imports, 2026-10-05: `/homecourt` previews an exported training video,
selects one complete shot, records optional training time/camera labels, and
reuses Curry analysis or the history comparison wizard. Both upload endpoints
accept the original file plus a typed `source` declaration. The shared import
helper permits a 200 MiB / 10-minute original, extracts a full-frame H.264 clip
under a shared 60-second scan/encode budget, deletes temporary originals, and
keeps the existing selected-clip 50 MiB / 12-second inference limits. Original
and selected hashes remain with requested and actual source intervals.

Selection snaps to exact decoded PTS boundaries. Output starts at zero while
retaining variable frame intervals and the final frame's real display duration;
no frames are invented and no playback-speed transform is applied. Actual
windows over 12 seconds are rejected. Replay, keyboard stepping, phase boundaries
and exported phase-start offsets use frame timestamps. Optional full-frame
subject rectangles restrict YOLO's person choice without cropping the camera
background; missing eligible detections stay confidence-zero placeholders.

Unknown or slowed playback disables timing scores/feedback and wrist velocity
without changing stored pose confidence or raw measurement evidence. The
reference timing gate remains independent. Source metadata survives re-comparison,
migration and media expiry. The history wizard rejects invalid action offsets,
shows save failures without navigating, and prevents old requests from replacing
newly selected players/templates/clips. Expired source directories abandoned by
a process crash are cleaned under their clip lock, without following symlinks or
touching persistent history media. Nginx accepts 201 MiB only on upload routes;
configuration syntax and actual location matching were verified in the existing
local Nginx image without deployment or image pulls.

Verification: 266 backend tests and 37 browser tests pass; lint, generated route
types/TypeScript and the production web build pass. The new isolated real-inference
import smoke used the existing 27-second Curry source as a plumbing test: requested
0–3000 ms aligned to 23–3023 ms, yielding 90 pose frames in 3.595 s, consistent
re-comparison, matching hashes, HTTP 206 playback, two history clips and five
report screenshots. Temporary originals and the isolated analysis were removed.
The original footage and pinned artifacts remain intact; no remote Git operation
occurred. Actual HomeCourt-export compatibility still needs a user sample. This
version imports video; account integration, training statistics and automatic
shot discovery remain outside its scope. Container images were not rebuilt.

Training evolution, 2026-10-05: the player-facing entry now connects a searchable
library of 12 original drills, three short multi-drill plans, a per-drill shooting
runner, and saved training history. Each drill has a court diagram, instructions,
cues, sets, attempts and rest guidance. Recommendations from analysis use only
reliable measured feedback; the general library remains usable without an
eligible correction. Plans save individual drill stages rather than presenting
the whole routine as one measured session.

The runner records actual manual make/miss entries, supports undo and partial
completion, and persists one browser draft across reloads. A resumed plan keeps
its stage and next drill. Saves freeze the UUID, outcomes and timestamps; retries
after an uncertain response return the existing immutable record. Another tab's
changes disable stale controls, and a late success cannot delete a newer draft
sharing the UUID. Corrupt or expired working drafts can be exported before an
explicit replacement; valid frozen requests remain retryable after seven days.

The backend derives totals, validates UUID v4 and workload/clock bounds, and
stores atomic records under the local-only `data/training/sessions/` directory.
History shows saved sessions and an aggregate of the entire local ledger. Empty
accuracy is `—`, and read failures remain visible errors. Elapsed time includes
rest and closed-page time; manual outcomes do not establish biomechanical
improvement, real-time video playback or automated ball tracking. History belongs
to the current installation, without account-level separation.

Camera recording now previews the captured clip with playback controls before
analysis. Re-recording restores the existing camera stream and releases the old
preview URL; navigation releases preview URLs and camera tracks. Empty recordings
and failed re-records present a retry without an analyzable empty clip. Capture
copy preserves the independent playback-speed evidence gate.

Verification: 329 backend tests and all 55 browser tests pass, including 11 new
training cases, three recorder-preview cases and four drill-library cases. Lint
and generated route types/TypeScript and the production build pass. A subsequent
five-case library check also passes, adding the direct workout-start entry from
the library (56 distinct browser cases verified). Browser coverage exercises real decoded
synthetic clips, draft reload/undo, two tabs, frozen retries after a committed but
lost response, exact snapshot cleanup, plan-stage recovery, honest empty/error
history and a 375px viewport. The live local API remains ready, serves an existing
report and the full Curry original through HTTP Range, and reports empty training
accuracy as `null`; no synthetic rows were added to the actual training ledger.
Read-only index/ignore checks include only `data/.gitkeep` from data/models and
exclude training records, private media, model weights and the local manifest.
All Git work remains local; no remote Git operation occurred.

The guided practice/history loop draws on official HomeCourt product and help
documentation, with citations and validation limits in `TRAINING.md`. Actual
HomeCourt-export compatibility, automatic shot boundaries and reliable make/miss
detection need separate samples and labeled validation. Discoverable analysis
history and links between training context and shot reports remain next work.
Ordinary-file playback declarations also remain a priority: legacy uploads lack
source speed evidence and can currently expose player wrist velocity even when
the file is slowed. The reference's existing timing gate remains in force.
Container images were not rebuilt for this training iteration.

Shared app shell, 2026-10-06: the dashboard is the common entry to Training,
Progress, Analyze and Compare. `/analyze` groups camera recording, short clip
upload and HomeCourt imports. Capture pages share a secondary source selector;
training runners and analysis reports keep the correct parent navigation active.
Existing capture, report and comparison URLs remain available.

Interface copy, metadata, accessibility labels, validation messages, drill
instructions and generated profile defaults are English. User-provided names,
filenames, camera labels and existing custom phases retain their original text.
The self-hosted Geist Sans font is used throughout, including numeric readouts,
form controls and canvas chart labels. A shared semantic palette supplies page
backgrounds, cards, borders and muted text in both light and dark modes. Native
controls follow the same color scheme; video mattes retain a neutral black.

Verification: all 60 browser regressions pass, including four new shared-shell
cases covering navigation, English copy, 375px light/dark layouts, the loaded
font family, consistent backgrounds and preservation of user content. Lint,
generated route types/TypeScript, the production build, branding and local
artifact integrity checks pass. Live read-only checks return HTTP 200 for API
health/readiness and an existing report, empty training accuracy remains null,
and the complete Curry source serves HTTP 206. The dashboard and HomeCourt
entry were also inspected in the local browser. Backend analysis and storage
behavior are unchanged; inference was not rerun for this interface update.
All commits remain on the existing local branch, without remote Git operations.

Curry viewing library, 2026-10-08: `/references` exposes eight researched
YouTube/Bilibili sources through the Analyze entry and existing shot reports.
Camera view and platform filters compose in the URL; selections survive reload,
and a validated report ID retains a return link to the original analysis.
Unreviewed source details have their own category. Missing complete pure-side
footage produces an explicit empty state instead of a fabricated match.

External players load on demand without autoplay. Review bookmarks are source
positions or chapter starts, not validated single-shot boundaries. A new source
selection unloads the old embedded player, and a direct source link remains
available if host playback is blocked. Known reposts are labeled as source
videos, without claiming that every upload is the original camera source.
The full local Curry source viewer is shared with reports. The library defers
current scoring/timing eligibility to the report rather than inferring it from
playback. Candidate viewing never changes the active benchmark or scores.

Verification: all 67 browser regressions pass. The seven reference-specific
cases were rerun successfully after the final source-wording correction. They
cover research/display metadata consistency, external-player opt-in and cleanup,
composed filters and empty states, speed limitations, return navigation, safe
query fallback and local source decoding. The shared-shell tests now also cover
the library's default, front and side views, including 375px light/dark paint,
English copy, a single loaded font family and no page overflow. Lint, route
type generation/TypeScript, production build and branding pass.

Live browser review verified the mobile library layout, loading the actual
YouTube player at a review bookmark, and decoding the complete local Curry
source. The API readiness check passed for `curry_v3`. External streaming
availability is not guaranteed; browser regressions use controlled player
responses. New candidate media was not downloaded, and backend inference,
capture gates, stored results, local artifact pins and the scoring registry
were not modified. Backend inference/tests and container builds were not rerun
for this frontend feature. All Git work remains local.

Minimal delivery packages, 2026-10-13: `scripts/package_release.py` exports a
GitHub source snapshot with zero video files and a separate private snapshot
containing existing local data, videos, model and release pins. Both include
`VIDEO_SOURCES.json` with the current source, eight candidates and related
sources. File hashes, ZIP CRCs, inventories, private-path exclusions and common
video headers are verified. Source archives omit Git history, dependencies,
environment values, caches and build output. No online candidate footage is
downloaded by the exporter. The existing local video inventory consists of four
real media files and five generated synthetic fixtures.

Browser fixtures now come from original procedural color-field recipes, with
the same explicit VFR presentation times. Generated `.webm` files are ignored
and removed from the current Git tree. `npm test` creates them with FFmpeg;
web CI installs that prerequisite. Old fixture blobs remain in the existing
local history, so a zero-video GitHub submission must use the exported snapshot
in a fresh directory rather than push that history. Remote Git was not used.
The unused Geist Mono font was removed, and the retained Geist Sans font now
ships its official OFL notice separately from the project MIT license.

Verification: seven package-boundary tests and all 67 browser regressions pass;
lint, generated types/TypeScript, production build and artifact-pin verification
pass. A media-free snapshot was extracted and successfully regenerated its five
test videos from source. Backend inference and container builds were not rerun.

Cleanup removed 28 generated/cache targets, totaling 1,748,810,431 logical bytes
(not a physical free-space claim). Hashes of existing data and models were
unchanged. Installed dependencies were retained for ongoing development but
excluded from both delivery archives. Cleanup details and final checksums are
saved alongside the ignored exports under `dist/2026-10-13/`.
