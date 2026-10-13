"use client";

import { useState } from "react";
import Link from "next/link";
import { useAnalysis } from "@/lib/use-analysis";
import AnalysisEntryNav from "@/app/components/analysis-entry-nav";
import HomeCourtClipSelector, { type HomeCourtSelection } from "./clip-selector";

export default function HomeCourtPage() {
  const [selection, setSelection] = useState<HomeCourtSelection | null>(null);
  const { analyze, submitting, message } = useAnalysis();
  return (
    <div className="page-shell page-shell-narrow space-y-6">
      <div>
        <p className="eyebrow">From practice to evidence</p>
        <h1 className="page-title mt-2">Import a HomeCourt shot</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--muted)]">Export your HomeCourt video to this device, then select one complete shot. Compare it with the Curry reference or review your own shots filmed from the same camera position.</p>
      </div>
      <AnalysisEntryNav />
      <ol className="grid gap-3 text-sm sm:grid-cols-3">{["Export your practice video", "Select one shot and the shooter", "Review the shot evidence"].map((label, index) => <li key={label} className="flex items-center gap-3 rounded-xl bg-[var(--accent-soft)] p-4"><span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--surface)] text-xs font-semibold text-[var(--accent)]">0{index + 1}</span>{label}</li>)}</ol>
      <div className="surface p-5 sm:p-7"><HomeCourtClipSelector disabled={submitting} onSelect={setSelection} /></div>
      <button disabled={!selection || submitting} onClick={() => selection && void analyze(selection.file, selection.source)}
        className="button-primary w-full sm:w-fit">
        {submitting ? "Analyzing…" : "Analyze selected shot"}
      </button>
      {message ? <p role="status" className="text-sm text-[var(--muted)]">{message}</p> : null}
      <div className="surface flex flex-wrap items-center justify-between gap-4 p-5"><div><h2 className="font-semibold">Keep your practice connected</h2><p className="mt-2 text-sm text-[var(--muted)]">Practice a set, save your shot outcomes, then choose one shot to review.</p></div><div className="flex flex-wrap gap-3"><Link href="/drills" className="button-secondary">Choose a drill</Link><Link href="/compare/new?source=homecourt" className="button-secondary">Compare your own shots →</Link></div></div>
    </div>
  );
}
