"use client";

import { useCallback, useRef, useState } from "react";
import type { EventMarker, PhaseBoundary } from "@/lib/compare-api";

const PHASE_COLORS = ["bg-sky-500", "bg-amber-500", "bg-emerald-500", "bg-rose-500", "bg-violet-500", "bg-cyan-500"];

function phaseColor(index: number) {
  return PHASE_COLORS[index % PHASE_COLORS.length];
}

export default function Timeline({
  durationMs,
  offsetMsA,
  offsetMsB,
  clipDurationA,
  clipDurationB,
  fpsA,
  fpsB,
  phasesA,
  phasesB,
  markers,
  currentAlignedMs,
  onSeek,
  onPatchPhases,
  onDeleteMarker,
}: {
  durationMs: number;
  offsetMsA: number;
  offsetMsB: number;
  clipDurationA: number;
  clipDurationB: number;
  fpsA: number;
  fpsB: number;
  phasesA: PhaseBoundary[];
  phasesB: PhaseBoundary[];
  markers: EventMarker[];
  currentAlignedMs: number;
  onSeek: (alignedMs: number) => void;
  onPatchPhases: (side: "a" | "b", phases: PhaseBoundary[]) => void;
  onDeleteMarker: (markerId: string) => void;
}) {
  const trackA = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ side: "a" | "b"; index: number; frame: number } | null>(null);

  const toAligned = (side: "a" | "b", clipMs: number) =>
    clipMs - (side === "a" ? offsetMsA : offsetMsB);

  const seekFromPointer = useCallback((clientX: number) => {
    const el = trackA.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    onSeek(Math.round(ratio * durationMs));
  }, [durationMs, onSeek]);

  const startBoundaryDrag = (side: "a" | "b", index: number, event: React.PointerEvent) => {
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    setDrag({ side, index, frame: side === "a" ? phasesA[index].end_frame : phasesB[index].end_frame });
  };

  const moveBoundaryDrag = (event: React.PointerEvent) => {
    if (!drag) return;
    const el = trackA.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    const clipMs = ratio * durationMs + (drag.side === "a" ? offsetMsA : offsetMsB);
    const fps = drag.side === "a" ? fpsA : fpsB;
    const source = drag.side === "a" ? phasesA : phasesB;
    const frameCount = Math.max(Math.round((drag.side === "a" ? clipDurationA : clipDurationB) / 1000 * fps), 1);
    // Clamp inside the neighbouring phases so the PATCH can never be
    // rejected for an inverted or out-of-range boundary.
    const lower = source[drag.index]?.start_frame ?? 0;
    const upper = Math.min(
      source[drag.index + 1]?.end_frame ?? frameCount - 1,
      frameCount - 1,
    );
    const frame = Math.min(Math.max(Math.round((clipMs / 1000) * fps), lower), upper);
    setDrag({ ...drag, frame });
  };

  const endBoundaryDrag = () => {
    if (!drag) return;
    const source = drag.side === "a" ? phasesA : phasesB;
    const next = source.map((phase, i) => {
      if (i === drag.index) return { ...phase, end_frame: drag.frame };
      if (i === drag.index + 1) return { ...phase, start_frame: drag.frame + 1 };
      return phase;
    });
    const cleaned = next.filter((phase, i) => phase.start_frame <= phase.end_frame || i === next.length - 1);
    onPatchPhases(drag.side, cleaned);
    setDrag(null);
  };

  const renderTrack = (side: "a" | "b", phases: PhaseBoundary[], offset: number, clipDuration: number, fps: number) => (
    <div className="flex items-center gap-2">
      <span className={`w-6 text-xs font-semibold ${side === "a" ? "text-blue-500" : "text-orange-500"}`}>{side.toUpperCase()}</span>
      <div
        ref={side === "a" ? trackA : undefined}
        className="relative h-8 flex-1 cursor-pointer overflow-hidden rounded-md bg-zinc-200 dark:bg-zinc-800"
        onPointerDown={(e) => seekFromPointer(e.clientX)}
      >
        {/* visible window: where this clip has frames, relative to aligned time */}
        <div
          className={`absolute inset-y-0 ${side === "a" ? "bg-blue-500/15" : "bg-orange-500/15"}`}
          style={{
            left: `${(toAligned(side, 0) / durationMs) * 100}%`,
            width: `${(clipDuration / durationMs) * 100}%`,
          }}
        />
        {phases.map((phase, i) => {
          const startMs = (phase.start_frame / fps) * 1000;
          const endMs = ((phase.end_frame + 1) / fps) * 1000;
          return (
            <div
              key={phase.phase}
              className={`absolute inset-y-0 ${phaseColor(i)} ${drag?.side === side && drag.index === i ? "opacity-70" : "opacity-30"}`}
              style={{
                left: `${(toAligned(side, startMs) / durationMs) * 100}%`,
                width: `${Math.max(((endMs - startMs) / durationMs) * 100, 0.4)}%`,
              }}
              title={`${phase.phase}: 帧 ${phase.start_frame}–${phase.end_frame}`}
            />
          );
        })}
        {markers
          .filter((marker) => marker.side === "both" || marker.side === side)
          .map((marker) => {
            // Markers store A-timeline ms; the track axis is aligned time.
            const aligned = marker.t_ms - offsetMsA;
            return (
              <button
                key={`${side}-${marker.marker_id}`}
                className="absolute -top-0.5 h-9 w-3 -translate-x-1/5 text-zinc-700 dark:text-zinc-200"
                style={{ left: `${(aligned / durationMs) * 100}%` }}
                title={`${marker.text || "标记"}（点击定位，双击删除）`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onSeek(aligned);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onDeleteMarker(marker.marker_id);
                }}
              >▼</button>
            );
          })}
        {phases.slice(0, -1).map((phase, i) => (
          <div
            key={`handle-${phase.phase}`}
            className="absolute inset-y-0 w-2 cursor-ew-resize touch-none"
            style={{ left: `calc(${(toAligned(side, ((drag?.side === side && drag.index === i ? drag.frame : phase.end_frame) / fps) * 1000) / durationMs) * 100}% - 4px)` }}
            onPointerDown={(e) => startBoundaryDrag(side, i, e)}
            onPointerMove={moveBoundaryDrag}
            onPointerUp={endBoundaryDrag}
          />
        ))}
      </div>
    </div>
  );

  const playhead = Math.min(Math.max(currentAlignedMs / durationMs, 0), 1) * 100;

  return (
    <div className="relative space-y-1.5">
      {renderTrack("a", phasesA, offsetMsA, clipDurationA, fpsA)}
      {renderTrack("b", phasesB, offsetMsB, clipDurationB, fpsB)}
      <div
        className="pointer-events-none absolute bottom-0 top-0 w-px bg-red-500"
        style={{ left: `calc(1.5rem + 8px + (100% - 1.5rem - 8px) * ${playhead / 100})` }}
      />
    </div>
  );
}
