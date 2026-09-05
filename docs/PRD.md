# OnMotion — Product Requirements Document

Version: 0.2 · Date: 2026-09-05 · Status: Implemented MVP

## 1. Overview

OnMotion is a shooting-training application that teaches the **one-motion shot** — the fluid, single-rhythm shooting motion popularized by Stephen Curry. Instead of generic tips, OnMotion compares the player's actual body mechanics against a benchmark built from Curry's own shooting footage and reports measurable differences with actionable corrections.

### 1.1 Problem

- One-motion shooting is a *timing and sequencing* skill: the ball is released before the jump peaks, powered by the legs in one continuous motion. It is very hard to self-diagnose from feel alone.
- Players lack access to motion-capture coaching. A shooting coach costs $50–150/hr and still can't quantify joint angles or release timing.
- Existing generic "shooting form" advice isn't anchored to a specific, repeatable reference motion.

### 1.2 Solution

1. Build a **Curry benchmark**: use the first three real-time seconds of the selected Curry source, extract a timestamp-preserving skeleton pose sequence, and derive a normalized biomechanical profile of his one-motion shot.
2. Capture the **player's shot**: upload a short clip, or record live from the device camera; extract the same pose sequence.
3. **Compare** the two motion sequences: segment the shot into phases, align them temporally, compute metric deltas (release angle, tempo, joint angles), and generate prioritized, plain-language improvement advice.

### 1.3 Design inspiration

HomeCourt (Nike) is the UX bar: near-zero setup, instant feedback after every rep, game-like progression, and session history that shows improvement over time. OnMotion adopts these principles for form training rather than shot counting.

## 2. Goals and non-goals

### Goals (MVP)

- G1: A reproducible pipeline that turns the approved Curry v3 clip into a versioned single-reference profile (keypoints + metrics).
- G2: Players can upload a short shooting video (3–10 s, single shot) and receive a metric-by-metric comparison against the benchmark.
- G3: Players can record a shot live from the browser camera and get the same analysis.
- G4: The app returns at least these metrics: release angle, release height (normalized), shot tempo (dip→release time), elbow angle at release, knee flexion at load, hip–shoulder alignment at release, follow-through hold.
- G5: Feedback is prioritized (top 3 issues) with one concrete drill cue each.

### Non-goals (for MVP)

- Live rep-by-rep overlay coaching (real-time AR). Post-shot analysis only in MVP.
- Ball tracking / make-miss detection (v2).
- Multiplayer, social features, coach marketplace.
- Native mobile apps (web-first; wrap later via Capacitor/React Native WebView if warranted).
- Any player benchmark other than Curry.
- Synthetic 90° view generation until it is proven to preserve joint and timing measurements.

## 3. Personas

- **Amateur player (primary)** — 14–35, plays recreationally, wants Curry's quick, effortless release. Uses a phone; may not have anyone to film them (hence live camera mode).
- **Trainer/parent (secondary)** — records clips of a player, wants objective progress evidence across sessions.

## 4. User stories

- US-1: As a player, I can record my shot with my laptop/phone camera propped up, so I don't need a filming partner.
- US-2: As a player, I can upload an existing clip of my shot and get the same analysis.
- US-3: As a player, after each analyzed shot I see my release angle vs. Curry's and whether I should raise or lower it.
- US-4: As a player, I see my shot broken into phases (load → lift → release → follow-through) with the worst phase highlighted.
- US-5: As a player, I get at most 3 prioritized corrections with a short drill cue, not a wall of numbers.
- US-6: As a player, I can see my metric history across sessions to confirm I'm converging on the benchmark.
- US-7: As a developer, I can rebuild the Curry benchmark from source clips with one command and version the output.

## 5. Functional requirements

### FR-1 Benchmark pipeline

- FR-1.1: Ingest exactly 0:00–0:03 of the approved Curry v3 source clip (side view; real-time playback).
- FR-1.2: Extract one COCO-17 pose record for every decoded frame with the configured pose backend (YOLO-pose by default).
- FR-1.3: Segment each clip into shot phases: `dip → load → lift → release → follow_through`.
- FR-1.4: Compute per-shot metrics (Section 6), normalize for camera distance/height, and retain source timing/provenance in the profile.
- FR-1.5: Persist the active benchmark as `data/benchmarks/curry_v3.json`; retired IDs are not selectable.

### FR-2 Player capture

