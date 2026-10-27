"use client";

import MediaSourceDetails from "@/app/components/media-source-details";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { deleteComparison, type PhaseBoundary } from "@/lib/compare-api";
import { frameTimeMs, steppedFrameTimeMs } from "@/lib/frame-time";
import Stage, { frameAt, type ViewMode } from "./stage";
import Timeline from "./timeline";
import MetricsPanel from "./metrics-panel";
import { useComparisonWorkbench } from "./use-comparison-workbench";
import { AlignmentDialog, MarkerDialog, ReportDialog } from "./workbench-dialogs";
import { VIEW_MODES, WorkbenchToolbar, WorkbenchTransport } from "./workbench-controls";

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
}

function isActivatable(target: EventTarget | null): boolean {
  // Space/Enter on a focused button or link belongs to that control — the
  // global playback shortcut must not steal it.
  return target instanceof HTMLElement && (target.tagName === "BUTTON" || target.tagName === "A");
}

export default function Workbench({ comparisonId }: { comparisonId: string }) {
  // Route transitions may preserve client components. A comparison gets its
  // own transport/dialog state as well as its own controller/request queue.
  return <WorkbenchView key={comparisonId} comparisonId={comparisonId} />;
}

function WorkbenchView({ comparisonId }: { comparisonId: string }) {
  const router = useRouter();
  const { data, notFound, loadError, saveStatus, saveError, reporting, reportError, controller } = useComparisonWorkbench(comparisonId);
  const state = data?.comparison;
  const [viewMode, setViewMode] = useState<ViewMode>("overlay");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.5);
  const [alignedMs, setAlignedMs] = useState(0);
  const [seekRequest, setSeekRequest] = useState<{ ms: number; nonce: number } | null>(null);
  const [markerDialog, setMarkerDialog] = useState(false);
  const [markerText, setMarkerText] = useState("");
  const [markerSide, setMarkerSide] = useState<"both" | "a" | "b">("both");
  const [alignDialog, setAlignDialog] = useState(false);
  const [reportDialog, setReportDialog] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [stageError, setStageError] = useState<string | null>(null);
  const [stageNonce, setStageNonce] = useState(0);

  const durationMs = useMemo(() => data ? Math.max(1, Math.min(
    data.clipA.duration_ms - data.comparison.temporal.offset_ms_a,
    data.clipB.duration_ms - data.comparison.temporal.offset_ms_b,
  )) : 1, [data]);

  const seekTo = useCallback((ms: number) => {
    const bounded = Math.min(Math.max(ms, 0), durationMs);
    setPlaying(false);
    setAlignedMs(bounded);
    setSeekRequest((previous) => ({ ms: bounded, nonce: (previous?.nonce ?? 0) + 1 }));
  }, [durationMs]);

  const onTick = useCallback((msA: number) => {
    if (state) setAlignedMs(Math.max(0, msA - state.temporal.offset_ms_a));
  }, [state]);

  const stepFrames = useCallback((frames: number) => {
    if (!data) return;
    const sourceMs = alignedMs + data.comparison.temporal.offset_ms_a;
    seekTo(steppedFrameTimeMs(data.poseA.frames, sourceMs, frames, data.clipA.fps) - data.comparison.temporal.offset_ms_a);
  }, [alignedMs, data, seekTo]);

  const addMarker = useCallback(() => {
    if (!data) return;
    const msA = alignedMs + data.comparison.temporal.offset_ms_a;
    const frame = frameAt(data.poseA.frames, msA);
    // crypto.randomUUID is secure-context only; LAN HTTP origins need a fallback.
    const markerId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    controller.patch({ markers: [...data.comparison.markers, {
      marker_id: markerId,
      side: markerSide,
      frame: frame?.frame_idx ?? 0,
      // A manual alignment may begin inside a frame's presentation interval.
      // Keep the marker on the current visible time while identifying that frame.
      t_ms: Math.round(msA),
      text: markerText.trim(),
      created_at: new Date().toISOString(),
    }] });
    setMarkerDialog(false);
    setMarkerText("");
  }, [data, alignedMs, markerSide, markerText, controller]);

  const deleteMarker = useCallback((markerId: string) => {
    if (state) controller.patch({ markers: state.markers.filter((marker) => marker.marker_id !== markerId) });
  }, [state, controller]);

  const patchPhases = useCallback((side: "a" | "b", phases: PhaseBoundary[]) => {
    controller.patch(side === "a" ? { phases_a: phases } : { phases_b: phases });
  }, [controller]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || markerDialog || alignDialog || reportDialog) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        stepFrames((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1));
      } else if (event.key === " ") {
        if (isActivatable(event.target)) return;
        event.preventDefault();
        setPlaying((current) => !current);
      } else if (event.key === "m" || event.key === "M") {
        setMarkerDialog(true);
      } else {
        const view = VIEW_MODES.find((mode) => mode.key === event.key);
        if (view) setViewMode(view.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepFrames, markerDialog, alignDialog, reportDialog]);

  if (notFound) return <div className="page-shell page-shell-narrow space-y-4">
    <h1 className="text-xl font-semibold">Comparison not found</h1>
    <p>This comparison may have been deleted.</p>
    <Link href="/compare" className="underline">Back to comparisons</Link>
  </div>;
  if (loadError && !data) return <div role="status" className="page-shell page-shell-narrow space-y-4 text-sm text-[var(--muted)]">
    <p>{loadError}</p>
    <button className="rounded-full border px-4 py-2" onClick={controller.retryLoad}>Retry</button>
  </div>;
  if (!data || !state) return <div role="status" className="page-shell text-center text-sm text-[var(--muted)]">Loading comparison workbench…</div>;

  const { clipA, clipB, poseA, poseB, metrics, initialSpatial } = data;
  const timingReliable = [clipA, clipB].every((clip) => !clip.source || clip.source.timing_mode === "realtime");
  const phaseOffsets = timingReliable ? state.phases_a.flatMap((phaseA) => {
    const phaseB = state.phases_b.find((phase) => phase.phase === phaseA.phase);
    return phaseB ? [{
      phase: phaseA.phase,
      deltaFrames: phaseB.start_frame - phaseA.start_frame,
      deltaMs: Math.round(frameTimeMs(poseB.frames, phaseB.start_frame, clipB.fps)) - Math.round(frameTimeMs(poseA.frames, phaseA.start_frame, clipA.fps)),
    }] : [];
  }) : [];
  const cameraLabel = state.camera_check
    ? ({ match: "✅ Camera matched", suspect: "⚠️ Camera may have moved", mismatch: "❌ Camera mismatch" }[state.camera_check.status]) : "";

  return (
    <div className="page-shell page-shell-wide flex flex-1 flex-col gap-4">
      <WorkbenchToolbar
        filenameA={clipA.filename} filenameB={clipB.filename} cameraLabel={cameraLabel}
        viewMode={viewMode} reporting={reporting} onViewMode={setViewMode}
        onAlign={() => setAlignDialog(true)}
        onReport={() => { setReportDialog(true); void controller.exportReport(); }}
        onDelete={() => {
          if (!window.confirm("Delete this comparison? The video clips will be kept.")) return;
          void controller.flush().catch(() => undefined)
            .then(() => deleteComparison(comparisonId))
            .then(() => router.push("/compare"))
            .catch(() => setDeleteError("Could not delete. Please try again."));
        }}
      />
      {clipA.source || clipB.source ? <div className="grid gap-3 md:grid-cols-2">
        <MediaSourceDetails source={clipA.source} title="Baseline clip source" />
        <MediaSourceDetails source={clipB.source} title="Comparison clip source" />
      </div> : null}
      <div aria-live="polite" className="text-xs text-[var(--muted)]">
        {saveStatus === "saved" ? "Changes saved" : saveStatus === "pending" ? "Unsaved changes…" : saveStatus === "saving" ? "Saving…" : null}
        {saveError ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-600">
          <p>{saveError}</p>
          <button type="button" onClick={controller.retrySave} className="rounded-full border px-3 py-1">Retry save</button>
        </div> : null}
      </div>
      {deleteError ? <p role="alert" className="text-sm text-amber-600">{deleteError}</p> : null}
      {stageError ? <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 p-3 text-sm text-amber-600">
        <p>{stageError}</p>
        <button type="button" onClick={() => { setStageError(null); setPlaying(false); setStageNonce((n) => n + 1); }} className="rounded-full border px-3 py-1">Retry video</button>
      </div> : null}
      <Stage key={stageNonce} mode={viewMode} comparisonId={comparisonId} opacity={state.opacity_default} spatial={state.spatial}
        poseA={poseA} poseB={poseB} offsetMsA={state.temporal.offset_ms_a} offsetMsB={state.temporal.offset_ms_b}
        playing={playing} speed={speed} seekRequest={seekRequest} onTick={onTick}
        onError={(message) => { setPlaying(false); setStageError(message); }}
        onEnded={() => setPlaying(false)}
      />
      <WorkbenchTransport
        playing={playing} speed={speed} alignedMs={alignedMs} durationMs={durationMs} viewMode={viewMode}
        opacity={state.opacity_default} onPlaying={() => setPlaying((current) => !current)}
        onStep={stepFrames} onSpeed={setSpeed} onOpacity={(opacity) => controller.patch({ opacity_default: opacity })}
        onMarker={() => setMarkerDialog(true)}
      />
      <Timeline durationMs={durationMs} offsetMsA={state.temporal.offset_ms_a} offsetMsB={state.temporal.offset_ms_b}
        clipDurationA={clipA.duration_ms} clipDurationB={clipB.duration_ms} fpsA={clipA.fps} fpsB={clipB.fps}
        framesA={poseA.frames} framesB={poseB.frames}
        phasesA={state.phases_a} phasesB={state.phases_b} markers={state.markers} currentAlignedMs={alignedMs}
        onSeek={seekTo} onPatchPhases={patchPhases} onDeleteMarker={deleteMarker}
      />
      {phaseOffsets.length ? <div className="flex flex-wrap gap-2 text-xs">
        {phaseOffsets.map((item) => <span key={item.phase} className="rounded-full bg-[var(--surface-muted)] px-3 py-1">
          {item.phase}: B {item.deltaFrames >= 0 ? "later" : "earlier"} {Math.abs(item.deltaFrames)} {Math.abs(item.deltaFrames) === 1 ? "frame" : "frames"} ({item.deltaMs >= 0 ? "+" : ""}{item.deltaMs} ms)
        </span>)}
      </div> : null}
      <MetricsPanel metrics={metrics} currentAlignedMs={alignedMs} offsetMsA={state.temporal.offset_ms_a}
        offsetMsB={state.temporal.offset_ms_b} durationMs={durationMs} onSeek={seekTo}
      />
      <p className="text-xs text-[var(--muted)]">Shortcuts: ←/→ step a frame · Shift+←/→ step 10 frames · Space play/pause · 1/2/3 switch views · M add a marker. Drag phase boundaries on the timeline to adjust phases; changes save automatically.</p>
      {markerDialog ? <MarkerDialog text={markerText} side={markerSide} onText={setMarkerText} onSide={setMarkerSide} onAdd={addMarker} onClose={() => setMarkerDialog(false)} /> : null}
      {alignDialog ? <AlignmentDialog state={state} initialSpatial={initialSpatial} durationA={clipA.duration_ms}
        durationB={clipB.duration_ms} onPatch={controller.patch} onClose={() => setAlignDialog(false)}
      /> : null}
      {reportDialog ? <ReportDialog report={state.report} reporting={reporting} error={reportError}
        onExport={() => { void controller.exportReport(); }} onClose={() => setReportDialog(false)}
      /> : null}
    </div>
  );
}
