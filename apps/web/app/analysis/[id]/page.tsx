import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getAnalysis,
  type AnalysisResult,
  type MetricValue,
  type PhaseSegment,
  type ShotRating,
} from "@/lib/api";
import SkeletonReplay from "./skeleton-replay";
import SourceVideo from "@/app/components/reference-source-video";
import ReferenceLibraryEntry from "@/app/components/reference-library-entry";
import MediaSourceDetails from "@/app/components/media-source-details";
import { recommendDrills } from "@/lib/drills";

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
  if (score === null) return "text-[var(--muted)]";
  if (score >= 80) return "text-emerald-500";
  if (score >= 60) return "text-amber-500";
  return "text-red-500";
}

function Score({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-xl border border-[var(--border)] px-5 py-4 text-center">
      <div className={`text-4xl font-bold tabular-nums ${scoreColor(value)}`}>
        {value === null ? "—" : value.toFixed(0)}
      </div>
      <div className="mt-1 text-xs uppercase tracking-wide text-[var(--muted)]">{label}</div>
    </div>
  );
}

const RATING_META: Record<string, { label: string; color: string }> = {
  early: { label: "Early release", color: "#eab308" },
  perfect: { label: "Perfect release", color: "#22c55e" },
  late: { label: "Late release", color: "#ef4444" },
};

