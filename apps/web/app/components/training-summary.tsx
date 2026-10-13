"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { accuracyLabel, getTrainingHistory, type TrainingSummary } from "@/lib/training-api";

export default function TrainingSummaryCard() {
  const [summary, setSummary] = useState<TrainingSummary | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getTrainingHistory(controller.signal).then(history => setSummary(history.summary)).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);
  return <section className="surface p-6">
    <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Your training so far</h2><Link href="/progress" className="text-sm text-[var(--accent)]">View history →</Link></div>
    {error ? <p className="mt-4 text-sm text-[var(--muted)]">History is temporarily unavailable. Open training history to try again.</p> : !summary ? <p className="mt-4 text-sm text-[var(--muted)]">Loading training history…</p> : <>
      <div className="mt-5 grid grid-cols-3 gap-2">
        {[{ label: "Saved sessions", value: summary.sessions }, { label: "Attempts", value: summary.attempts }, { label: "Accuracy", value: accuracyLabel(summary.makes, summary.attempts) }].map(item => <div key={item.label}><div className="text-2xl font-semibold tabular-nums">{item.value}</div><p className="mt-1 text-xs text-[var(--muted)]">{item.label}</p></div>)}
      </div><p className="mt-5 text-xs text-[var(--muted)]">{summary.sessions ? "Makes and attempts come from sessions you recorded and saved manually." : "No saved sessions yet. Start with a set of close-range form."}</p>
    </>}
  </section>;
}
