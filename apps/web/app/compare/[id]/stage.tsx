"use client";

import { useCallback, useEffect, useRef } from "react";
import type { AffineTransform } from "@/lib/compare-api";
import { comparisonVideoUrl } from "@/lib/compare-api";
import type { PoseFrame, ShotSequence } from "@/lib/api";

export type ViewMode = "split" | "overlay" | "difference";

const CONF_MIN = 0.5;
const COLOR_A = "#3b82f6";
const COLOR_B = "#f97316";
const EDGES: [string, string][] = [
  ["nose", "left_shoulder"], ["nose", "right_shoulder"],
  ["left_shoulder", "left_elbow"], ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"], ["right_elbow", "right_wrist"],
  ["left_shoulder", "left_hip"], ["right_shoulder", "right_hip"],
  ["left_hip", "left_knee"], ["left_knee", "left_ankle"],
  ["right_hip", "right_knee"], ["right_knee", "right_ankle"],
  ["left_shoulder", "right_shoulder"], ["left_hip", "right_hip"],
];

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function frameAt(frames: PoseFrame[], t_ms: number): PoseFrame | null {
  if (!frames.length) return null;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (frames[mid].t_ms <= t_ms) low = mid;
    else high = mid - 1;
  }
  return frames[low];
}

// Origin-centered convention shared with the backend fit and report drawing:
// x' = scale·R·x + t (in clip A's pixel coordinates).
function applySpatial(
  x: number,
  y: number,
  spatial: AffineTransform,
): [number, number] {
  const rad = (spatial.rotation_deg * Math.PI) / 180;
  return [
    spatial.scale * (Math.cos(rad) * x - Math.sin(rad) * y) + spatial.tx,
    spatial.scale * (Math.sin(rad) * x + Math.cos(rad) * y) + spatial.ty,
  ];
}

