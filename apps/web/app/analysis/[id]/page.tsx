import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getAnalysis,
  type AnalysisResult,
  type MetricValue,
  type PhaseSegment,
} from "@/lib/api";
import SkeletonReplay from "./skeleton-replay";

const METRIC_META: Record<string, { label: string; unit: string; decimals: number }> = {
  release_angle_deg: { label: "Release angle (forearm)", unit: "°", decimals: 0 },
  release_height_ratio: { label: "Release height", unit: "× height", decimals: 2 },
  shot_tempo_s: { label: "Shot tempo (load → release)", unit: "s", decimals: 2 },
  knee_flexion_deg: { label: "Knee bend at load", unit: "°", decimals: 0 },
  elbow_angle_at_release_deg: { label: "Elbow at release", unit: "°", decimals: 0 },
  set_point_ratio: { label: "Set point height", unit: "× torso", decimals: 2 },
  hip_shoulder_offset_ratio: { label: "Body lean at release", unit: "× torso", decimals: 2 },
  follow_through_hold_s: { label: "Follow-through hold", unit: "s", decimals: 2 },
};

const PHASE_COLORS: Record<string, string> = {
  dip: "bg-sky-500",
  load: "bg-amber-500",
  lift: "bg-emerald-500",
  release: "bg-red-500",
  follow_through: "bg-violet-500",
};

function fmt(metric: MetricValue, value: number | null): string {
  if (value === null) return "—";
  const meta = METRIC_META[metric.name];
  const suffix = meta?.unit === "°" || meta?.unit === "s" ? meta.unit : "";
  return `${value.toFixed(meta?.decimals ?? 2)}${suffix}`;
}

function phaseDuration(phase: PhaseSegment | undefined): string {
  if (!phase) return "—";
  return `${((phase.end_ms - phase.start_ms) / 1000).toFixed(2)}s`;
}

function scoreColor(score: number | null): string {
  if (score === null) return "text-zinc-400";
  if (score >= 80) return "text-emerald-500";
  if (score >= 60) return "text-amber-500";
  return "text-red-500";
}

function Score({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-xl border border-black/[.08] px-5 py-4 text-center dark:border-white/[.145]">
      <div className={`text-4xl font-bold tabular-nums ${scoreColor(value)}`}>
        {value === null ? "—" : value.toFixed(0)}
      </div>
      <div className="mt-1 text-xs uppercase tracking-wide text-zinc-500">{label}</div>
    </div>
  );
}

