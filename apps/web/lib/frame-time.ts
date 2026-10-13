/** Decoded-frame timestamps are authoritative; average fps is only a fallback. */
export type FrameTime = { frame_idx: number; t_ms: number };

function positionAtTime(frames: readonly FrameTime[], ms: number): number {
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (frames[mid].t_ms <= ms) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function frameAtTime<T extends FrameTime>(frames: readonly T[], ms: number): T | null {
  return frames.length ? frames[positionAtTime(frames, ms)] : null;
}

export function frameTimeMs(frames: readonly FrameTime[], index: number, fps: number, endBoundaryMs?: number): number {
  if (!frames.length) return index * 1000 / Math.max(fps, 1);
  if (index > frames[frames.length - 1].frame_idx) return endBoundaryMs ?? frames[frames.length - 1].t_ms;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (frames[mid].frame_idx <= index) low = mid;
    else high = mid - 1;
  }
  return frames[low].t_ms;
}

export function nearestFrameIndex(frames: readonly FrameTime[], ms: number, fps: number): number {
  if (!frames.length) return Math.max(0, Math.round(ms * Math.max(fps, 1) / 1000));
  const position = positionAtTime(frames, ms);
  const next = frames[position + 1];
  return next && next.t_ms - ms <= ms - frames[position].t_ms ? next.frame_idx : frames[position].frame_idx;
}

export function steppedFrameTimeMs(frames: readonly FrameTime[], ms: number, count: number, fps: number): number {
  if (!frames.length) return ms + count * 1000 / Math.max(fps, 1);
  const position = Math.max(0, Math.min(frames.length - 1, positionAtTime(frames, ms) + count));
  return frames[position].t_ms;
}

export function frameIntervalMs(frames: readonly FrameTime[], ms: number, fps: number): number {
  if (frames.length > 1) {
    const position = positionAtTime(frames, ms);
    const interval = position + 1 < frames.length ? frames[position + 1].t_ms - frames[position].t_ms : frames[position].t_ms - frames[position - 1].t_ms;
    if (interval > 0) return interval;
  }
  return 1000 / Math.max(fps, 1);
}
