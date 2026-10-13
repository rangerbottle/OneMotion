"use client";

import { useId, type ReactNode } from "react";
import { apiUrl } from "@/lib/api";
import type { AffineTransform, ComparisonPatch, ComparisonState, ReportRef } from "@/lib/compare-api";

function Dialog({ title, children, onClose, wide = false }: {
  title: string; children: ReactNode; onClose: () => void; wide?: boolean;
}) {
  const titleId = useId();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--foreground)]/40 p-4" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        className={`max-h-[85vh] w-full overflow-y-auto rounded-2xl bg-[var(--surface)] p-5 shadow-xl ${wide ? "max-w-2xl" : "max-w-md"}`}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 id={titleId} className="font-semibold">{title}</h3>
          <button type="button" aria-label="Close dialog" onClick={onClose} className="rounded-full px-2 py-1 text-[var(--muted)]">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function MarkerDialog({ text, side, onText, onSide, onAdd, onClose }: {
  text: string; side: "both" | "a" | "b";
  onText: (text: string) => void; onSide: (side: "both" | "a" | "b") => void;
  onAdd: () => void; onClose: () => void;
}) {
  return (
    <Dialog title="Add a marker at this frame" onClose={onClose}>
      <input
        autoFocus value={text} onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") onAdd(); }}
        placeholder="For example: wrist opens late"
        className="mb-3 h-10 w-full rounded-xl border border-[var(--border)] bg-transparent px-3"
      />
      <div className="mb-4 flex gap-2 text-sm">
        {(["both", "a", "b"] as const).map((value) => (
          <button key={value} type="button" onClick={() => onSide(value)}
            className={`rounded-full px-3 py-1 ${side === value ? "bg-[var(--accent)] text-[var(--surface)]" : "bg-[var(--surface-muted)]"}`}
          >{value === "both" ? "Both" : value === "a" ? "A only" : "B only"}</button>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-10 rounded-full border border-[var(--border)] px-5">Cancel</button>
        <button type="button" onClick={onAdd} className="h-10 rounded-full bg-[var(--accent)] px-5 text-[var(--surface)]">Add</button>
      </div>
    </Dialog>
  );
}

const SPATIAL_FIELDS = [
  { key: "tx", label: "Horizontal translation", min: -100, max: 100, factor: 1, unit: "px" },
  { key: "ty", label: "Vertical translation", min: -100, max: 100, factor: 1, unit: "px" },
  { key: "scale", label: "Scale", min: 80, max: 120, factor: 100, unit: "%" },
  { key: "rotation_deg", label: "Rotation", min: -10, max: 10, factor: 1, unit: "°" },
] as const;

export function AlignmentDialog({ state, initialSpatial, durationA, durationB, onPatch, onClose }: {
  state: ComparisonState; initialSpatial: AffineTransform;
  durationA: number; durationB: number;
  onPatch: (patch: ComparisonPatch) => void; onClose: () => void;
}) {
  return (
    <Dialog title="Alignment settings" onClose={onClose}>
      <p className="mb-4 text-xs text-[var(--muted)]">Spatial alignment overlays clip B on baseline A. Temporal alignment sets the action start in each clip.</p>
      <div className="space-y-3 text-sm">
        {SPATIAL_FIELDS.map((field) => (
          <label key={field.key} className="flex items-center gap-3">
            <span className="w-36 text-[var(--muted)]">{field.label}</span>
            <input type="range" min={field.min} max={field.max}
              value={Math.round(state.spatial[field.key] * field.factor)}
              onChange={(event) => onPatch({ spatial: { ...state.spatial, [field.key]: Number(event.target.value) / field.factor } })}
              className="flex-1 accent-foreground"
            />
            <span className="w-10 text-right tabular-nums text-xs">{Math.round(state.spatial[field.key] * field.factor)}{field.unit}</span>
          </label>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        {([{ side: "A", key: "offset_ms_a", duration: durationA }, { side: "B", key: "offset_ms_b", duration: durationB }] as const).map((field) => {
          const maximum = Math.max(0, Math.ceil(field.duration) - 1);
          return (
            <label key={field.key} className="flex flex-col gap-1">
              <span className="text-xs text-[var(--muted)]">{field.side} action start (ms)</span>
              <input type="number" min={0} max={maximum} value={state.temporal[field.key]}
                onChange={(event) => onPatch({ temporal: { [field.key]: Math.min(maximum, Math.max(0, Math.round(Number(event.target.value) || 0))) } })}
                className="h-10 rounded-xl border border-[var(--border)] bg-transparent px-3"
              />
            </label>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-[var(--muted)]">
        Suggested B start: {state.temporal.suggested_offset_ms_b ?? "—"} ms
        {state.temporal.suggestion_confidence !== null ? ` (confidence ${(state.temporal.suggestion_confidence * 100).toFixed(0)}%)` : ""}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={() => onPatch({ spatial: initialSpatial })} className="h-10 rounded-full border border-[var(--border)] px-5">Reset automatic alignment</button>
        <button type="button" onClick={onClose} className="h-10 rounded-full bg-[var(--accent)] px-5 text-[var(--surface)]">Done</button>
      </div>
    </Dialog>
  );
}

export function ReportDialog({ report, reporting, error, onExport, onClose }: {
  report: ReportRef | null; reporting: boolean; error: string | null;
  onExport: () => void; onClose: () => void;
}) {
  return (
    <Dialog title="Comparison report" onClose={onClose} wide>
      {reporting ? <p role="status" className="py-8 text-center text-sm text-[var(--muted)]">Generating keyframes…</p> : null}
      {!report && !reporting ? <div className="space-y-3 text-sm">
        <p role="alert">{error ?? "The report is not ready. Please try again."}</p>
        <button type="button" onClick={onExport} className="rounded-full border px-4 py-2">Regenerate</button>
        <button type="button" onClick={onClose} className="ml-2 rounded-full border px-4 py-2">Close</button>
      </div> : null}
      {report && !reporting ? (
        <div className="space-y-4 text-sm">
          <p className="rounded-xl bg-[var(--surface-muted)] p-3 text-xs">{report.summary_text}</p>
          {report.keyframes.length ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {report.keyframes.map((frame, index) => (
                <figure key={frame.url} className="rounded-xl border border-[var(--border)] p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={apiUrl(`${frame.url}?v=${encodeURIComponent(report.created_at)}`) ?? undefined} alt={`Keyframe ${index + 1}`} className="w-full rounded-lg" />
                  <figcaption className="mt-1 text-xs text-[var(--muted)]">
                    #{index + 1} · Deviation {frame.deviation.toFixed(3)} · A {(frame.t_ms_a / 1000).toFixed(2)}s / B {(frame.t_ms_b / 1000).toFixed(2)}s
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : <p className="text-xs text-[var(--muted)]">No keyframes could be decoded. The video may have expired.</p>}
          {report.phase_offsets.length ? <ul className="space-y-1">
            {report.phase_offsets.map((item) => <li key={item.phase}>
              {item.phase}: B {item.delta_frames >= 0 ? "later" : "earlier"} {Math.abs(item.delta_frames)} {Math.abs(item.delta_frames) === 1 ? "frame" : "frames"} ({item.delta_ms >= 0 ? "+" : ""}{item.delta_ms} ms)
            </li>)}
          </ul> : null}
          <div className="flex items-center justify-between border-t border-[var(--border)] pt-3">
            <input readOnly aria-label="Report link" value={typeof window !== "undefined" ? window.location.href : ""}
              className="h-9 w-2/3 rounded-lg border border-[var(--border)] bg-transparent px-2 text-xs"
              onFocus={(event) => event.target.select()}
            />
            <div className="flex gap-2">
              <button type="button" onClick={onExport} disabled={reporting} className="h-9 rounded-full border border-[var(--border)] px-4">Regenerate</button>
              <button type="button" onClick={onClose} className="h-9 rounded-full bg-[var(--accent)] px-4 text-[var(--surface)]">Close</button>
            </div>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