export default async function AnalysisPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const response = await getAnalysis(id);
  if (response.status === 404) notFound();
  if (response.status === 410) return <div className="mx-auto max-w-xl space-y-4 px-6 py-12">
    <h1 className="text-xl font-semibold">This analysis is no longer available</h1>
    <p>Its source data has expired. Upload a new shot to create another report.</p>
    <a href="/upload" className="underline">Upload a new shot</a>
  </div>;
  if (!response.ok) throw new Error(`analysis fetch failed: ${response.status}`);
  const result: AnalysisResult = await response.json();
  const t0 = result.phases[0]?.start_ms ?? 0;
  const t1 = result.phases.at(-1)?.end_ms ?? 1;
  const total = Math.max(t1 - t0, 1);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-10 px-6 py-10">
      <section className="flex flex-col gap-5">
        <div className="rounded-xl bg-zinc-100 p-4 text-sm text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
          <p className="font-medium">{result.template_name ?? result.benchmark_version}</p>
          <p className="mt-1">
            {result.timing_reliable
              ? "Form and timing use the selected real-time reference."
              : "Timing comparison is unavailable because reference playback speed is not verified as real time."}
            {" "}Reference measurements describe the selected footage, not a population confidence interval.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Score label="Overall" value={result.similarity_score} />
          <Score label="Form" value={result.form_score} />
          <Score label="Timing" value={result.timing_score} />
        </div>
        {result.quality ? (
          <div className="text-center text-sm text-zinc-500">
            Evidence: {result.quality.valid_metrics}/{result.quality.expected_metrics} reliable metrics
            · {(result.quality.coverage * 100).toFixed(0)}% coverage · {result.quality.status}
          </div>
        ) : null}
        {result.capture_quality ? (
          <div className={`rounded-xl border p-4 text-sm ${
            result.capture_quality.status === "pass"
              ? "border-emerald-500/30 bg-emerald-500/[.06]"
              : result.capture_quality.status === "warn"
                ? "border-amber-500/30 bg-amber-500/[.06]"
                : "border-red-500/30 bg-red-500/[.06]"
          }`}>
            <p className="font-medium">
              Capture view: {result.capture_quality.status} · side-view likelihood {Math.round(result.capture_quality.side_view_score * 100)}%
            </p>
            {result.capture_quality.guidance.map((item) => (
              <p key={item} className="mt-1 text-zinc-600 dark:text-zinc-300">{item}</p>
            ))}
          </div>
        ) : null}
      </section>

      <SkeletonReplay analysisId={id} />

      <section>
        <h2 className="mb-3 text-lg font-semibold">Fix these first</h2>
        {result.feedback.length === 0 ? (
          <p className="text-zinc-600 dark:text-zinc-400">
            No correction cleared the evidence threshold. Review the metric confidence below.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {result.feedback.map((item) => (
              <li key={item.rank} className="rounded-xl border border-black/[.08] p-4 dark:border-white/[.145]">
                <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-zinc-500">
                  <span>#{item.rank}</span>
                  {item.phase ? <span>· {item.phase.replace("_", " ")}</span> : null}
                  <span>· {(item.confidence * 100).toFixed(0)}% evidence</span>
                  {item.benchmark_sample_count ? <span>· Curry n={item.benchmark_sample_count}</span> : null}
                </div>
                <p className="mt-1 font-medium">{item.message}</p>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Drill: {item.cue}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Your shot phases</h2>
        <div className="flex h-6 w-full overflow-hidden rounded-full">
          {result.phases.map((phase) => (
            <div
              key={phase.phase}
              className={`${PHASE_COLORS[phase.phase]} h-full`}
              style={{ width: `${Math.max(((phase.end_ms - phase.start_ms) / total) * 100, 2)}%` }}
              title={`${phase.phase}: ${(phase.start_ms / 1000).toFixed(2)}s–${(phase.end_ms / 1000).toFixed(2)}s`}
            />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Phase comparison</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/[.08] text-left text-zinc-500 dark:border-white/[.145]">
                <th className="py-2 font-medium">Phase</th>
                <th className="py-2 font-medium">You</th>
                <th className="py-2 font-medium">Curry</th>
                <th className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {result.phases.map((phase) => {
                const curry = result.benchmark_phases?.find((item) => item.phase === phase.phase);
                return (
                  <tr key={phase.phase} className="border-b border-black/[.05] dark:border-white/[.08]">
                    <td className="py-2 capitalize">{phase.phase.replace("_", " ")}</td>
                    <td className="py-2 tabular-nums">{phaseDuration(phase)}</td>
                    <td className="py-2 tabular-nums">{phaseDuration(curry)}</td>
                    <td className="py-2 text-xs text-zinc-500">
                      {phase.censored ? "clip-ended" : phase.degraded ? "low confidence" : "tracked"}
                      {!result.timing_reliable ? " · reference only" : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">You vs. Curry</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-black/[.08] text-left text-zinc-500 dark:border-white/[.145]">
                <th className="py-2 font-medium">Metric</th>
                <th className="py-2 font-medium">You</th>
                <th className="py-2 font-medium">Curry v3 reference</th>
                <th className="py-2 font-medium">Δ</th>
                <th className="py-2 font-medium">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {result.metrics.map((metric) => (
                <tr key={metric.name} className={`border-b border-black/[.05] dark:border-white/[.08] ${metric.reliable ? "" : "text-zinc-400"}`}>
                  <td className="py-2">
                    {METRIC_META[metric.name]?.label ?? metric.name}
                    <span className="ml-1 text-xs text-zinc-500">{metric.category}</span>
                  </td>
                  <td className="py-2 tabular-nums">{fmt(metric, metric.value)}</td>
                  <td className="py-2 tabular-nums">
                    {fmt(metric, metric.benchmark_median)}
                    {metric.benchmark_range && (metric.benchmark_sample_count ?? 0) > 1
                      ? ` (${fmt(metric, metric.benchmark_range[0])}–${fmt(metric, metric.benchmark_range[1])})`
                      : ""}
                    {metric.benchmark_sample_count ? ` · reference n=${metric.benchmark_sample_count}` : ""}
                  </td>
                  <td className="py-2 tabular-nums">
                    {metric.delta === null ? "—" : `${metric.delta > 0 ? "+" : ""}${fmt(metric, metric.delta)}`}
                  </td>
                  <td className="py-2">
                    {metric.reliable
                      ? `${(metric.confidence * 100).toFixed(0)}% conf · ${(metric.coverage * 100).toFixed(0)}% visible`
                      : metric.unavailable_reason ?? "unavailable"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex justify-center gap-4">
        <Link href="/record" className="h-12 rounded-full bg-foreground px-8 leading-[3rem] text-background">Shoot again</Link>
        <Link href="/" className="h-12 rounded-full border border-black/[.08] px-8 leading-[3rem] dark:border-white/[.145]">Home</Link>
      </div>
    </div>
  );
}
