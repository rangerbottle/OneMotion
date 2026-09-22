"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  deleteComparison,
  generateComparisonReport,
  getClip,
  getClipPose,
  getComparison,
  getComparisonMetrics,
  patchComparison,
  type ClipMeta,
  type ComparisonMetrics,
  type ComparisonState,
  type PhaseBoundary,
  type ReportRef,
} from "@/lib/compare-api";
import type { ShotSequence } from "@/lib/api";
import Stage, { frameAt, type ViewMode } from "./stage";
import Timeline from "./timeline";
import MetricsPanel from "./metrics-panel";

const SPEEDS = [0.25, 0.5, 1];
const VIEW_MODES: { id: ViewMode; label: string; key: string }[] = [
  { id: "split", label: "双联", key: "1" },
  { id: "overlay", label: "叠加", key: "2" },
  { id: "difference", label: "差分", key: "3" },
];

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
}

export default function Workbench({ comparisonId }: { comparisonId: string }) {
  const router = useRouter();
  const [state, setState] = useState<ComparisonState | null>(null);
  const [clipA, setClipA] = useState<ClipMeta | null>(null);
  const [clipB, setClipB] = useState<ClipMeta | null>(null);
  const [poseA, setPoseA] = useState<ShotSequence | null>(null);
  const [poseB, setPoseB] = useState<ShotSequence | null>(null);
  const [metrics, setMetrics] = useState<ComparisonMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [viewMode, setViewMode] = useState<ViewMode>("overlay");
  const [opacity, setOpacity] = useState(0.5);
  const [spatial, setSpatial] = useState({ tx: 0, ty: 0, scale: 1, rotation_deg: 0 });
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.5);
  const [alignedMs, setAlignedMs] = useState(0);
  const [seekRequest, setSeekRequest] = useState<{ ms: number; nonce: number } | null>(null);
  const [markerDialog, setMarkerDialog] = useState(false);
  const [markerText, setMarkerText] = useState("");
  const [markerSide, setMarkerSide] = useState<"both" | "a" | "b">("both");
  const [alignDialog, setAlignDialog] = useState(false);
  const [reportDialog, setReportDialog] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [report, setReport] = useState<ReportRef | null>(null);

  const patchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getComparison(comparisonId),
      getComparisonMetrics(comparisonId),
    ])
      .then(async ([comparison, metricData]) => {
        if (cancelled) return;
        const [metaA, metaB, poseDataA, poseDataB] = await Promise.all([
          getClip(comparison.baseline_clip_id),
          getClip(comparison.comparison_clip_id),
          getClipPose(comparison.baseline_clip_id),
          getClipPose(comparison.comparison_clip_id),
        ]);
        if (cancelled) return;
        setState(comparison);
        setClipA(metaA);
        setClipB(metaB);
        setPoseA(poseDataA);
        setPoseB(poseDataB);
        setMetrics(metricData);
        setOpacity(comparison.opacity_default);
        setSpatial(comparison.spatial);
        setReport(comparison.report);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof Error && "status" in err && (err as { status: number }).status === 404) {
          setNotFound(true);
        } else {
          setError(err instanceof Error ? err.message : "加载对比数据失败。");
        }
      });
    return () => { cancelled = true; };
  }, [comparisonId]);

  const durationMs = useMemo(() => {
    if (!state || !clipA || !clipB) return 1;
    return Math.max(
      1,
      Math.min(
        clipA.duration_ms - state.temporal.offset_ms_a,
        clipB.duration_ms - state.temporal.offset_ms_b,
      ),
    );
  }, [state, clipA, clipB]);

  const seekTo = useCallback((ms: number) => {
    const bounded = Math.min(Math.max(ms, 0), durationMs);
    setAlignedMs(bounded);
    setSeekRequest((prev) => ({ ms: bounded, nonce: (prev?.nonce ?? 0) + 1 }));
  }, [durationMs]);

  const patch = useCallback((patchBody: Parameters<typeof patchComparison>[1]) => {
    setState((current) => {
      if (!current) return current;
      const next = { ...current };
      if (patchBody.spatial) next.spatial = patchBody.spatial;
      if (patchBody.opacity_default !== undefined) next.opacity_default = patchBody.opacity_default;
      if (patchBody.phases_a) next.phases_a = patchBody.phases_a;
      if (patchBody.phases_b) next.phases_b = patchBody.phases_b;
      if (patchBody.markers) next.markers = patchBody.markers;
      if (patchBody.temporal) next.temporal = { ...current.temporal, ...patchBody.temporal };
      return next;
    });
    if (patchTimer.current) clearTimeout(patchTimer.current);
    patchTimer.current = setTimeout(() => {
      void patchComparison(comparisonId, patchBody).catch(() => setError("保存失败，请检查网络后重试。"));
    }, 600);
  }, [comparisonId]);

  const onTick = useCallback((msA: number) => {
    if (!state) return;
    setAlignedMs(msA - state.temporal.offset_ms_a);
  }, [state]);

  const stepFrames = useCallback((frames: number) => {
    if (!clipA) return;
    setPlaying(false);
    setAlignedMs((current) => {
      const next = Math.min(Math.max(current + (frames * 1000) / clipA.fps, 0), durationMs);
      setSeekRequest((prev) => ({ ms: next, nonce: (prev?.nonce ?? 0) + 1 }));
      return next;
    });
  }, [clipA, durationMs]);

  const addMarker = useCallback(() => {
    if (!state || !poseA) return;
    const msA = alignedMs + state.temporal.offset_ms_a;
    const frame = frameAt(poseA.frames, msA);
    const marker = {
      marker_id: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
      side: markerSide,
      frame: frame ? frame.frame_idx : 0,
      t_ms: Math.round(msA),
      text: markerText.trim(),
      created_at: new Date().toISOString(),
    };
    patch({ markers: [...state.markers, marker] });
    setMarkerDialog(false);
    setMarkerText("");
  }, [state, poseA, alignedMs, markerSide, markerText, patch]);

  const deleteMarker = useCallback((markerId: string) => {
    if (!state) return;
    patch({ markers: state.markers.filter((m) => m.marker_id !== markerId) });
  }, [state, patch]);

  const patchPhases = useCallback((side: "a" | "b", phases: PhaseBoundary[]) => {
    patch(side === "a" ? { phases_a: phases } : { phases_b: phases });
  }, [patch]);

  // Keyboard shortcuts: arrows step frames, Shift = ×10, space toggles play,
  // 1/2/3 switch views, M adds a marker at the playhead.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepFrames(event.shiftKey ? -10 : -1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        stepFrames(event.shiftKey ? 10 : 1);
      } else if (event.key === " ") {
        event.preventDefault();
        setPlaying((p) => !p);
      } else if (event.key === "m" || event.key === "M") {
        setMarkerDialog(true);
      } else {
        const view = VIEW_MODES.find((v) => v.key === event.key);
        if (view) setViewMode(view.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepFrames]);

  const exportReport = useCallback(() => {
    setReporting(true);
    setError(null);
    generateComparisonReport(comparisonId)
      .then((updated) => {
        setState(updated);
        setReport(updated.report);
      })
      .catch(() => setError("报告生成失败，请重试。"))
      .finally(() => setReporting(false));
  }, [comparisonId]);

  if (notFound) {
    return <div className="mx-auto max-w-xl space-y-4 px-6 py-12">
      <h1 className="text-xl font-semibold">对比不存在</h1>
      <p>该对比可能已被删除。</p>
      <Link href="/compare" className="underline">返回对比列表</Link>
    </div>;
  }
  if (error && !state) {
    return <div role="status" className="mx-auto max-w-xl space-y-4 px-6 py-12 text-sm text-zinc-500">
      <p>{error}</p>
      <button className="rounded-full border px-4 py-2" onClick={() => router.refresh()}>重试</button>
    </div>;
  }
  if (!state || !clipA || !clipB || !poseA || !poseB || !metrics) {
    return <div role="status" className="px-6 py-12 text-center text-sm text-zinc-500">正在加载对比工作台…</div>;
  }

  const phaseOffsets = state.phases_a
    .map((phaseA, i) => {
      const phaseB = state.phases_b[i];
      if (!phaseB) return null;
      return {
        phase: phaseA.phase,
        deltaFrames: phaseB.start_frame - phaseA.start_frame,
        deltaMs: Math.round((phaseB.start_frame / clipB.fps) * 1000) - Math.round((phaseA.start_frame / clipA.fps) * 1000),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const cameraLabel = state.camera_check
    ? state.camera_check.status === "match"
      ? "✅ 机位匹配"
      : state.camera_check.status === "suspect"
        ? "⚠️ 机位疑似偏移"
        : "❌ 机位不一致"
    : "";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-6">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-zinc-100 p-3 text-sm dark:bg-zinc-900">
        <div className="min-w-0">
          <p className="truncate font-semibold">对比工作台</p>
          <p className="truncate text-xs text-zinc-500">{clipA.filename} ↔ {clipB.filename}</p>
        </div>
        <span className="text-xs text-zinc-500">{cameraLabel}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-full border border-black/[.08] dark:border-white/[.145]">
            {VIEW_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                onClick={() => setViewMode(mode.id)}
                className={`px-3 py-1.5 ${viewMode === mode.id ? "bg-foreground text-background" : ""}`}
              >{mode.label}<span className="ml-1 text-[10px] opacity-60">{mode.key}</span></button>
            ))}
          </div>
          <button type="button" onClick={() => setAlignDialog(true)} className="rounded-full border border-black/[.08] px-4 py-1.5 dark:border-white/[.145]">⚙ 对齐</button>
          <button
            type="button"
            onClick={() => { setReportDialog(true); if (!report) exportReport(); }}
            className="rounded-full bg-foreground px-4 py-1.5 text-background"
          >导出报告</button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm("删除该对比？（不会删除视频片段）")) {
                void deleteComparison(comparisonId).then(() => router.push("/compare"));
              }
            }}
            className="rounded-full border border-red-500/40 px-3 py-1.5 text-red-500"
          >删除</button>
        </div>
      </div>

      {error ? <p className="text-sm text-amber-600">{error}</p> : null}

      <Stage
        mode={viewMode}
        comparisonId={comparisonId}
        opacity={opacity}
        spatial={spatial}
        poseA={poseA}
        poseB={poseB}
        offsetMsA={state.temporal.offset_ms_a}
        offsetMsB={state.temporal.offset_ms_b}
        playing={playing}
        speed={speed}
        seekRequest={seekRequest}
        onTick={onTick}
      />

      {/* transport */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button type="button" onClick={() => setPlaying((p) => !p)} className="h-9 min-w-20 rounded-full border border-black/[.08] px-4 dark:border-white/[.145]">{playing ? "暂停" : "播放"}</button>
        <button type="button" onClick={() => stepFrames(-1)} className="h-9 min-w-10 rounded-full border border-black/[.08] px-3 dark:border-white/[.145]">−1</button>
        <button type="button" onClick={() => stepFrames(1)} className="h-9 min-w-10 rounded-full border border-black/[.08] px-3 dark:border-white/[.145]">+1</button>
        <div className="flex overflow-hidden rounded-full border border-black/[.08] dark:border-white/[.145]">
          {SPEEDS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setSpeed(value)}
              className={`px-3 py-1.5 tabular-nums ${speed === value ? "bg-foreground text-background" : ""}`}
            >{value}×</button>
          ))}
        </div>
        <span className="font-mono text-xs text-zinc-500">
          {(alignedMs / 1000).toFixed(3)}s / {(durationMs / 1000).toFixed(3)}s
        </span>
        {viewMode === "overlay" ? (
          <label className="flex items-center gap-2 text-xs text-zinc-500">
            透明度
            <input type="range" min={0} max={100} value={Math.round(opacity * 100)} onChange={(e) => setOpacity(Number(e.target.value) / 100)} className="w-28 accent-foreground" />
          </label>
        ) : null}
        <button type="button" onClick={() => setMarkerDialog(true)} className="ml-auto rounded-full border border-black/[.08] px-4 py-1.5 dark:border-white/[.145]">＋标记 <kbd className="text-[10px] opacity-60">M</kbd></button>
      </div>

      <Timeline
        durationMs={durationMs}
        offsetMsA={state.temporal.offset_ms_a}
        offsetMsB={state.temporal.offset_ms_b}
        clipDurationA={clipA.duration_ms}
        clipDurationB={clipB.duration_ms}
        fpsA={clipA.fps}
        fpsB={clipB.fps}
        phasesA={state.phases_a}
        phasesB={state.phases_b}
        markers={state.markers}
        currentAlignedMs={alignedMs}
        onSeek={seekTo}
        onPatchPhases={patchPhases}
        onDeleteMarker={deleteMarker}
      />

      {phaseOffsets.length ? (
        <div className="flex flex-wrap gap-2 text-xs">
          {phaseOffsets.map((item) => (
            <span key={item.phase} className="rounded-full bg-zinc-100 px-3 py-1 dark:bg-zinc-800">
              {item.phase}：B {item.deltaFrames >= 0 ? "晚" : "早"} {Math.abs(item.deltaFrames)} 帧（{item.deltaMs >= 0 ? "+" : ""}{item.deltaMs}ms）
            </span>
          ))}
        </div>
      ) : null}

      <MetricsPanel
        metrics={metrics}
        currentAlignedMs={alignedMs}
        offsetMsA={state.temporal.offset_ms_a}
        offsetMsB={state.temporal.offset_ms_b}
        durationMs={durationMs}
        onSeek={seekTo}
      />

      <p className="text-xs text-zinc-500">
        快捷键：←/→ 逐帧 · Shift+←/→ 跳 10 帧 · 空格 播放/暂停 · 1/2/3 切换视图 · M 添加标记。拖动时间轴上的相位分界可调整阶段划分（自动保存）。
      </p>

      {/* marker dialog */}
      {markerDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setMarkerDialog(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 font-semibold">在当前帧添加标记</h3>
            <input
              autoFocus
              value={markerText}
              onChange={(e) => setMarkerText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addMarker(); }}
              placeholder="例如：手腕打开过晚"
              className="mb-3 h-10 w-full rounded-xl border border-black/[.12] bg-transparent px-3 dark:border-white/[.2]"
            />
            <div className="mb-4 flex gap-2 text-sm">
              {(["both", "a", "b"] as const).map((side) => (
                <button
                  key={side}
                  type="button"
                  onClick={() => setMarkerSide(side)}
                  className={`rounded-full px-3 py-1 ${markerSide === side ? "bg-foreground text-background" : "bg-zinc-100 dark:bg-zinc-800"}`}
                >{side === "both" ? "双边" : side === "a" ? "仅 A" : "仅 B"}</button>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setMarkerDialog(false)} className="h-10 rounded-full border border-black/[.08] px-5 dark:border-white/[.145]">取消</button>
              <button type="button" onClick={addMarker} className="h-10 rounded-full bg-foreground px-5 text-background">添加</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* alignment dialog */}
      {alignDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setAlignDialog(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-1 font-semibold">对齐设置</h3>
            <p className="mb-4 text-xs text-zinc-500">空间对齐把对比片 B 叠加到基准片 A 上；时间对齐标定两条片的「动作起点」。</p>
            <div className="space-y-3 text-sm">
              <label className="flex items-center gap-3">
                <span className="w-20 text-zinc-600 dark:text-zinc-400">水平平移</span>
                <input type="range" min={-100} max={100} value={Math.round(spatial.tx)} onChange={(e) => { const next = { ...spatial, tx: Number(e.target.value) }; setSpatial(next); patch({ spatial: next }); }} className="flex-1 accent-foreground" />
                <span className="w-10 text-right font-mono text-xs">{Math.round(spatial.tx)}px</span>
              </label>
              <label className="flex items-center gap-3">
                <span className="w-20 text-zinc-600 dark:text-zinc-400">垂直平移</span>
                <input type="range" min={-100} max={100} value={Math.round(spatial.ty)} onChange={(e) => { const next = { ...spatial, ty: Number(e.target.value) }; setSpatial(next); patch({ spatial: next }); }} className="flex-1 accent-foreground" />
                <span className="w-10 text-right font-mono text-xs">{Math.round(spatial.ty)}px</span>
              </label>
              <label className="flex items-center gap-3">
                <span className="w-20 text-zinc-600 dark:text-zinc-400">缩放</span>
                <input type="range" min={80} max={120} value={Math.round(spatial.scale * 100)} onChange={(e) => { const next = { ...spatial, scale: Number(e.target.value) / 100 }; setSpatial(next); patch({ spatial: next }); }} className="flex-1 accent-foreground" />
                <span className="w-10 text-right font-mono text-xs">{Math.round(spatial.scale * 100)}%</span>
              </label>
              <label className="flex items-center gap-3">
                <span className="w-20 text-zinc-600 dark:text-zinc-400">旋转</span>
                <input type="range" min={-10} max={10} value={Math.round(spatial.rotation_deg)} onChange={(e) => { const next = { ...spatial, rotation_deg: Number(e.target.value) }; setSpatial(next); patch({ spatial: next }); }} className="flex-1 accent-foreground" />
                <span className="w-10 text-right font-mono text-xs">{Math.round(spatial.rotation_deg)}°</span>
              </label>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">A 动作起点（ms）</span>
                <input
                  type="number" min={0} defaultValue={state.temporal.offset_ms_a}
                  onBlur={(e) => patch({ temporal: { ...state.temporal, offset_ms_a: Math.max(0, Number(e.target.value) || 0) } })}
                  className="h-10 rounded-xl border border-black/[.12] bg-transparent px-3 dark:border-white/[.2]"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">B 动作起点（ms）</span>
                <input
                  type="number" min={0} defaultValue={state.temporal.offset_ms_b}
                  onBlur={(e) => patch({ temporal: { ...state.temporal, offset_ms_b: Math.max(0, Number(e.target.value) || 0) } })}
                  className="h-10 rounded-xl border border-black/[.12] bg-transparent px-3 dark:border-white/[.2]"
                />
              </label>
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              系统建议 B 起点：{state.temporal.suggested_offset_ms_b ?? "—"} ms
              {state.temporal.suggestion_confidence !== null ? `（置信度 ${(state.temporal.suggestion_confidence * 100).toFixed(0)}%）` : ""}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setSpatial(state.spatial); patch({ spatial: state.spatial }); }}
                className="h-10 rounded-full border border-black/[.08] px-5 dark:border-white/[.145]"
              >恢复自动对齐</button>
              <button type="button" onClick={() => setAlignDialog(false)} className="h-10 rounded-full bg-foreground px-5 text-background">完成</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* report dialog */}
      {reportDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setReportDialog(false)}>
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 font-semibold">对比报告</h3>
            {reporting ? <p className="py-8 text-center text-sm text-zinc-500">正在生成关键帧…</p> : null}
            {report ? (
              <div className="space-y-4 text-sm">
                <p className="rounded-xl bg-zinc-100 p-3 text-xs dark:bg-zinc-800">{report.summary_text}</p>
                {report.keyframes.length ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {report.keyframes.map((frame, i) => (
                      <figure key={frame.url} className="rounded-xl border border-black/[.08] p-2 dark:border-white/[.145]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={frame.url} alt={`关键帧 ${i + 1}`} className="w-full rounded-lg" />
                        <figcaption className="mt-1 text-xs text-zinc-500">
                          #{i + 1} · 偏差 {frame.deviation.toFixed(3)} · A {(frame.t_ms_a / 1000).toFixed(2)}s / B {(frame.t_ms_b / 1000).toFixed(2)}s
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                ) : <p className="text-xs text-zinc-500">无可解码关键帧（视频可能已过期）。</p>}
                {report.phase_offsets.length ? (
                  <ul className="space-y-1">
                    {report.phase_offsets.map((item) => (
                      <li key={item.phase}>
                        {item.phase}：B {item.delta_frames >= 0 ? "晚" : "早"} {Math.abs(item.delta_frames)} 帧（{item.delta_ms >= 0 ? "+" : ""}{item.delta_ms}ms）
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="flex items-center justify-between border-t border-black/[.08] pt-3 dark:border-white/[.145]">
                  <input readOnly value={typeof window !== "undefined" ? window.location.href : ""} className="h-9 w-2/3 rounded-lg border border-black/[.12] bg-transparent px-2 text-xs dark:border-white/[.2]" onFocus={(e) => e.target.select()} />
                  <div className="flex gap-2">
                    <button type="button" onClick={exportReport} disabled={reporting} className="h-9 rounded-full border border-black/[.08] px-4 dark:border-white/[.145]">重新生成</button>
                    <button type="button" onClick={() => setReportDialog(false)} className="h-9 rounded-full bg-foreground px-4 text-background">关闭</button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
