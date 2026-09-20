"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiUrl,
  ApiError,
  responseError,
  getReplay,
  type BallTrack,
  type BiomechanicsFrame,
  type DerivedValue,
  type PhaseName,
  type PhaseSegment,
  type PoseFrame,
  type ReplayPayload,
  type ReplayWindow,
  type ShotSequence,
} from "@/lib/api";

const EDGES: [string, string][] = [
  ["nose", "left_eye"], ["nose", "right_eye"],
  ["left_eye", "left_ear"], ["right_eye", "right_ear"],
  ["left_shoulder", "right_shoulder"], ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"], ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"], ["left_shoulder", "left_hip"],
  ["right_shoulder", "right_hip"], ["left_hip", "right_hip"],
  ["left_hip", "left_knee"], ["left_knee", "left_ankle"],
  ["right_hip", "right_knee"], ["right_knee", "right_ankle"],
];

const PHASES: PhaseName[] = ["dip", "load", "lift", "release", "follow_through"];
const CONF_MIN = 0.5;
const EMPTY_DERIVED: DerivedValue = {
  value: null,
  confidence: 0,
  reliable: false,
  interpolated: false,
  unavailable_reason: null,
};
type Side = "player" | "template";
type Mode = "independent" | "realtime_locked";
type Anchor = "dip" | "release";

type Trajectory = {
  fromMs: number;
  toMs: number;
  wrist: string;
  degraded: boolean;
};

type VideoFrameMetadataLite = { mediaTime: number };
type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: VideoFrameMetadataLite) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

// Bumped on every retry so a late-resolving media probe from a previous
// attempt cannot re-attach an error to a reloaded video.
let mediaProbeGeneration = 0;

function itemAt<T extends { t_ms: number }>(items: T[], timeMs: number): T | null {
  if (!items.length) return null;
  let low = 0;
  let high = items.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (items[middle].t_ms <= timeMs) low = middle;
    else high = middle - 1;
  }
  return items[low];
}

function pointMap(frame: PoseFrame) {
  return new Map(frame.keypoints.map((point) => [point.name, point]));
}

function drawLabel(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
) {
  context.save();
  context.font = `600 ${Math.max(14, context.canvas.width / 44)}px system-ui`;
  const width = context.measureText(text).width + 12;
  const height = Math.max(23, context.canvas.width / 26);
  context.fillStyle = "rgba(9, 9, 11, .78)";
  context.beginPath();
  // roundRect needs Chrome 99+/Safari 16+; a missing fallback would kill all
  // overlay drawing on older engines, not just this label.
  if (typeof context.roundRect === "function") {
    context.roundRect(x - 6, y - height + 4, width, height, 6);
  } else {
    context.rect(x - 6, y - height + 4, width, height);
  }
  context.fill();
  context.fillStyle = color;
  context.shadowBlur = 0;
  context.fillText(text, x, y);
  context.restore();
}

function drawJointArc(
  context: CanvasRenderingContext2D,
  frame: PoseFrame,
  names: [string, string, string],
  value: DerivedValue,
  color: string,
) {
  if (!value.reliable || value.value === null) return;
  const points = pointMap(frame);
  const [a, b, c] = names.map((name) => points.get(name));
  if (!a || !b || !c || Math.min(a.confidence, b.confidence, c.confidence) < CONF_MIN) return;
  const center = { x: b.x * context.canvas.width, y: b.y * context.canvas.height };
  const start = Math.atan2((a.y - b.y) * context.canvas.height, (a.x - b.x) * context.canvas.width);
  const finish = Math.atan2((c.y - b.y) * context.canvas.height, (c.x - b.x) * context.canvas.width);
  let delta = finish - start;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  context.save();
  context.strokeStyle = color;
  context.lineWidth = Math.max(2, context.canvas.width / 260);
  context.shadowBlur = 0;
  context.beginPath();
  context.arc(
    center.x,
    center.y,
    Math.max(18, context.canvas.width / 24),
    start,
    start + delta,
    delta < 0,
  );
  context.stroke();
  drawLabel(context, `${value.value.toFixed(0)}°`, center.x + 8, center.y - 8, color);
  context.restore();
}