function drawSkeleton(
  context: CanvasRenderingContext2D,
  frame: PoseFrame,
  color: string,
  width: number,
  height: number,
  spatial: AffineTransform | null,
) {
  const points = new Map(frame.keypoints.map((kp) => [kp.name, kp]));
  const px = (kp: { x: number; y: number }) =>
    spatial
      ? applySpatial(kp.x * width, kp.y * height, spatial)
      : ([kp.x * width, kp.y * height] as const);
  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = Math.max(2, width / 240);
  context.lineCap = "round";
  for (const [from, to] of EDGES) {
    const a = points.get(from);
    const b = points.get(to);
    if (!a || !b || a.confidence < CONF_MIN || b.confidence < CONF_MIN) continue;
    const [ax, ay] = px(a);
    const [bx, by] = px(b);
    context.beginPath();
    context.moveTo(ax, ay);
    context.lineTo(bx, by);
    context.stroke();
  }
  for (const kp of frame.keypoints) {
    if (kp.confidence < CONF_MIN) continue;
    const [x, y] = px(kp);
    context.beginPath();
    context.arc(x, y, Math.max(3, width / 220), 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

export default function Stage({
  mode,
  comparisonId,
  opacity,
  spatial,
  poseA,
  poseB,
  offsetMsA,
  offsetMsB,
  playing,
  speed,
  seekRequest,
  onTick,
}: {
  mode: ViewMode;
  comparisonId: string;
  opacity: number;
  spatial: AffineTransform;
  poseA: ShotSequence;
  poseB: ShotSequence;
  offsetMsA: number;
  offsetMsB: number;
  playing: boolean;
  speed: number;
  seekRequest: { ms: number; nonce: number } | null;
  onTick: (msA: number, msB: number) => void;
}) {
  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const canvasA = useRef<HTMLCanvasElement>(null);
  const canvasB = useRef<HTMLCanvasElement>(null);
  const canvasMain = useRef<HTMLCanvasElement>(null);
  const offA = useRef<HTMLCanvasElement | null>(null);
  const offB = useRef<HTMLCanvasElement | null>(null);
  const onTickRef = useRef(onTick);
  useEffect(() => {
    onTickRef.current = onTick;
  }, [onTick]);
  const width = poseA.width;
  const height = poseA.height;

  const draw = useCallback(() => {
    const va = videoA.current;
    const vb = videoB.current;
    if (!va || !vb) return;
    const msA = va.currentTime * 1000;
    const msB = vb.currentTime * 1000;
    const frameA = frameAt(poseA.frames, msA);
    const frameB = frameAt(poseB.frames, msB);

    if (mode === "split") {
      const ctxA = canvasA.current?.getContext("2d");
      const ctxB = canvasB.current?.getContext("2d");
      if (!ctxA || !ctxB) return;
      ctxA.clearRect(0, 0, width, height);
      ctxB.clearRect(0, 0, width, height);
      ctxA.drawImage(va, 0, 0, width, height);
      ctxB.drawImage(vb, 0, 0, width, height);
      if (frameA) drawSkeleton(ctxA, frameA, COLOR_A, width, height, null);
      if (frameB) drawSkeleton(ctxB, frameB, COLOR_B, width, height, null);
      return;
    }

    const ctx = canvasMain.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(va, 0, 0, width, height);
    if (mode === "overlay") {
      ctx.save();
      ctx.globalAlpha = opacity;
      const [ox, oy] = applySpatial(0, 0, spatial);
      const rad = (spatial.rotation_deg * Math.PI) / 180;
      ctx.translate(ox, oy);
      ctx.rotate(rad);
      ctx.scale(spatial.scale, spatial.scale);
      ctx.drawImage(vb, 0, 0, width, height);
      ctx.restore();
      if (frameA) drawSkeleton(ctx, frameA, COLOR_A, width, height, null);
      if (frameB) drawSkeleton(ctx, frameB, COLOR_B, width, height, spatial);
      return;
    }
    // difference: pixel diff highlight, red where the aligned frames diverge.
    if (!offA.current) {
      offA.current = document.createElement("canvas");
      offB.current = document.createElement("canvas");
      offA.current.width = offB.current.width = width;
      offA.current.height = offB.current.height = height;
    }
    const oa = offA.current!.getContext("2d")!;
    const ob = offB.current!.getContext("2d")!;
    oa.clearRect(0, 0, width, height);
    ob.clearRect(0, 0, width, height);
    oa.drawImage(va, 0, 0, width, height);
    // Draw B through the spatial transform so the diff reflects action
    // difference, not the known camera offset.
    ob.save();
    const [ox, oy] = applySpatial(0, 0, spatial);
    const rad = (spatial.rotation_deg * Math.PI) / 180;
    ob.translate(ox, oy);
    ob.rotate(rad);
    ob.scale(spatial.scale, spatial.scale);
    ob.drawImage(vb, 0, 0, width, height);
    ob.restore();
    const dataA = oa.getImageData(0, 0, width, height);
    const dataB = ob.getImageData(0, 0, width, height);
    const out = oa.createImageData(width, height);
    const threshold = 36;
    for (let i = 0; i < dataA.data.length; i += 4) {
      const dr = Math.abs(dataA.data[i] - dataB.data[i]);
      const dg = Math.abs(dataA.data[i + 1] - dataB.data[i + 1]);
      const db = Math.abs(dataA.data[i + 2] - dataB.data[i + 2]);
      const gray = (dataA.data[i] + dataA.data[i + 1] + dataA.data[i + 2]) / 3;
      if (Math.max(dr, dg, db) > threshold) {
        out.data[i] = 239;
        out.data[i + 1] = 68;
        out.data[i + 2] = 68;
      } else {
        out.data[i] = out.data[i + 1] = out.data[i + 2] = gray;
      }
      out.data[i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    if (frameA) drawSkeleton(ctx, frameA, COLOR_A, width, height, null);
    if (frameB) drawSkeleton(ctx, frameB, COLOR_B, width, height, spatial);
  }, [mode, opacity, spatial, poseA, poseB, width, height]);

  // Playback clock: rVFC on A keeps the canvases in sync with real frames.
  useEffect(() => {
    const va = videoA.current as FrameVideo | null;
    if (!va) return;
    let handle: number | null = null;
    let raf = 0;
    const tick = () => {
      draw();
      const msA = va.currentTime * 1000;
      const aligned = msA - offsetMsA;
      const expectedB = (aligned + offsetMsB) / 1000;
      const vb = videoB.current;
      if (vb && Math.abs(vb.currentTime - expectedB) > 0.5 / Math.max(poseB.fps, 1)) {
        vb.currentTime = Math.max(0, expectedB);
      }
      onTickRef.current(msA, vb ? vb.currentTime * 1000 : expectedB * 1000);
      if (va.requestVideoFrameCallback) {
        handle = va.requestVideoFrameCallback(tick);
      } else {
        raf = requestAnimationFrame(tick);
      }
    };
    if (va.requestVideoFrameCallback) {
      handle = va.requestVideoFrameCallback(tick);
    } else {
      raf = requestAnimationFrame(tick);
    }
    return () => {
      if (handle !== null && va.cancelVideoFrameCallback) va.cancelVideoFrameCallback(handle);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [draw, offsetMsA, offsetMsB, poseB.fps]);

  // External seek (timeline click / keyboard frame stepping): react only to
  // a new nonce — otherwise slider-driven draw() identity changes would
  // keep yanking playback back to the last seek point.
  const lastNonce = useRef(0);
  useEffect(() => {
    if (!seekRequest || seekRequest.nonce === lastNonce.current) return;
    lastNonce.current = seekRequest.nonce;
    const va = videoA.current;
    const vb = videoB.current;
    if (!va || !vb) return;
    va.pause();
    vb.pause();
    va.currentTime = Math.max(0, seekRequest.ms + offsetMsA) / 1000;
    vb.currentTime = Math.max(0, seekRequest.ms + offsetMsB) / 1000;
    draw();
     
  }, [seekRequest, offsetMsA, offsetMsB, draw]);

  useEffect(() => {
    const va = videoA.current;
    const vb = videoB.current;
    if (!va || !vb) return;
    va.playbackRate = speed;
    vb.playbackRate = speed;
    if (playing) {
      void va.play().catch(() => undefined);
      void vb.play().catch(() => undefined);
    } else {
      va.pause();
      vb.pause();
    }
  }, [playing, speed]);

  // Both video elements stay mounted in every mode; only the canvases and
  // layout switch — remounting would lose currentTime and play state.
  const urlA = comparisonVideoUrl(comparisonId, "a");
  const urlB = comparisonVideoUrl(comparisonId, "b");
  const aspect = { aspectRatio: `${width} / ${height}` } as const;

  return (
    <div>
      <div className="grid gap-4" style={{ gridTemplateColumns: mode === "split" ? "1fr 1fr" : "1fr" }}>
        <div className="relative overflow-hidden rounded-xl bg-zinc-950" style={aspect}>
          {mode === "split" ? (
            <canvas ref={canvasA} width={width} height={height} className="absolute inset-0 h-full w-full object-contain" />
          ) : (
            <canvas ref={canvasMain} width={width} height={height} className="absolute inset-0 h-full w-full object-contain" />
          )}
          <span className="absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">A · 基准</span>
          {mode !== "split" ? (
            <span className="absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">B · 对比</span>
          ) : null}
        </div>
        {mode === "split" ? (
          <div className="relative overflow-hidden rounded-xl bg-zinc-950" style={aspect}>
            <canvas ref={canvasB} width={width} height={height} className="absolute inset-0 h-full w-full object-contain" />
            <span className="absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">B · 对比</span>
          </div>
        ) : null}
      </div>
      {/* Always-mounted playback elements; canvases above read their frames. */}
      <video ref={videoA} src={urlA} muted playsInline preload="auto" className="hidden" />
      <video ref={videoB} src={urlB} muted playsInline preload="auto" className="hidden" />
    </div>
  );
}