function ShotMeter({ rating }: { rating: ShotRating | null | undefined }) {
  if (!rating) return null;
  if (!rating.reliable || rating.verdict === null || rating.timing_delta_ms === null) {
    return (
      <div className="rounded-xl border border-[var(--border)] px-5 py-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-[var(--muted)]">Release timing</span>
          <span className="text-xs text-[var(--muted)]">Not rated</span>
        </div>
        {/* Greyed-out meter keeps the feature discoverable on unrated clips. */}
        <div className="relative h-3 rounded-full bg-[var(--border)] opacity-60" aria-hidden="true">
          <div className="absolute -top-1.5 left-1/2 h-6 w-1.5 -translate-x-1/2 rounded-full bg-[var(--muted)] opacity-40" />
        </div>
        <p className="mt-2 text-xs text-[var(--muted)]">
          Release timing unavailable{rating.reason ? `: ${rating.reason}` : " (insufficient evidence)"}
        </p>
      </div>
    );
  }
  const meta = RATING_META[rating.verdict];
  // Map ±300 ms onto the bar; the green band marks the ±60 ms perfect window.
  const clamped = Math.min(Math.max(rating.timing_delta_ms, -300), 300);
  const pos = 50 + (clamped / 300) * 50;
  return (
    <div className="rounded-xl border border-[var(--border)] px-5 py-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-[var(--muted)]">Release timing</span>
        <span className="text-sm font-semibold" style={{ color: meta.color }}>{meta.label}</span>
      </div>
      <div className="relative h-3 overflow-visible rounded-full"
        role="img"
        aria-label={`release timing ${meta.label} ${rating.timing_delta_ms}ms`}
        style={{ background: "linear-gradient(to right, #eab308 0%, #facc15 32%, #22c55e 40%, #22c55e 60%, #facc15 68%, #ef4444 100%)" }}>
        <div
          className="absolute -top-1.5 h-6 w-1.5 -translate-x-1/2 rounded-full bg-foreground shadow"
          style={{ left: `${pos}%` }}
        />
      </div>
      <div className="mt-2 flex justify-between text-xs text-[var(--muted)]">
        <span>Early</span>
        <span className="tabular-nums">
          {rating.timing_delta_ms === 0
            ? "Released exactly at the jump apex"
            : `Released ${Math.abs(rating.timing_delta_ms)}ms ${rating.timing_delta_ms > 0 ? "after" : "before"} the jump apex`}
          {" "}· {(rating.confidence * 100).toFixed(0)}% confidence
        </span>
        <span>Late</span>
      </div>
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
  if (response.status === 410) return <div className="page-shell page-shell-narrow space-y-4">
    <h1 className="text-xl font-semibold">This analysis is no longer available</h1>
    <p>Its source data has expired. Upload a new shot to create another report.</p>
    <a href="/upload" className="underline">Upload a new shot</a>
  </div>;
  if (!response.ok) throw new Error(`analysis fetch failed: ${response.status}`);
  const result: AnalysisResult = await response.json();
  const t0 = result.phases[0]?.start_ms ?? 0;
  const t1 = result.phases.at(-1)?.end_ms ?? 1;
  const total = Math.max(t1 - t0, 1);
  const playerTimingReliable = !result.source || result.source.timing_mode === "realtime";
  const suggestedDrills = recommendDrills(result);

  return (
    <div className="page-shell flex flex-1 flex-col gap-10">
      <header><p className="eyebrow">Analyze / Report</p><h1 className="page-title mt-2">Shot analysis</h1></header>
      <section className="flex flex-col gap-5">
        <div className="rounded-xl bg-[var(--surface-muted)] p-4 text-sm text-[var(--muted-strong)]">
          <p className="font-medium">{result.template_name ?? result.benchmark_version}</p>
          <p className="mt-1">
            {result.timing_reliable
              ? playerTimingReliable
                ? "Form and timing use the selected real-time reference."
                : "The reference is real time; timing comparison is unavailable because the source speed is unknown or slowed."
              : "Timing comparison is unavailable because reference playback speed is not verified as real time."}
            {" "}Reference measurements describe the selected footage, not a population confidence interval.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Score label="Overall" value={result.similarity_score} />
          <Score label="Form" value={result.form_score} />
          <Score label="Timing" value={result.timing_score} />
        </div>
        <ShotMeter rating={result.shot_rating ?? null} />
        {result.quality ? (
          <div className="text-center text-sm text-[var(--muted)]">
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
              <p key={item} className="mt-1 text-[var(--muted-strong)]">{item}</p>
            ))}
          </div>
        ) : null}
      </section>

      <MediaSourceDetails source={result.source} />

      <SkeletonReplay analysisId={id} />
      {result.template_source_video_url ? <SourceVideo path={result.template_source_video_url} timingReliable={result.timing_reliable} /> : null}

      <ReferenceLibraryEntry analysisId={id} />

      <section>
        <h2 className="mb-3 text-lg font-semibold">Fix these first</h2>
        {result.feedback.length === 0 ? (
          <p className="text-[var(--muted)]">
            No correction cleared the evidence threshold. Review the metric confidence below.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {result.feedback.map((item) => (
              <li key={item.rank} className="rounded-xl border border-[var(--border)] p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-[var(--muted)]">
                  <span>#{item.rank}</span>
                  {item.phase ? <span>· {item.phase.replace("_", " ")}</span> : null}
                  <span>· {(item.confidence * 100).toFixed(0)}% evidence</span>
                  {item.benchmark_sample_count ? <span>· Curry n={item.benchmark_sample_count}</span> : null}
                </div>
                <p className="mt-1 font-medium">{item.message}</p>
                <p className="mt-1 text-sm text-[var(--muted)]">Drill: {item.cue}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="surface p-6">
        <p className="eyebrow">Take it back to the court</p>
        <h2 className="mt-2 text-xl font-semibold">Your next workout</h2>
        {suggestedDrills.length ? <>
          <p className="mt-2 text-sm text-[var(--muted)]">These drills follow feedback that cleared the evidence threshold. Practice at a comfortable pace, then record another shot.</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">{suggestedDrills.map(drill => <Link key={drill.id} href={`/drills/${drill.id}`} className="rounded-xl border border-[var(--border)] p-4 hover:border-[var(--accent)]">
            <h3 className="font-semibold">{drill.title}</h3><p className="mt-2 text-xs leading-5 text-[var(--muted)]">{drill.sets} sets × {drill.reps} shots · About {drill.minutes} min</p><span className="mt-4 inline-block text-sm text-[var(--accent)]">View drill →</span>
          </Link>)}</div>
        </> : <p className="mt-3 text-sm leading-6 text-[var(--muted)]">There is not enough reliable feedback to recommend a specific drill. Improve your camera setup, or choose a foundation drill from the <Link href="/drills" className="text-[var(--accent)] underline">training library</Link>.</p>}
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
              <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
                <th className="py-2 font-medium">Phase</th>
                <th className="py-2 font-medium">{playerTimingReliable ? "You" : "You (video time)"}</th>
                <th className="py-2 font-medium">Curry</th>
                <th className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {result.phases.map((phase) => {
                const curry = result.benchmark_phases?.find((item) => item.phase === phase.phase);
                return (
                  <tr key={phase.phase} className="border-b border-[var(--border)]">
                    <td className="py-2 capitalize">{phase.phase.replace("_", " ")}</td>
                    <td className="py-2 tabular-nums">{phaseDuration(phase)}</td>
                    <td className="py-2 tabular-nums">{phaseDuration(curry)}</td>
                    <td className="py-2 text-xs text-[var(--muted)]">
                      {phase.censored ? "clip-ended" : phase.degraded ? "low confidence" : "tracked"}
                      {!result.timing_reliable ? " · reference only" : ""}
                      {!playerTimingReliable ? " · source speed unknown or slowed" : ""}
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
              <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
                <th className="py-2 font-medium">Metric</th>
                <th className="py-2 font-medium">You</th>
                <th className="py-2 font-medium">Curry v3 reference</th>
                <th className="py-2 font-medium">Δ</th>
                <th className="py-2 font-medium">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {result.metrics.map((metric) => (
                <tr key={metric.name} className={`border-b border-[var(--border)] ${metric.reliable ? "" : "text-[var(--muted)]"}`}>
                  <td className="py-2">
                    {METRIC_META[metric.name]?.label ?? metric.name}
                    <span className="ml-1 text-xs text-[var(--muted)]">{metric.category}</span>
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

      <div className="flex flex-wrap gap-3">
        <Link href="/analyze" className="button-primary">Analyze another shot</Link>
        <Link href="/" className="button-secondary">Dashboard</Link>
      </div>
    </div>
  );
}