function drawBallTrack(
  context: CanvasRenderingContext2D,
  track: BallTrack,
  upToMs: number,
) {
  const { width, height } = context.canvas;
  const visible = track.frames.filter(
    (detection) => detection.t_ms <= upToMs && detection.x !== null && detection.y !== null,
  );
  context.save();
  context.shadowBlur = 0;
  context.strokeStyle = "#fb923c";
  context.fillStyle = "#fb923c";
  context.lineWidth = Math.max(2, width / 320);
  context.globalAlpha = 0.9;
  context.beginPath();
  let pen = false;
  for (const detection of track.frames) {
    if (detection.t_ms > upToMs) break;
    // Missed detections break the path instead of being interpolated.
    if (detection.x === null || detection.y === null) {
      pen = false;
      continue;
    }
    const x = detection.x * width;
    const y = detection.y * height;
    if (pen) context.lineTo(x, y);
    else context.moveTo(x, y);
    pen = true;
  }
  context.stroke();
  context.globalAlpha = 1;
  for (const detection of visible) {
    context.beginPath();
    context.arc(detection.x! * width, detection.y! * height, Math.max(2.5, width / 260), 0, Math.PI * 2);
    context.fill();
  }
  const current = visible[visible.length - 1];
  if (current) {
    const radius = Math.max(6, (current.radius ?? 0.03) * width);
    context.beginPath();
    context.arc(current.x! * width, current.y! * height, radius, 0, Math.PI * 2);
    context.lineWidth = Math.max(2.5, width / 220);
    context.stroke();
  }
  context.restore();
}

function drawTrajectory(
  context: CanvasRenderingContext2D,
  frames: PoseFrame[],
  trajectory: Trajectory,
  upToMs: number,
  color: string,
) {
  const endMs = Math.min(trajectory.toMs, upToMs);
  if (endMs <= trajectory.fromMs) return;
  const { width, height } = context.canvas;
  context.save();
  context.strokeStyle = color;
  context.lineWidth = Math.max(2, width / 320);
  context.shadowBlur = 0;
  context.globalAlpha = 0.85;
  if (trajectory.degraded) context.setLineDash([8, 6]);
  context.beginPath();
  let pen = false;
  for (const frame of frames) {
    if (frame.t_ms < trajectory.fromMs) continue;
    if (frame.t_ms > endMs) break;
    const point = frame.keypoints.find((keypoint) => keypoint.name === trajectory.wrist);
    // Low-confidence frames break the path instead of being interpolated.
    if (!point || point.confidence < CONF_MIN) {
      pen = false;
      continue;
    }
    const x = point.x * width;
    const y = point.y * height;
    if (pen) context.lineTo(x, y);
    else context.moveTo(x, y);
    pen = true;
  }
  context.stroke();
  context.restore();
}

