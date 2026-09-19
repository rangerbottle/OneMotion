"""Shot phase segmentation: dip → load → lift → release → follow_through.

Signal: the shooting wrist's height trajectory plus the shooting arm's elbow
angle. Occlusion-aware: keypoints with raw confidence < CONF_MIN are treated
as missing, and the shot window is the contiguous valid run that contains the
wrist apex — so highlight-clip scene cuts and occluded stretches (e.g. a
defender blocking the dip) can't create phantom motion via interpolation
(see `app.analysis.series`).

- `load`    — last local wrist-height minimum before the sustained rise to
              the apex; if the dip is occluded, this is the window start and
              dip/load are marked `degraded`
- `release` — maximum elbow extension in a window around the wrist apex
              (the ball leaves the hand as the arm reaches full extension)
- `dip`     — last local height maximum before load → load window start
- `lift`    — load window end → release
- `follow_through` — release → wrist drops back below shoulder height (capped)

PhaseSegment frame numbers are indices into ShotSequence.frames. Pose backends
emit one frame record for every decoded video frame, including confidence-zero
placeholders when the subject is temporarily lost, so these indices can be
mapped back to the original video without drift.
"""

import numpy as np

from app.analysis.series import series
from app.schemas.analysis import PhaseSegment
from app.schemas.pose import ShotSequence

CONF_MIN = 0.5
LOAD_WINDOW_S = 0.1  # load phase extends ±this around the dip bottom
FOLLOW_THROUGH_CAP_S = 1.0
# Release search window around the wrist apex (seconds). The short post-apex
# window prevents a later arm swing or COCO left/right swap from winning.
RELEASE_PRE_APEX_S = 0.33
RELEASE_POST_APEX_S = 0.25
RELEASE_EXTENSION_RATIO = 0.97


def raw_conf(seq: ShotSequence, frame: int, name: str) -> float:
    return next(
        (k.confidence for k in seq.frames[frame].keypoints if k.name == name),
        0.0,
    )


def _wrist_series(seq: ShotSequence, side: str) -> np.ndarray:
    return series(seq, f"{side}_wrist")


def shooting_side(seq: ShotSequence) -> str:
    """The wrist with the larger vertical range of well-tracked motion."""
    best, best_range = "right", -1.0
    for side in ("left", "right"):
        ys = _wrist_series(seq, side)[:, 1]
        valid = (
            np.array(
                [raw_conf(seq, i, f"{side}_wrist") for i in range(len(seq.frames))]
            )
            >= CONF_MIN
        )
        if valid.sum() < 2:
            continue
        r = float(ys[valid].max() - ys[valid].min())
        if r > best_range:
            best, best_range = side, r
    return best


def _shot_window(valid: np.ndarray, apex: int) -> tuple[int, int]:
    """Contiguous valid run containing the apex, allowing 3-frame gaps."""
    n = len(valid)

    def grow(start: int, step: int) -> int:
        i, gap, last = start, 0, start
        while 0 <= i < n:
            if valid[i]:
                last, gap = i, 0
            else:
                gap += 1
                if gap > 3:
                    break
            i += step
        return last

    return grow(apex, -1), grow(apex, 1)


