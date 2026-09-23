"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ComparisonMetrics } from "@/lib/compare-api";

const COLOR_A = "#3b82f6";
const COLOR_B = "#f97316";

const TABS = [
  { id: "angles", label: "关节角度", ready: true },
  { id: "velocity", label: "速度", ready: false },
  { id: "displacement", label: "位移", ready: false },
] as const;

const ANGLE_LABELS: Record<string, string> = {
  left_elbow_deg: "左肘",
  right_elbow_deg: "右肘",
  left_knee_deg: "左膝",
  right_knee_deg: "右膝",
};

const PAD = { left: 40, right: 12, top: 10, bottom: 22 };

export default function MetricsPanel({
  metrics,
  currentAlignedMs,
  offsetMsA,
  offsetMsB,
  durationMs,
  onSeek,
}: {
  metrics: ComparisonMetrics;
  currentAlignedMs: number;
  offsetMsA: number;
  offsetMsB: number;
  durationMs: number;
  onSeek: (alignedMs: number) => void;
}) {
  const [tab, setTab] = useState<string>("angles");
  const [seriesKey, setSeriesKey] = useState<string>("right_elbow_deg");
  const canvas = useRef<HTMLCanvasElement>(null);
  const hover = useRef<number | null>(null);

  const draw = useCallback(() => {
    const el = canvas.current;
    if (!el || tab !== "angles") return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const { width, height } = el;
    ctx.clearRect(0, 0, width, height);
    const seriesA = metrics.a[seriesKey] ?? [];
    const seriesB = metrics.b[seriesKey] ?? [];
    if (!seriesA.length && !seriesB.length) {
      ctx.fillStyle = "#71717a";
      ctx.font = "13px system-ui";
      ctx.fillText("该曲线暂无数据", 12, 24);
      return;
    }
    const values = [...seriesA, ...seriesB].map((p) => p.value).filter((v): v is number => v !== null);
    if (!values.length) return;
    const pad = PAD;
    const yMin = Math.min(...values) - 5;
    const yMax = Math.max(...values) + 5;
    const x = (tMs: number, offset: number) =>
      pad.left + ((tMs - offset) / durationMs) * (width - pad.left - pad.right);
    const y = (v: number) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * (height - pad.top - pad.bottom);

    ctx.strokeStyle = "rgba(120,120,130,.35)";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#71717a";
    ctx.font = "10px system-ui";
    for (let i = 0; i <= 4; i += 1) {
      const v = yMin + ((yMax - yMin) * i) / 4;
      const yy = y(v);
      ctx.beginPath();
      ctx.moveTo(pad.left, yy);
      ctx.lineTo(width - pad.right, yy);
      ctx.stroke();
      ctx.fillText(`${v.toFixed(0)}°`, 4, yy + 3);
    }

    const line = (series: typeof seriesA, offset: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let pen = false;
      for (const point of series) {
        const aligned = point.t_ms - offset;
        if (aligned < 0 || aligned > durationMs) continue;
        if (point.value === null) {
          pen = false;
          continue;
        }
        const xx = x(point.t_ms, offset);
        const yy = y(point.value);
        if (pen) ctx.lineTo(xx, yy);
        else ctx.moveTo(xx, yy);
        pen = true;
      }
      ctx.stroke();
    };
    line(seriesA, offsetMsA, COLOR_A);
    line(seriesB, offsetMsB, COLOR_B);

    const aligned = hover.current ?? currentAlignedMs;
    const xx = pad.left + (aligned / durationMs) * (width - pad.left - pad.right);
    ctx.strokeStyle = "#ef4444";
    ctx.beginPath();
    ctx.moveTo(xx, pad.top);
    ctx.lineTo(xx, height - pad.bottom);
    ctx.stroke();
  }, [metrics, seriesKey, tab, currentAlignedMs, offsetMsA, offsetMsB, durationMs]);

  useEffect(() => {
    draw();
  }, [draw]);

  // CSS pixels → canvas pixels → plot-area ratio, matching draw()'s mapping.
  const pointerToAligned = (event: { clientX: number }) => {
    const el = canvas.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const cx = (event.clientX - rect.left) * (el.width / rect.width);
    const ratio = Math.min(
      Math.max((cx - PAD.left) / (el.width - PAD.left - PAD.right), 0),
      1,
    );
    return ratio * durationMs;
  };

  const onPointer = (event: React.PointerEvent) => {
    const aligned = pointerToAligned(event);
    if (aligned === null) return;
    hover.current = aligned;
    draw();
  };

  const onClick = (event: React.MouseEvent) => {
    const aligned = pointerToAligned(event);
    if (aligned !== null) onSeek(aligned);
  };

  return (
    <div className="rounded-2xl border border-black/[.08] p-3 dark:border-white/[.145]">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={!item.ready}
            onClick={() => setTab(item.id)}
            className={`rounded-full px-3 py-1 ${tab === item.id ? "bg-foreground text-background" : "bg-zinc-100 dark:bg-zinc-800"} disabled:opacity-40`}
          >{item.label}{item.ready ? "" : "（即将上线）"}</button>
        ))}
        {tab === "angles" ? (
          <select
            value={seriesKey}
            onChange={(e) => setSeriesKey(e.target.value)}
            className="ml-auto h-8 rounded-lg border border-black/[.12] bg-transparent px-2 text-sm dark:border-white/[.2]"
            aria-label="关节选择"
          >
            {Object.keys(ANGLE_LABELS).map((key) => (
              <option key={key} value={key}>{ANGLE_LABELS[key]}</option>
            ))}
          </select>
        ) : null}
      </div>
      {tab === "angles" ? (
        <canvas
          ref={canvas}
          width={880}
          height={220}
          className="h-44 w-full cursor-crosshair"
          onPointerMove={onPointer}
          onPointerLeave={() => { hover.current = null; draw(); }}
          onClick={onClick}
        />
      ) : (
        <p className="py-8 text-center text-sm text-zinc-500">速度 / 位移分析即将上线</p>
      )}
      <p className="mt-1 flex gap-4 text-xs text-zinc-500">
        <span className="text-blue-500">— A · 基准</span>
        <span className="text-orange-500">— B · 对比</span>
        <span className="ml-auto">点击图表可定位到对应帧</span>
      </p>
    </div>
  );
}