function drawOverlay(
  canvas: HTMLCanvasElement,
  frame: PoseFrame,
  biomechanics: BiomechanicsFrame | null,
  color: string,
  showSkeleton: boolean,
  showData: boolean,
  trajectory: { spec: Trajectory; frames: PoseFrame[] } | null,
  ballTrack: BallTrack | null,
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  const points = pointMap(frame);
  context.lineCap = "round";
  context.shadowColor = "rgba(0, 0, 0, .75)";
  context.shadowBlur = Math.max(2, width / 300);

  if (trajectory) {
    drawTrajectory(context, trajectory.frames, trajectory.spec, frame.t_ms, color);
  }

  if (ballTrack) {
    drawBallTrack(context, ballTrack, frame.t_ms);
  }

  if (showSkeleton) {
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = Math.max(3, width / 180);
    for (const [from, to] of EDGES) {
      const a = points.get(from);
      const b = points.get(to);
      if (!a || !b || a.confidence < CONF_MIN || b.confidence < CONF_MIN) continue;
      context.beginPath();
      context.moveTo(a.x * width, a.y * height);
      context.lineTo(b.x * width, b.y * height);
      context.stroke();
    }
    for (const point of frame.keypoints) {
      if (point.confidence < CONF_MIN) continue;
      context.beginPath();
      context.arc(point.x * width, point.y * height, Math.max(4, width / 150), 0, Math.PI * 2);
      context.fill();
    }
  }

  if (!showData || !biomechanics) return;
  const side = biomechanics.shooting_side;
  drawJointArc(
    context,
    frame,
    [`${side}_shoulder`, `${side}_elbow`, `${side}_wrist`],
    biomechanics.elbow_flexion_deg,
    "#fef08a",
  );
  drawJointArc(
    context,
    frame,
    ["left_hip", "left_knee", "left_ankle"],
    biomechanics.left_knee_flexion_deg,
    "#bfdbfe",
  );
  drawJointArc(
    context,
    frame,
    ["right_hip", "right_knee", "right_ankle"],
    biomechanics.right_knee_flexion_deg,
    "#bfdbfe",
  );
  const forearm = biomechanics.forearm_elevation_deg;
  if (forearm.reliable && forearm.value !== null) {
    drawLabel(
      context,
      biomechanics.is_release_frame
        ? `Release proxy ${forearm.value.toFixed(0)}°`
        : `Forearm ${forearm.value.toFixed(0)}°`,
      Math.max(12, width / 50),
      Math.max(30, height / 18),
      biomechanics.is_release_frame ? "#fca5a5" : "#fde68a",
    );
  }
  drawLabel(
    context,
    `${biomechanics.phase?.replace("_", " ") ?? "outside shot"} · frame ${biomechanics.frame_idx}`,
    Math.max(12, width / 50),
    height - Math.max(12, height / 32),
    "#ffffff",
  );
}

function metricText(value: DerivedValue, suffix = "°") {
  if (!value.reliable || value.value === null) return "—";
  return `${value.value.toFixed(suffix === "×/s" ? 2 : 0)}${suffix}`;
}

