# Curry reference footage candidates

Research checked on **2026-10-08**. These links are candidates in the
reference-viewing library, not validated biomechanical standards. The
machine-readable [research catalog](research/curry-reference-candidates.json)
records source families, timing uncertainty, inspection points and limitations.
Original Chinese titles are retained there as source metadata.

## Browse in OneMotion

Open **Analyze → Explore Curry references**, or `/references`, to browse these
eight sources in the shared English interface. Camera-view and platform filters
can be combined. Reports link into the library with a return path to the same
analysis. A selected source is stored in the URL and survives reload.

Use **Load YouTube player** or **Load Bilibili player** to load external playback,
or open the linked source directly. Bookmarks open reviewed positions or chapter
starts; they are not validated shot intervals. Changing sources removes the old
embedded player. The existing complete local source remains available under
**Current benchmark: Curry v3 → View full Curry source video**.

The app's display metadata is curated in `apps/web/lib/curry-references.ts`,
with regression checks against the source IDs, URLs, timing modes and inspection
points here. External player availability, quality and account requirements
are controlled by the host. The new source videos have not been downloaded into
the repository or activated as scoring templates.

No new media was downloaded, no complete shot was annotated, and none of these
candidates is active in scoring. The released `curry_v3` source remains
[BV14u411J7qS](https://www.bilibili.com/video/BV14u411J7qS/), with unknown source
playback speed. More uploads do not automatically establish more independent
shots or a population benchmark.

## Shortlist

“Spot checked” means the stated playback positions were inspected visually in
the browser. It does not establish visibility, camera stability or continuity
through an entire shot. “Metadata only” means a title or description was read
without a visual playback inspection. Exact yaw, mirroring and source timing
remain unverified for every candidate.

| Source | Evidence and view | Useful next step | Limitation |
| --- | --- | --- | --- |
| [My Basketball Workout During The Off-Season](https://www.youtube.com/watch?v=6mnujT_fzlY), Stephen Curry and PLYRS UNTD, 2025-11-21 | Spot checked. Wide oblique views; Curry visible head to feet in several setups. Official chapters include **1:43 Shooting foundation** and **4:51 Lateral movement shooting**. | Highest-priority original-channel source for finding complete, individually annotated shots and drill examples. | Camera framing changes, several people, subtitles/editorial text, and movement drills. Chapter boundaries are not shot boundaries. |
| [That Time Stephen Curry Hit 105 THREES IN A ROW](https://www.youtube.com/watch?v=VDAExNXyP_Q), Golden State Warriors, 2024-02-17 | Spot checked at **0:55**: rear/rear-oblique, head and feet visible, portrait footage inside blurred side padding. | Rear reference viewing and a potential repeated-shot source after full review. | Rear torso can hide the shooting arm. Publication date is not recording date. Other uploads of the same run may duplicate the shots. |
| [Steph Curry Shows The World Why He’s The Greatest Shooter Ever!](https://www.youtube.com/watch?v=S0S48xGfNAU), Josh Englert | Spot checked at **0:33**, **1:01** and **2:49**: front-oblique setup, rear follow-through close-up, and side-oblique close framing. | Prefer this linked original upload over its slowed or enhanced Bilibili derivatives. Find windows with a complete body and stable view. | Full-body framing at 0:33 does not persist in the close-ups. Multiple people and a foreground obstruction appear. Exact publication date not recorded. |
| [Stephen Curry Full NBA Workout](https://www.bilibili.com/video/BV1ww411f7ap/), Rowfit体能训练, 2021-06-11 | Spot checked around **0:05** and **0:18**: elevated front-oblique view. Description claims a continuous 20-minute Houston pregame workout. | Review the long sequence for front-oblique shots with visible feet; trace the original camera source. | Curry's lower body becomes cropped near 0:18 while another player is more central. Only 360p playback was inspected. The whole-video continuity claim is unverified. |
| [Stephen Curry shooting routine](https://www.youtube.com/watch?v=x4pXabPgCpo), LetsGoWarriors, 2017-04-26 | Metadata only: practice coverage before the second playoff round. | Additional publisher source to review for stable side shots. | Angle, full-body visibility and actual source speed remain unknown. This is not evidence of pure side-view coverage. |
| [Curry China workout — courtside upload](https://www.bilibili.com/video/BV1BaYDzuEFG/), 云球密, 2025-08-21 | Metadata only: title claims an uncut courtside view and 1080p60. | Additional long-form review candidate. | “Courtside” does not determine view direction; 60fps does not establish original speed or non-interpolated sampling. |
| [Front-view slow-motion shooting detail](https://www.bilibili.com/video/BV1iu41167Jd/), 上善若水星星1, 2022-05-17 | Spot checked around **0:20**: front upper-body close-up. Slow motion is explicit in the title. | Qualitative hand-placement and upper-body observation. | Knees and feet are outside the image. Slow-motion scale is unknown. Exclude from timing and lower-body comparisons. |
| [Close rear / rear-oblique training](https://www.bilibili.com/video/BV1GY411V7Tq/), 篮球新手村, 2022-02-15 | Spot checked at **0:12** and **0:19**: predominantly rear view, despite the title's rear-oblique label. | Supplementary rear-view observation. | Framing changes; a coach obstructs the shooting scene around 0:19. This does not establish a clean side-view shot. |

## Source tracing and exclusions

[BV1PM4m117DH](https://www.bilibili.com/video/BV1PM4m117DH/) explicitly links
the Josh Englert source above and declares slowed playback plus frame-rate
enhancement. The enhancement method and time scale are unknown. It should not
supply tempo, speed or additional independent measurement frames.

[BV14e411Z7HM](https://www.bilibili.com/video/BV14e411Z7HM/) also links
`S0S48xGfNAU`. Treat these uploads as one source family until individual shots
are traced and deduplicated. Their titles' resolution claims are not evidence
of native source sampling.

[BV1Re4y1K7Ey](https://www.bilibili.com/video/BV1Re4y1K7Ey/) is explicitly a
slow-motion **free throw**. It belongs outside the jump-shot benchmark even
when its camera direction seems useful.

## Coverage still missing

This research has not validated an uninterrupted, full-body **pure shooting-arm
side** or **opposite-side** jump shot from a new source. Front upper-body and
rear footage can already support reference viewing, but they do not close that
gap. No candidate has a verified complete dip-to-follow-through interval or an
independently attested real-time clock.

The next review should prioritize Curry's own workout, the Warriors run and the
two long Bilibili uploads. Annotate each accepted shot separately, preserving
its source family, actual boundaries, camera view, athlete identity and usable
joints. The [architecture admission plan](ARCHITECTURE.md#12-view-matched-curry-reference-library-proposed)
describes the work needed before any new view can influence a score.
