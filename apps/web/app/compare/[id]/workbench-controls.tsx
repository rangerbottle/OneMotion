"use client";

import type { ViewMode } from "./stage";

export const VIEW_MODES: { id: ViewMode; label: string; key: string }[] = [
  { id: "split", label: "Split", key: "1" },
  { id: "overlay", label: "Overlay", key: "2" },
  { id: "difference", label: "Difference", key: "3" },
];

export function WorkbenchToolbar({ filenameA, filenameB, cameraLabel, viewMode, reporting, onViewMode, onAlign, onReport, onDelete }: {
  filenameA: string; filenameB: string; cameraLabel: string;
  viewMode: ViewMode; reporting: boolean; onViewMode: (mode: ViewMode) => void;
  onAlign: () => void; onReport: () => void; onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-[var(--surface-muted)] p-3 text-sm">
      <div className="min-w-0">
        <h1 className="truncate font-semibold">Comparison workbench</h1>
        <p className="truncate text-xs text-[var(--muted)]">{filenameA} ↔ {filenameB}</p>
      </div>
      <span className="text-xs text-[var(--muted)]">{cameraLabel}</span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-full border border-[var(--border)]">
          {VIEW_MODES.map((mode) => <button key={mode.id} type="button" onClick={() => onViewMode(mode.id)}
            className={`px-3 py-1.5 ${viewMode === mode.id ? "bg-[var(--accent)] text-[var(--surface)]" : ""}`}
          >{mode.label}<span className="ml-1 text-[10px] opacity-60">{mode.key}</span></button>)}
        </div>
        <button type="button" onClick={onAlign} className="rounded-full border border-[var(--border)] px-4 py-1.5">⚙ Align</button>
        <button type="button" disabled={reporting} onClick={onReport} className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-[var(--surface)]">Export report</button>
        <button type="button" onClick={onDelete} className="rounded-full border border-red-500/40 px-3 py-1.5 text-red-500">Delete</button>
      </div>
    </div>
  );
}

export function WorkbenchTransport({ playing, speed, alignedMs, durationMs, viewMode, opacity, onPlaying, onStep, onSpeed, onOpacity, onMarker }: {
  playing: boolean; speed: number; alignedMs: number; durationMs: number;
  viewMode: ViewMode; opacity: number;
  onPlaying: () => void; onStep: (frames: number) => void;
  onSpeed: (speed: number) => void; onOpacity: (opacity: number) => void; onMarker: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <button type="button" onClick={onPlaying} className="h-9 min-w-20 rounded-full border border-[var(--border)] px-4">{playing ? "Pause" : "Play"}</button>
      <button type="button" onClick={() => onStep(-1)} className="h-9 min-w-10 rounded-full border border-[var(--border)] px-3">−1</button>
      <button type="button" onClick={() => onStep(1)} className="h-9 min-w-10 rounded-full border border-[var(--border)] px-3">+1</button>
      <div className="flex overflow-hidden rounded-full border border-[var(--border)]">
        {[0.25, 0.5, 1].map((value) => <button key={value} type="button" onClick={() => onSpeed(value)}
          className={`px-3 py-1.5 tabular-nums ${speed === value ? "bg-[var(--accent)] text-[var(--surface)]" : ""}`}
        >{value}×</button>)}
      </div>
      <span data-testid="comparison-clock" className="tabular-nums text-xs text-[var(--muted)]">{(alignedMs / 1000).toFixed(3)}s / {(durationMs / 1000).toFixed(3)}s</span>
      {viewMode === "overlay" ? <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
        Opacity
        <input type="range" min={0} max={100} value={Math.round(opacity * 100)}
          onChange={(event) => onOpacity(Number(event.target.value) / 100)} className="w-28 accent-foreground"
        />
      </label> : null}
      <button type="button" onClick={onMarker} className="ml-auto rounded-full border border-[var(--border)] px-4 py-1.5">+ Marker <kbd className="text-[10px] opacity-60">M</kbd></button>
    </div>
  );
}