export default function SkeletonReplay({ analysisId }: { analysisId: string }) {
  const [replay, setReplay] = useState<ReplayPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [expired, setExpired] = useState(false);
  const [mediaErrors, setMediaErrors] = useState<Partial<Record<Side, {message: string; expired: boolean}>>>({});
  const [mode, setMode] = useState<Mode>("realtime_locked");
  const [anchor, setAnchor] = useState<Anchor>("release");
  const [times, setTimes] = useState<Record<Side, number>>({ player: 0, template: 0 });
  const [playing, setPlaying] = useState<Record<Side, boolean>>({ player: false, template: false });
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [showData, setShowData] = useState(true);
  const [showTrajectory, setShowTrajectory] = useState(true);
  const [showBall, setShowBall] = useState(true);
  const playerVideo = useRef<HTMLVideoElement>(null);
  const templateVideo = useRef<HTMLVideoElement>(null);
  const playerCanvas = useRef<HTMLCanvasElement>(null);
  const templateCanvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    getReplay(analysisId, controller.signal)
      .then((payload) => {
        if (!cancelled) {
          const initialAnchor = payload.sync.default_anchor;
          const match = payload.sync.anchors.find((item) => item.name === initialAnchor);
          const playerAnchor = match?.player_ms ?? payload.player_window.release_anchor_ms;
          const templateAnchor = match?.template_ms ?? payload.template_window.release_anchor_ms;
          const initialOffset = Math.max(
            payload.player_window.start_ms - playerAnchor,
            payload.template_window.start_ms - templateAnchor,
          );
          setTimes({
            player: playerAnchor + initialOffset,
            template: templateAnchor + initialOffset,
          });
          setReplay(payload);
          setAnchor(initialAnchor);
          setMode(payload.sync.default_mode);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setExpired(error instanceof ApiError && error.status === 410);
          setError(error instanceof ApiError ? error.message : "Could not load replay. Check your connection and try again.");
        }
      });
    return () => { cancelled = true; controller.abort(); };
  }, [analysisId, attempt]);

  function retryReplay() {
    mediaProbeGeneration += 1;
    setError(null);
    setExpired(false);
    setMediaErrors({});
    setReplay(null);
    setAttempt((value) => value + 1);
  }

  async function mediaFailure(side: Side, url: string) {
    const generation = mediaProbeGeneration;
    playerVideo.current?.pause();
    templateVideo.current?.pause();
    let expired = false;
    let message = "This video could not be played. Retry or upload a supported clip.";
    try {
      const response = await fetch(url, { headers: { Range: "bytes=0-0" }, cache: "no-store" });
      if (!response.ok) { expired = response.status === 410; message = (await responseError(response)).message; }
      else await response.body?.cancel();
    } catch {
      message = "Could not load the video. Check your connection and retry.";
    }
    if (generation !== mediaProbeGeneration) return;
    setMediaErrors((current) => ({ ...current, [side]: {message, expired} }));
  }

  const sideData = useCallback((side: Side) => {
    if (!replay) return null;
    return side === "player"
      ? {
          sequence: replay.player_sequence,
          biomechanics: replay.player_biomechanics,
          window: replay.player_window,
          video: playerVideo.current,
          canvas: playerCanvas.current,
          color: "#10b981",
        }
      : {
          sequence: replay.template_sequence,
          biomechanics: replay.template_biomechanics,
          window: replay.template_window,
          video: templateVideo.current,
          canvas: templateCanvas.current,
          color: "#f59e0b",
        };
  }, [replay]);

  const trajectories = useMemo((): Record<Side, Trajectory | null> => {
    const empty = { player: null, template: null };
    if (!replay) return empty;
    const build = (phases: PhaseSegment[], biomechanics: BiomechanicsFrame[]): Trajectory | null => {
      const dip = phases.find((phase) => phase.phase === "dip");
      const release = phases.find((phase) => phase.phase === "release");
      if (!dip || !release) return null;
      const fromMs = dip.start_ms;
      const toMs = release.anchor_ms ?? release.start_ms;
      if (toMs <= fromMs) return null;
      const side = biomechanics.find((frame) => frame.t_ms >= fromMs)?.shooting_side ?? "right";
      return {
        fromMs,
        toMs,
        wrist: `${side}_wrist`,
        degraded: dip.degraded || release.degraded,
      };
    };
    return {
      player: build(replay.player_phases, replay.player_biomechanics),
      template: build(replay.template_phases, replay.template_biomechanics),
    };
  }, [replay]);

  const renderSide = useCallback((side: Side, timeMs: number) => {
    const data = sideData(side);
    if (!data?.canvas) return;
    const frame = itemAt(data.sequence.frames, timeMs);
    const biomechanics = itemAt(data.biomechanics, timeMs);
    const spec = showTrajectory ? trajectories[side] : null;
    const track = data.sequence.ball_track;
    const ballTrack = showBall && track?.available ? track : null;
    if (frame) {
      drawOverlay(
        data.canvas,
        frame,
        biomechanics,
        data.color,
        showSkeleton,
        showData,
        spec ? { spec, frames: data.sequence.frames } : null,
        ballTrack,
      );
    }
  }, [showBall, showData, showSkeleton, showTrajectory, sideData, trajectories]);

  useEffect(() => {
    for (const side of ["player", "template"] as Side[]) {
      const video = sideData(side)?.video;
      if (video) renderSide(side, video.currentTime * 1000);
    }
  }, [renderSide, sideData, replay]);

  const anchorTimes = useMemo(() => {
    if (!replay) return { player: 0, template: 0 };
    const match = replay.sync.anchors.find((item) => item.name === anchor);
    return {
      player: match?.player_ms ?? replay.player_window.release_anchor_ms,
      template: match?.template_ms ?? replay.template_window.release_anchor_ms,
    };
  }, [anchor, replay]);

  const syncRange = useMemo(() => {
    if (!replay) return { start: 0, end: 1 };
    return {
      start: Math.max(
        replay.player_window.start_ms - anchorTimes.player,
        replay.template_window.start_ms - anchorTimes.template,
      ),
      end: Math.min(
        replay.player_window.end_ms - anchorTimes.player,
        replay.template_window.end_ms - anchorTimes.template,
      ),
    };
  }, [anchorTimes, replay]);

  const pauseAll = useCallback(() => {
    playerVideo.current?.pause();
    templateVideo.current?.pause();
    setPlaying({ player: false, template: false });
  }, []);

  const seekSide = useCallback((side: Side, requestedMs: number) => {
    const data = sideData(side);
    if (!data) return;
    const timeMs = Math.min(Math.max(requestedMs, data.window.start_ms), data.window.end_ms);
    if (data.video) data.video.currentTime = timeMs / 1000;
    setTimes((current) => ({ ...current, [side]: timeMs }));
    renderSide(side, timeMs);
  }, [renderSide, sideData]);

  const seekSync = useCallback((offsetMs: number) => {
    const bounded = Math.min(Math.max(offsetMs, syncRange.start), syncRange.end);
    seekSide("player", anchorTimes.player + bounded);
    seekSide("template", anchorTimes.template + bounded);
  }, [anchorTimes, seekSide, syncRange]);

  const alignToAnchor = useCallback((nextAnchor: Anchor) => {
    if (!replay) return;
    const match = replay.sync.anchors.find((item) => item.name === nextAnchor);
    pauseAll();
    seekSide("player", match?.player_ms ?? replay.player_window.release_anchor_ms);
    seekSide("template", match?.template_ms ?? replay.template_window.release_anchor_ms);
  }, [pauseAll, replay, seekSide]);

  const onMediaTime = useCallback((side: Side, timeMs: number) => {
    const data = sideData(side);
    const bounded = data ? Math.min(Math.max(timeMs, data.window.start_ms), data.window.end_ms) : timeMs;
    setTimes((current) => ({ ...current, [side]: bounded }));
    renderSide(side, bounded);
    if (mode === "independent" && data && timeMs >= data.window.end_ms) {
      data.video?.pause();
      if (timeMs > data.window.end_ms + 1) seekSide(side, data.window.end_ms);
      return;
    }
    if (mode !== "realtime_locked" || side !== "player" || !replay) return;
    const offset = timeMs - anchorTimes.player;
    if (offset >= syncRange.end - 1) {
      pauseAll();
      if (offset > syncRange.end + 1) seekSync(syncRange.end);
      return;
    }
    const expected = anchorTimes.template + offset;
    const follower = templateVideo.current;
    const frameTolerance = 1000 / Math.max(replay.template_window.fps, 1);
    if (follower && Math.abs(follower.currentTime * 1000 - expected) > frameTolerance) {
      follower.currentTime = expected / 1000;
    }
  }, [anchorTimes, mode, pauseAll, renderSide, replay, seekSide, sideData, seekSync, syncRange.end]);

  useEffect(() => {
    if (!replay) return;
    const cleanups: (() => void)[] = [];
    for (const side of ["player", "template"] as Side[]) {
      const data = sideData(side);
      const video = data?.video as FrameVideo | null;
      if (!video) continue;
      const update = () => onMediaTime(side, video.currentTime * 1000);
      const onPlay = () => setPlaying((current) => ({ ...current, [side]: true }));
      const onPause = () => setPlaying((current) => ({ ...current, [side]: false }));
      video.addEventListener("timeupdate", update);
      video.addEventListener("seeked", update);
      video.addEventListener("play", onPlay);
      video.addEventListener("pause", onPause);
      let frameHandle: number | null = null;
      if (video.requestVideoFrameCallback) {
        const tick = (_: number, metadata: VideoFrameMetadataLite) => {
          // A paused seek can deliver one stale presented-frame callback. In
          // that state currentTime is the authoritative requested frame.
          onMediaTime(
            side,
            (video.paused ? video.currentTime : metadata.mediaTime) * 1000,
          );
          frameHandle = video.requestVideoFrameCallback?.(tick) ?? null;
        };
        frameHandle = video.requestVideoFrameCallback(tick);
      }
      cleanups.push(() => {
        video.removeEventListener("timeupdate", update);
        video.removeEventListener("seeked", update);
        video.removeEventListener("play", onPlay);
        video.removeEventListener("pause", onPause);
        if (frameHandle !== null) video.cancelVideoFrameCallback?.(frameHandle);
      });
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [onMediaTime, replay, sideData]);

  const playBoth = useCallback(async () => {
    if (Object.keys(mediaErrors).length) return;
    if (playing.player || playing.template) {
      pauseAll();
      return;
    }
    const offset = times.player - anchorTimes.player;
    if (offset >= syncRange.end - 1000 / Math.max(replay?.player_window.fps ?? 30, 1)) {
      seekSync(syncRange.start);
    }
    try {
      await Promise.all([playerVideo.current?.play(), templateVideo.current?.play()]);
      setError(null); // a blocked-play warning must not linger once play works
    } catch {
      pauseAll();
      setError("Playback was blocked. Press play again after the videos load.");
    }
  }, [anchorTimes.player, mediaErrors, pauseAll, playing, replay, seekSync, syncRange, times.player]);

  const toggleIndependent = useCallback(async (side: Side) => {
    const data = sideData(side);
    if (!data?.video || mediaErrors[side]) return;
    if (data.video.paused) {
      if (times[side] >= data.window.end_ms - 1000 / data.window.fps) {
        seekSide(side, data.window.start_ms);
      }
      try {
        await data.video.play();
        setError(null);
      } catch {
        setError("Playback was blocked. Press play again after the video loads.");
      }
    } else {
      data.video.pause();
    }
  }, [mediaErrors, seekSide, sideData, times]);

  const stepFrame = useCallback((side: Side, direction: -1 | 1) => {
    const data = sideData(side);
    if (!data) return;
    data.video?.pause();
    const frames = data.sequence.frames;
    const current = itemAt(frames, times[side]);
    const sequenceIndex = Math.max(0, frames.findIndex((frame) => frame.frame_idx === current?.frame_idx));
    const target = frames[Math.min(Math.max(sequenceIndex + direction, 0), frames.length - 1)];
    if (target) seekSide(side, target.t_ms);
  }, [seekSide, sideData, times]);

  if (!replay) {
    return <div role="status" className="space-y-3 text-sm text-zinc-500">
      <p>{error ?? "Loading video replay…"}</p>
      {error && !expired ? <button className="rounded-full border px-4 py-2" onClick={retryReplay}>Retry replay</button> : null}
      {error ? <a href="/upload" className="ml-3 underline">Upload a new shot</a> : null}
    </div>;
  }

  const currentBiomechanics = {
    player: itemAt(replay.player_biomechanics, times.player),
    template: itemAt(replay.template_biomechanics, times.template),
  };

  const ballUnavailableReason = [
    replay.player_sequence.ball_track,
    replay.template_sequence.ball_track,
  ].find((track) => track && !track.available)?.reason;

  const panel = (
    side: Side,
    title: string,
    sequence: ShotSequence,
    window: ReplayWindow,
    videoUrl: string | null,
    videoRef: React.RefObject<HTMLVideoElement | null>,
    canvasRef: React.RefObject<HTMLCanvasElement | null>,
    colorClass: string,
  ) => {
    const biomechanics = currentBiomechanics[side];
    return (
      <figure className="min-w-0 rounded-2xl border border-black/[.08] p-3 dark:border-white/[.145]">
        <figcaption className="mb-2 flex items-center justify-between text-sm">
          <span className={`font-semibold ${colorClass}`}>{title}</span>
          <span className="font-mono text-xs text-zinc-500">
            frame {biomechanics?.frame_idx ?? "—"} · {(times[side] / 1000).toFixed(3)}s
          </span>
        </figcaption>
        <div
          className="relative overflow-hidden rounded-xl bg-zinc-950"
          style={{ aspectRatio: `${sequence.width} / ${sequence.height}` }}
        >
          {videoUrl ? (
            <video
              ref={videoRef}
              onError={() => { const url = apiUrl(videoUrl); if (url) void mediaFailure(side, url); }}
              src={apiUrl(videoUrl) ?? undefined}
              muted
              playsInline
              preload="auto"
              onLoadedMetadata={() => seekSide(side, times[side])}
              onClick={() => mode === "independent" ? void toggleIndependent(side) : void playBoth()}
              className="absolute inset-0 h-full w-full cursor-pointer object-contain"
            />
          ) : null}
          <canvas
            ref={canvasRef}
            width={sequence.width}
            height={sequence.height}
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          />
        </div>

        {mediaErrors[side] ? <p role="alert" className="mt-3 text-sm text-amber-600">{mediaErrors[side]?.message} {!mediaErrors[side]?.expired ? <button className="underline" onClick={retryReplay}>Reload replay</button> : null} · <a href="/upload" className="underline">Upload a new shot</a></p> : null}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled={mode === "realtime_locked" || !!mediaErrors[side]}
            onClick={() => stepFrame(side, -1)}
            className="h-9 min-w-10 rounded-full border px-3 disabled:opacity-35 active:scale-[.97]"
            aria-label={`${title} previous frame`}
          >−1</button>
          <button
            type="button"
            disabled={mode === "realtime_locked" || !!mediaErrors[side]}
            onClick={() => void toggleIndependent(side)}
            className="h-9 min-w-20 rounded-full border px-3 disabled:opacity-35 active:scale-[.97]"
          >{playing[side] ? "Pause" : "Play"}</button>
          <button
            type="button"
            disabled={mode === "realtime_locked" || !!mediaErrors[side]}
            onClick={() => stepFrame(side, 1)}
            className="h-9 min-w-10 rounded-full border px-3 disabled:opacity-35 active:scale-[.97]"
            aria-label={`${title} next frame`}
          >+1</button>
          <input
            type="range"
            min={window.start_ms}
            max={window.end_ms}
            step={1}
            value={Math.min(Math.max(times[side], window.start_ms), window.end_ms)}
            disabled={mode === "realtime_locked" || !!mediaErrors[side]}
            onPointerDown={() => sideData(side)?.video?.pause()}
            onChange={(event) => seekSide(side, Number(event.target.value))}
            className="min-w-0 flex-1 accent-foreground disabled:opacity-35"
            aria-label={`${title} replay position`}
          />
        </div>

        <div className="mt-2 flex flex-wrap gap-1">
          {PHASES.map((phase) => {
            const match = (side === "player" ? replay.player_phases : replay.template_phases)
              .find((item) => item.phase === phase);
            return (
              <button
                type="button"
                key={phase}
                disabled={mode === "realtime_locked" || !match}
                onClick={() => match && seekSide(side, match.anchor_ms ?? match.start_ms)}
                className="rounded-full bg-zinc-100 px-2 py-1 text-[11px] capitalize text-zinc-600 disabled:opacity-35 dark:bg-zinc-800 dark:text-zinc-300"
              >{phase.replace("_", " ")}</button>
            );
          })}
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 rounded-xl bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
          <div className="flex justify-between gap-2"><dt>Elbow</dt><dd className="font-mono">{metricText(biomechanics?.elbow_flexion_deg ?? EMPTY_DERIVED)}</dd></div>
          <div className="flex justify-between gap-2"><dt>Forearm</dt><dd className="font-mono">{metricText(biomechanics?.forearm_elevation_deg ?? EMPTY_DERIVED)}</dd></div>
          <div className="flex justify-between gap-2"><dt>Left knee</dt><dd className="font-mono">{metricText(biomechanics?.left_knee_flexion_deg ?? EMPTY_DERIVED)}</dd></div>
          <div className="flex justify-between gap-2"><dt>Right knee</dt><dd className="font-mono">{metricText(biomechanics?.right_knee_flexion_deg ?? EMPTY_DERIVED)}</dd></div>
          <div className="flex justify-between gap-2"><dt>Trunk lean</dt><dd className="font-mono">{metricText(biomechanics?.trunk_lean_deg ?? EMPTY_DERIVED)}</dd></div>
          <div className="flex justify-between gap-2"><dt>Wrist speed</dt><dd className="font-mono">{metricText(biomechanics?.wrist_vertical_velocity_height_s ?? EMPTY_DERIVED, "×/s")}</dd></div>
        </dl>
      </figure>
    );
  };

  const syncOffset = Math.min(
    Math.max(times.player - anchorTimes.player, syncRange.start),
    syncRange.end,
  );

  return (
    <section>
      <div className="mb-3 flex flex-col gap-3 rounded-2xl bg-zinc-100 p-4 dark:bg-zinc-900 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Video + biomechanics replay</h2>
          <p className="text-sm text-zinc-500">Real video frames remain the timing source. Generated views are never used for scoring.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={mode === "realtime_locked"}
              onChange={(event) => {
                const nextMode = event.target.checked ? "realtime_locked" : "independent";
                pauseAll();
                setMode(nextMode);
                if (nextMode === "realtime_locked") alignToAnchor(anchor);
              }}
              disabled={!!replay.sync.unavailable_reason}
              className="size-4 accent-foreground"
            />
            Sync clips
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={showSkeleton} onChange={(event) => setShowSkeleton(event.target.checked)} className="size-4 accent-foreground" />
            Skeleton
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={showData} onChange={(event) => setShowData(event.target.checked)} className="size-4 accent-foreground" />
            Angles
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={showTrajectory} onChange={(event) => setShowTrajectory(event.target.checked)} className="size-4 accent-foreground" />
            Trajectory
          </label>
          {replay.player_sequence.ball_track?.available || replay.template_sequence.ball_track?.available ? (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={showBall} onChange={(event) => setShowBall(event.target.checked)} className="size-4 accent-foreground" />
              Ball
            </label>
          ) : null}
        </div>
      </div>

      {error ? <p className="mb-3 text-sm text-amber-600">{error}</p> : null}
      {replay.sync.unavailable_reason ? (
        <p className="mb-3 text-sm text-amber-600">Sync confidence warning: {replay.sync.unavailable_reason}</p>
      ) : null}
      {ballUnavailableReason ? (
        <p className="mb-3 text-xs text-zinc-500">Ball trajectory unavailable: {ballUnavailableReason}</p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {panel("player", "You", replay.player_sequence, replay.player_window, replay.player_video_url, playerVideo, playerCanvas, "text-emerald-500")}
        {panel("template", "Curry v3", replay.template_sequence, replay.template_window, replay.template_video_url, templateVideo, templateCanvas, "text-amber-500")}
      </div>

      {mode === "realtime_locked" ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-black/[.08] p-3 dark:border-white/[.145]">
          <button
            type="button"
            onClick={() => void playBoth()}
            disabled={Object.keys(mediaErrors).length > 0}
            className="h-10 min-w-24 rounded-full bg-foreground px-4 text-background active:scale-[.97]"
          >{playing.player || playing.template ? "Pause both" : "Play both"}</button>
          <label className="flex items-center gap-2 text-sm">
            Align
            <select
              value={anchor}
              onChange={(event) => {
                const nextAnchor = event.target.value as Anchor;
                setAnchor(nextAnchor);
                alignToAnchor(nextAnchor);
              }}
              className="h-9 rounded-lg border border-black/[.12] bg-background px-2 dark:border-white/[.2]"
            >
              <option value="release">Release</option>
              <option value="dip">Dip</option>
            </select>
          </label>
          <input
            type="range"
            min={syncRange.start}
            max={syncRange.end}
            step={1}
            value={syncOffset}
            onPointerDown={pauseAll}
            onChange={(event) => seekSync(Number(event.target.value))}
            className="min-w-[180px] flex-1 accent-foreground"
            aria-label="Synchronized replay position"
          />
          <span className="w-20 text-right font-mono text-xs text-zinc-500">
            {syncOffset >= 0 ? "+" : ""}{(syncOffset / 1000).toFixed(3)}s
          </span>
        </div>
      ) : (
        <p className="mt-3 text-sm text-zinc-500">Independent mode: hold either clip on an exact frame while playing or scrubbing the other.</p>
      )}
    </section>
  );
}