- FR-2.1: Live camera recording in the browser (getUserMedia), 12 s max per rep, with explicit stable 90° side-view guidance.
- FR-2.2: File upload (mp4/mov/webm, ≤ 50 MB, single shot per clip).
- FR-2.3: Report a conservative post-capture quality assessment with side-view likelihood, visibility, status, and corrective guidance.

### FR-3 Analysis & feedback

- FR-3.1: Same pose extraction and phase segmentation as the benchmark pipeline.
- FR-3.2: Temporal alignment by shared dip or release anchor without changing either source video's playback speed.
- FR-3.3: Metric deltas vs. benchmark median, expressed in player terms (degrees, seconds, % of body height).
- FR-3.4: Rule-based feedback engine: maps the largest deltas to prioritized, specific cues (e.g., "start your leg drive 0.1 s earlier — the ball should already be rising when your hips extend").
- FR-3.5: Keep timing and low-confidence measurements out of scoring when their evidence is unreliable; explain the reason to the user.

### FR-4 Reporting UI

- FR-4.1: Analysis report page: overall similarity score (0–100), metric table (you vs. Curry), phase timeline visualization, top-3 corrections.
- FR-4.2: Draw each skeleton on its original video and attach per-frame elbow, knee, forearm, trunk, wrist-speed, and release-proxy data.
- FR-4.3: Let users switch between synchronized playback and independent play, scrub, phase-jump, and single-pose-frame controls.

## 6. Metric definitions (v1)

All angles in degrees; times in seconds; heights normalized to player standing height from keypoints.

| Metric | Definition |
| --- | --- |
| Release angle | MVP: forearm (elbow→wrist) elevation above horizontal at release — the wrist joint is stationary during the release snap, so a velocity proxy fails. Ball-velocity angle (Curry ≈ 48–55°) needs ball tracking (v2). |
| Release height | Wrist height at release ÷ standing height. |
| Shot tempo | Time from lowest ball/wrist point (end of dip) to release. Curry reference ≈ 0.3–0.4 s. |
| Elbow angle at release | Upper arm–forearm angle at the release frame. |
| Knee flexion at load | Minimum knee angle during `load` phase. |
| Hip–shoulder alignment | Horizontal offset between hip mid-point and shoulder mid-point at release (lean detection). |
| Set point height | Wrist height at the `lift` phase start, relative to shoulder height (one-motion shots have no high set point). |
| Follow-through hold | Time the wrist stays above elbow height after release. |
| Similarity score | Weighted aggregate of normalized metric deltas, 0–100. |

## 7. UX principles (from HomeCourt)

1. **Minimal taps**: open → record → shoot → see feedback. No forms in the critical path.
2. **Instant feedback**: analysis returns in < 10 s for a 10 s clip.
3. **One number to care about**: the similarity score leads the report; details are one scroll down.
4. **Show, don't tell**: skeleton overlay and phase timeline before any text table.
5. **Progression**: history and trends visible; celebrate convergence on benchmark ranges.

## 8. Non-functional requirements

- Analysis latency: < 10 s for a 10 s clip on a laptop-class server CPU; < 3 s with GPU.
- Privacy: raw video and replay keypoints expire after 24 hours by default and are explicitly deletable; the compact report can remain.
- Pose backend remains pluggable; YOLO-pose is the supported runtime backend and any replacement must pass an accuracy benchmark.
- Browser support: latest Chrome/Edge/Safari; camera capture requires HTTPS (or localhost dev).
- Deployment: a Docker Compose stack exposes one HTTP origin and refuses readiness when pinned model/reference artifacts are absent or corrupted.

## 9. Success metrics

- Benchmark pipeline reproduces a stable Curry profile across clip sets (per-metric std < 10% between builds).
- ≥ 80% of test shots produce a full 5-phase segmentation without manual fixes.
- Feedback precision: in a 10-shot internal test set with seeded form flaws, the top-1 suggested correction matches the seeded flaw ≥ 70% of the time.

## 10. Out of scope / future

- 3D pose and multi-camera fusion; generative view normalization; ball trajectory tracking; make/miss correlation; drills library with video demos; native apps; coach dashboards; session history; other player benchmarks.

## 11. Open questions

- Camera-angle robustness: MVP assumes roughly side-on view; how much off-axis error is acceptable before we require multi-view?
- Which higher-accuracy pose model can beat YOLO on an annotated basketball-shot set while remaining deployable and license-compatible?
- Whether similarity score should weight tempo more heavily than static angles (coaching intuition says yes — validate with trainers).
