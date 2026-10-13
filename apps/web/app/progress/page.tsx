"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { drills, getDrill } from "@/lib/drills";
import { accuracyLabel, durationLabel, getTrainingHistory, type TrainingHistory } from "@/lib/training-api";

export default function ProgressPage() {
  const [history, setHistory] = useState<TrainingHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState("all");
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) { setLoading(true); setError(null); } });
    getTrainingHistory(controller.signal).then(next => {
      if (!controller.signal.aborted) setHistory(next);
    }).catch(err => {
      if (!controller.signal.aborted) setError(err instanceof TypeError ? "Could not connect to the training service. Check your connection and try again." : err instanceof Error ? err.message : "Training history is temporarily unavailable.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  const sessions = history?.sessions.filter(session => filter === "all" || session.drill_id === filter) ?? [];
  const recent = sessions.slice(0, 12).reverse();
  const summary = history?.summary;
  return <div className="page-shell space-y-7">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow">Your practice journal</p><h1 className="page-title mt-2">Training history</h1><p className="mt-3 text-sm text-[var(--muted)]">Keep a record of every session. Statistics come from the makes and misses you enter manually.</p></div><Link href="/drills" className="button-primary">Find a drill →</Link></div>
    {error ? <div role="alert" className="surface flex flex-wrap items-center justify-between gap-4 p-5"><p className="text-sm">{error}{history ? " Previously loaded records are shown below." : ""}</p><button onClick={() => setReload(value => value + 1)} disabled={loading} className="button-secondary">Retry loading</button></div> : null}
    {loading && !history ? <p role="status" className="text-[var(--muted)]">Loading training history…</p> : null}
    {summary ? <section aria-label="All saved training statistics" className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[{ label: "Saved sessions", value: summary.sessions, note: `${summary.completed_sessions} ${summary.completed_sessions === 1 ? "session" : "sessions"} completed all sets` }, { label: "Total attempts", value: summary.attempts, note: "Includes makes and misses" }, { label: "Total makes", value: summary.makes, note: "Calculated from your shot results" }, { label: "Accuracy", value: accuracyLabel(summary.makes, summary.attempts), note: `${summary.makes} / ${summary.attempts}, weighted by attempts` }].map(item => <div className="surface p-5" key={item.label}><p className="text-sm text-[var(--muted)]">{item.label}</p><p className="mt-3 text-3xl font-semibold tabular-nums">{item.value}</p><p className="mt-2 text-xs leading-5 text-[var(--muted)]">{item.note}</p></div>)}</section> : null}
    {history && history.summary.sessions === 0 ? <section className="surface py-14 text-center"><p className="eyebrow">Your first session starts here</p><h2 className="mt-3 text-2xl font-semibold">No training history yet</h2><p className="mx-auto mt-3 max-w-md px-4 text-sm leading-6 text-[var(--muted)]">Start with close-range form. Record each shot and save the session to find it here.</p><Link href="/training?drill=close-form" className="button-primary mt-6">Start your first session</Link></section> : history && <>
      <section className="surface p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="text-xl font-semibold">Recent sessions</h2><p className="mt-2 text-xs text-[var(--muted)]">Accuracy for each session. Distance and drill type affect results; filter by one drill for a clearer comparison.</p></div><label className="flex items-center gap-2 text-sm">Drill<select value={filter} onChange={event => setFilter(event.target.value)} className="min-h-11 max-w-[12rem] rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3"><option value="all">All drills</option>{drills.map(drill => <option key={drill.id} value={drill.id}>{drill.title}</option>)}</select></label></div>
        {recent.length ? <div aria-label="Manual shooting accuracy for recent sessions" className="mt-7 flex h-44 items-end gap-2 border-b border-[var(--border)] pb-3 sm:gap-4">{recent.map((session, index) => <div key={session.session_id} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2"><span className="text-xs tabular-nums text-[var(--muted)]">{accuracyLabel(session.totals.makes, session.totals.attempts)}</span><div className="w-full max-w-14 rounded-t-md bg-[var(--accent)]" style={{ height: `${(session.totals.accuracy_pct ?? 0) * 1.15}px`, minHeight: "2px", opacity: session.totals.accuracy_pct === null ? 0 : 1 }} title={`${getDrill(session.drill_id)?.title}: ${session.totals.makes}/${session.totals.attempts}`} /><span className="text-[10px] tabular-nums text-[var(--muted)]">{index + 1}</span></div>)}</div> : <p className="mt-7 text-sm text-[var(--muted)]">No saved sessions for this drill yet.</p>}
        {history.has_more ? <p className="mt-4 text-xs text-[var(--muted)]">Filters and charts show the latest 100 sessions. The totals above include all saved sessions.</p> : null}
      </section>
      <section><h2 className="mb-4 text-xl font-semibold">Session history</h2><div className="space-y-3">{sessions.map(session => { const drill = getDrill(session.drill_id); return <article key={session.session_id} className="surface flex flex-wrap items-center justify-between gap-4 p-5"><div className="min-w-0"><div className="flex flex-wrap items-center gap-3"><h3 className="font-semibold">{drill?.title ?? session.drill_id}</h3><span className="rounded-full bg-[var(--background)] px-2 py-1 text-xs text-[var(--muted)]">{session.status === "completed" ? "Completed" : "Finished early"}</span></div><p className="mt-2 text-xs leading-6 text-[var(--muted)]">{new Date(session.completed_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {session.totals.completed_sets} / {session.planned_sets} sets completed · Elapsed {durationLabel(session.totals.duration_ms)} (including rests)</p></div><div className="flex items-center gap-5"><div className="text-right"><p className="font-semibold tabular-nums">{accuracyLabel(session.totals.makes, session.totals.attempts)}</p><p className="mt-1 text-xs text-[var(--muted)]">{session.totals.makes} / {session.totals.attempts} made</p></div><Link href={`/training?drill=${session.drill_id}`} className="button-secondary">Practice again</Link></div></article>; })}</div></section>
    </>}
    <section className="rounded-2xl bg-[var(--accent-soft)] p-6"><h2 className="font-semibold">Review your motion alongside your results.</h2><p className="mt-2 text-sm leading-6 text-[var(--muted)]">Keep videos from the same shooting spot and camera position to compare your earlier and later shots.</p><Link href="/compare/new?source=homecourt" className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-[var(--accent)]">Import two HomeCourt videos →</Link></section>
  </div>;
}