def segment(sequence: ShotSequence) -> list[PhaseSegment]:
    """Split a pose sequence into the five one-motion shot phases."""
    side = shooting_side(sequence)
    n = len(sequence.frames)
    if n < 10:
        raise ValueError(f"clip too short to segment: {n} pose frames")

    wrist = _wrist_series(sequence, side)
    shoulder = series(sequence, f"{side}_shoulder")
    elbow = series(sequence, f"{side}_elbow")
    h = -wrist[:, 1]  # height; larger = higher (image y grows downward)
    times = np.array([frame.t_ms for frame in sequence.frames], dtype=float)

    def time_window(center: int, before_s: float, after_s: float) -> tuple[int, int]:
        """Inclusive frame bounds using source timestamps, not nominal FPS."""
        lo = int(np.searchsorted(times, times[center] - before_s * 1000, side="left"))
        hi = (
            int(np.searchsorted(times, times[center] + after_s * 1000, side="right"))
            - 1
        )
        return max(0, lo), min(n - 1, hi)

    wrist_valid = (
        np.array([raw_conf(sequence, i, f"{side}_wrist") for i in range(n)]) >= CONF_MIN
    )
    if wrist_valid.sum() < 10:
        raise ValueError("shooting wrist tracked in too few frames — check framing")

    # Shot window: contiguous valid run containing the (valid) wrist apex.
    apex = int(np.argmax(np.where(wrist_valid, h, -np.inf)))
    win_lo, win_hi = _shot_window(wrist_valid, apex)

    # Release: the arm snaps to full extension as the ball leaves. Use the
    # first frame reaching 97% of max elbow extension around the apex —
    # max extension itself is already follow-through.
    from app.analysis.series import angle_abc

    search_lo, search_hi = time_window(apex, RELEASE_PRE_APEX_S, RELEASE_POST_APEX_S)
    lo, hi = max(win_lo, search_lo), min(win_hi, search_hi)
    elbow_angles = np.array(
        [angle_abc(shoulder[i], elbow[i], wrist[i]) for i in range(n)]
    )
    elbow_ok = (
        np.array(
            [
                min(
                    raw_conf(sequence, i, f"{side}_shoulder"),
                    raw_conf(sequence, i, f"{side}_elbow"),
                    raw_conf(sequence, i, f"{side}_wrist"),
                )
                for i in range(n)
            ]
        )
        >= CONF_MIN
    )
    candidates = np.where(elbow_ok, elbow_angles, -np.inf)
    window = candidates[lo : hi + 1]
    finite = np.isfinite(window)
    if not finite.any():
        raise ValueError("shooting arm is not visible around release — check framing")
    max_elbow = float(window[finite].max())
    threshold_hits = np.where(finite & (window >= RELEASE_EXTENSION_RATIO * max_elbow))[
        0
    ]
    release = lo + int(threshold_hits[0])

    # Load: last local minimum before the sustained rise toward the apex.
    # Walking back from the apex, height keeps hitting new lows until we pass
    # the dip bottom; further back it rises again → the bottom is the load.
    rise_confirm = 0.25 * (h[apex] - h[win_lo]) if apex > win_lo else 1.0
    load = win_lo
    running_min, argmin_i = h[apex], apex
    for i in range(apex, win_lo - 1, -1):
        if h[i] <= running_min:
            running_min, argmin_i = h[i], i
        elif h[i] > running_min + rise_confirm:
            argmin_i = int(np.argmin(h[argmin_i : apex + 1])) + argmin_i
            break
    load = argmin_i if argmin_i > win_lo else win_lo
    load = int(load)

    # Dip start: walk back from load while height is increasing.
    dip_start = win_lo
    for i in range(load - 1, win_lo - 1, -1):
        if h[i] < h[i + 1]:
            dip_start = i + 1
            break

    # Load window: ±LOAD_WINDOW_S around the dip bottom, by source timestamps.
    load_time_lo, load_time_hi = time_window(load, LOAD_WINDOW_S, LOAD_WINDOW_S)
    load_hi = min(load_time_hi, release)
    load_lo = min(max(load_time_lo, dip_start), load_hi)
    # A very quick shot can put the release search at or before the detected
    # dip bottom. The phase order is then meaningless (negative tempo), so the
    # load/lift phases are marked degraded and tempo evidence drops out
    # through the load gate instead of scoring an inverted interval.
    inverted = release <= load

    # Follow-through ends when the shooting wrist drops below its elbow. This
    # moving anatomical reference survives camera motion better than comparing
    # against the shoulder's release-frame pixel position.
    _, follow_cap = time_window(release, 0.0, FOLLOW_THROUGH_CAP_S)
    follow_end = min(follow_cap, win_hi)
    dropped = False
    for i in range(release, follow_end + 1):
        if not elbow_ok[i]:
            continue
        if wrist[i, 1] > elbow[i, 1]:
            follow_end = i
            dropped = True
            break
    # If no wrist-below-elbow event was observed, the hold duration is only a
    # lower bound whether the limit came from the one-second cap or tracking end.
    follow_censored = not dropped

    # Dip/load are degraded when the true dip was occluded (load == window start).
    dip_occluded = load == win_lo

    def degraded(a: int, b: int, extra: bool = False) -> bool:
        if extra:
            return True
        return any(not wrist_valid[i] for i in range(a, b + 1))

    bounds = [
        ("dip", dip_start, load_lo, dip_start, False),
        ("load", load_lo, load_hi, load, False),
        ("lift", load_hi, release, load_hi, False),
        ("release", release, release, release, False),
        ("follow_through", release, follow_end, follow_end, follow_censored),
    ]
    return [
        PhaseSegment(
            phase=p,
            start_frame=a,
            end_frame=b,
            start_ms=sequence.frames[a].t_ms,
            end_ms=sequence.frames[b].t_ms,
            anchor_frame=anchor,
            anchor_ms=sequence.frames[anchor].t_ms,
            degraded=degraded(a, b, extra=(dip_occluded and p in ("dip", "load")) or (inverted and p in ("load", "lift"))),
            censored=censored,
        )
        for p, a, b, anchor, censored in bounds
    ]


def phase_of(segments: list[PhaseSegment], phase: str) -> PhaseSegment:
    return next(s for s in segments if s.phase == phase)
