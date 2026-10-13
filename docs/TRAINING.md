# OneMotion training loop

Local evolution, 2026-10-05. Training records describe manually entered shooting
outcomes. Video analysis remains a separate, evidence-gated flow.

## From guidance to a saved session

The training library contains 12 original OneMotion drills in four categories:
foundation, footwork, range, and game situations. Each drill supplies a court
diagram, steps, cues, planned sets and attempts, rest guidance, and capture notes.
Repetitions count **attempts, including misses**; they are never a target number
of makes. Estimated minutes describe the suggested workload, not a measured
performance or a guaranteed completion time.

Open `/training?drill=close-form` for a single drill. The three catalog plans are:

| Plan | Drill order |
| --- | --- |
| `smooth-foundation` | Close form → guide hand → one-motion rhythm |
| `comfortable-range` | Free throw → five spots → distance ladder |
| `ready-to-shoot` | Catch and shoot → one dribble → relocation |

A plan starts at `/training?plan=<id>`. Its stages use the same per-drill runner
and save separate drill records. These curated sequences do not establish a
player's skill level or automatically adapt to their make/miss history.

During a session, the player taps **Made** or **Missed** for each actual attempt.
**Undo last shot** corrects the latest entry. A completed set advances the workload;
rest guidance gives the player a pause before the next set. **Finish and save** keeps
an unfinished session as `partial`; **Save session** submits a completed session.
Finishing the planned workload does not itself prove a saved server record.

Elapsed duration is wall-clock time between the recorded start and finish. It
includes rest and time spent with the page closed; it is not active exercise
time. Accuracy is makes divided by recorded attempts. With no attempts, accuracy
is unavailable and shown as `—`; an empty history never implies a 0% performance.

## Recovery and persistence

One active draft is kept in the browser under `onemotion.training.draft.v1`.
Reloading the same OneMotion origin can restore its attempts and, for a plan,
the original stage. Browser storage is
the working draft; server history contains only successfully saved records.
Clearing browser storage removes unsaved recovery data. Different browser
profiles or origins do not share a draft.

The first save freezes its UUID, outcomes, and start/finish timestamps. A failed
request retains that snapshot for retry rather than generating another session.
The matching draft is removed only after a successful server response; a newer
snapshot from another tab is preserved, even if it uses the same UUID. If the response
was lost after commit, resending the same snapshot returns the existing record.
A working draft older than seven days requires export or an explicit replacement.
A frozen request whose own start/finish interval is valid remains retryable later.

| API | Behavior |
| --- | --- |
| `POST /api/v1/training/sessions` | Accept a UUID, known drill ID, timezone-aware clocks, planned workload, per-set boolean outcomes, and completion status. Server computes all totals. |
| Same UUID, same input | Return the original record with HTTP 200; first creation returns HTTP 201. |
| Same UUID, changed input | Return HTTP 409; an already saved record is immutable. |
| `GET /api/v1/training/sessions?limit=100` | Return recent sessions, a summary across all saved records, and `has_more`. |

Training records use atomic writes and the shared fixed lock stripes under
`data/training/sessions/`. This directory is gitignored and is outside the
analysis media TTL. It contains outcomes and metadata, not uploaded video.
History belongs to the current OneMotion installation; this iteration does not
introduce accounts or separate users' training ledgers.

Input bounds are a UUID v4, 1–20 planned sets with 1–100 attempts each, and an
elapsed interval of 0–7 days. A completed record must fill every planned set;
only the final set of a partial record may be unfinished. Unrecognized fields,
including proposed analysis links, are rejected rather than stored as V1 data.

`/progress` presents saved history and its genuine empty state. Read or save
failures must be shown as errors, rather than substituted with invented stats.
The history response is bounded to 100 recent records while its aggregate covers
the full local ledger. No accuracy trend establishes an improvement in shooting
mechanics, especially when drill, distance, or camera conditions change.

## Connecting practice to video evidence

Drill recommendations on an analysis report use its reliable measured feedback.
A metric excluded by capture quality, missing joints, or playback-speed evidence
must not reappear as a confident training recommendation. A generic drill library
remains available when an analysis cannot support a specific correction.

Record one complete shot or import a selected shot from a HomeCourt export to
inspect mechanics. The recorded browser clip can be reviewed locally before
submission and replaced by a new recording. History comparison still requires
the same action, shooting direction, and camera position. Neither a manually
recorded make nor a higher make percentage attests a clip's playback speed.
The active Curry reference retains its independent timing gate.

HomeCourt import currently handles exported video and source provenance. It does
not read a HomeCourt account, journal, make/miss statistics, or training program.
The manual training ledger does not infer ball outcomes from video and does not
run pose inference when saving a session.

## HomeCourt inspiration and next validation

HomeCourt's official site presents guided feedback and interactive workouts,
alongside history and daily training programs. These support a product loop of
instructions, practice, review, and a recoverable record. OneMotion's manual
runner is our implementation of that loop; it does not inherit HomeCourt's
automatic tracking or accuracy claims. [HomeCourt](https://www.homecourt.ai/),
[HomeCourt membership features](https://www.homecourt.ai/pricing).

HomeCourt's official help article describes combining activities into a routine;
this informs the catalog's short multi-drill plans. Its FAQ also documents
editing individual make/miss outcomes, supporting a visible correction step in
our manual log. [Custom workout guide](https://help.homecourt.ai/hc/en-us/articles/9344699106835-How-do-I-create-my-own-custom-workout),
[Make/miss editing FAQ](https://www.homecourt.ai/faq/general).

The next work needs its own evidence:

| Evolution | Validation needed before claiming it works |
| --- | --- |
| Actual HomeCourt-export compatibility | Test a user export with real codec, rotation, timestamps, and selection boundaries. The existing Curry-source smoke verifies plumbing only. |
| Reliable automatic shot discovery and outcomes | Label multi-shot footage and validate shot boundaries plus ball/rim detections and occlusion behavior. Current pose phases and optional ball overlay do not establish a make/miss detector. |
| Training context and analysis history | Link saved drill stages to optional shot reports and preserve a discoverable compact-report index after replay media expires. Define grouping before describing a whole plan as one measured session. |
| Playback declarations for ordinary uploads | Extend source provenance beyond HomeCourt. A legacy ordinary upload has no speed declaration and currently enables player wrist velocity; unknown or slowed files need an explicit gate without upgrading old evidence. |
| Better solo capture | Add a preparation countdown and validate mobile interruptions, after the existing local-review and camera-cleanup checks. |

The catalog, court diagrams, and drill wording are original repo assets. No
HomeCourt media or branded workout assets are copied into this implementation.

## Verification

Backend tests cover derived totals, strict input validation, atomic persistence,
UUID retries/conflicts, empty history, and storage failure behavior. Browser
regressions cover recovery after reload, undo, save failure and retry, actual
empty states, mobile navigation, and recorded-video preview cleanup. Exact
completed checks for this iteration are recorded in `IMPROVEMENTS.md`.
