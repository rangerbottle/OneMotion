"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { getDrill, type Drill, workoutPlans } from "@/lib/drills";
import { accuracyLabel, durationLabel, saveTraining, type TrainingSession } from "@/lib/training-api";
import { addShot, createDraft, DRAFT_KEY, MAX_DRAFT_AGE_MS, parseDraft, trainingInput, undoShot, type TrainingDraft } from "@/lib/training-draft";
import CourtDiagram from "../components/court-diagram";

type Props = { drill: Drill; plan: (typeof workoutPlans)[number] | null; step: number };
export default function TrainingRunner({ drill, plan, step }: Props) {
  const [draft, setDraft] = useState<TrainingDraft | null>(null);
  const draftRef = useRef<TrainingDraft | null>(null);
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [otherTab, setOtherTab] = useState(false);
  const [brokenDraft, setBrokenDraft] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<TrainingSession | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (raw) {
          const recovered = parseDraft(raw);
          draftRef.current = recovered;
          setDraft(recovered);
          setMessage("Your unsaved session has been restored. Elapsed time includes rests and time away from this page.");
        }
      } catch {
        setBrokenDraft(true);
        setStorageWarning("The draft could not be read. Export the original draft to keep your results before starting a new session.");
      }
      setNow(Date.now());
      setReady(true);
    });
    const interval = setInterval(() => setNow(Date.now()), 1000);
    const onStorage = (event: StorageEvent) => {
      if (event.key === DRAFT_KEY) { setOtherTab(true); setMessage("Another tab changed the training draft. Reload before continuing to avoid overwriting results."); }
    };
    window.addEventListener("storage", onStorage);
    return () => { active = false; clearInterval(interval); window.removeEventListener("storage", onStorage); controller.current?.abort(); };
  }, []);

  function write(next: TrainingDraft, replace = false): boolean {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      const previous = draftRef.current;
      if (!replace && raw !== (previous ? JSON.stringify(previous) : null)) {
        setOtherTab(true);
        setMessage("Another tab updated the draft. Reload before continuing to avoid overwriting results.");
        return false;
      }
      localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
      setStorageWarning(null);
    } catch { setStorageWarning("This browser could not save the draft. Save the session to your history before leaving to keep your results."); }
    draftRef.current = next;
    setDraft(next);
    return true;
  }
  function start() {
    if (controller.current || otherTab) return;
    const next = createDraft(drill, plan ? { planId: plan.id, planStep: step } : undefined);
    if (write(next, brokenDraft || draftRef.current !== null)) {
      setSaved(null); setBrokenDraft(false); setMessage(null); setNow(Date.now());
    }
  }
  function shot(made: boolean) {
    const current = draftRef.current;
    if (!current || controller.current || otherTab) return;
    const next = addShot(current, made);
    if (next !== current && write(next)) setMessage(null);
  }
  function undo() {
    const current = draftRef.current;
    if (current && !controller.current && !otherTab) write(undoShot(current));
  }
  function skipRest() {
    const current = draftRef.current;
    if (current && !current.pending && !otherTab) write({ ...current, restUntil: null, revision: current.revision + 1 });
  }
  async function finish() {
    const current = draftRef.current;
    if (!current || controller.current || otherTab) return;
    if (!current.sets.some(set => set.length)) return;
    const frozen = current.pending ? current : { ...current, pending: trainingInput(current), revision: current.revision + 1 };
    if (!write(frozen)) return;
    const abort = new AbortController();
    controller.current = abort; setSaving(true); setMessage("Saving your session…");
    try {
      const result = await saveTraining(frozen.pending!, abort.signal);
      if (abort.signal.aborted) return;
      setSaved(result); setMessage(null);
      // A second tab can start a new session while this network request runs.
      // Only clear the draft that this exact save owns.
      try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (raw === JSON.stringify(frozen)) localStorage.removeItem(DRAFT_KEY);
        else if (raw) {
          setOtherTab(true);
          setMessage("Session saved. The draft updated in another tab has been kept; reload to continue.");
        }
      } catch { setStorageWarning("Session saved, but the local draft could not be cleared. Retrying will not duplicate the session."); }
      draftRef.current = null; setDraft(null);
    } catch (error) {
      if (!abort.signal.aborted) setMessage(`Save failed: ${error instanceof TypeError ? "could not connect to the service" : error instanceof Error ? error.message : "please try again"}. These results are locked; retrying will not duplicate the session.`);
    } finally {
      controller.current = null;
      if (!abort.signal.aborted) setSaving(false);
    }
  }
  function exportDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) { setMessage("There is no draft to export."); return; }
      const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "onemotion-training-draft.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setMessage("This browser could not read the draft. Keep this page open."); }
  }

  const mismatched = draft !== null && (draft.drillId !== drill.id || (draft.planId ?? null) !== (plan?.id ?? null) || (draft.planStep ?? 0) !== step);
  const resumeHref = draft?.planId ? `/training?plan=${draft.planId}&step=${draft.planStep}` : `/training?drill=${draft?.drillId}`;
  const attempts = draft?.sets.reduce((sum, set) => sum + set.length, 0) ?? 0;
  const makes = draft?.sets.reduce((sum, set) => sum + set.filter(Boolean).length, 0) ?? 0;
  const complete = draft?.sets.every(set => set.length === drill.reps) ?? false;
  const currentSet = draft ? Math.max(0, draft.sets.findIndex(set => set.length < drill.reps)) : 0;
  const restSeconds = Math.max(0, Math.ceil(((draft?.restUntil ?? 0) - now) / 1000));
  const expired = draft !== null && !draft.pending && now - Date.parse(draft.startedAt) > MAX_DRAFT_AGE_MS;
  const locked = saving || otherTab || !!draft?.pending || expired;
  const nextStep = plan && step + 1 < plan.drillIds.length ? step + 1 : null;

  return <div className="page-shell max-w-5xl">
    <Link href={`/drills/${drill.id}`} className="inline-flex min-h-11 items-center text-sm text-[var(--muted)]">← Drill instructions</Link>
    <div className="mt-6 flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow">{plan ? `${plan.title} / ${step + 1} of ${plan.drillIds.length}` : "Shooting session"}</p><h1 className="page-title mt-2">{drill.title}</h1><p className="mt-2 text-sm text-[var(--muted)]">{drill.sets} sets × {drill.reps} attempts · Rest between sets {drill.restSeconds} seconds · Record makes and misses manually</p></div><Link href="/progress" className="button-secondary">Training history</Link></div>
    {message ? <p role="status" className="mt-5 rounded-xl bg-[var(--accent-soft)] p-4 text-sm leading-6">{message}</p> : null}
    {storageWarning ? <p role="alert" className="mt-4 text-sm text-[var(--accent)]">{storageWarning}</p> : null}
    {otherTab ? <button className="button-secondary mt-4" onClick={() => window.location.reload()}>Reload session</button> : null}
    {!ready ? <p className="mt-10 text-[var(--muted)]">Loading your draft…</p> : saved ? <section className="surface mt-7 p-6 sm:p-9"><p className="eyebrow">Session saved</p><h2 className="mt-3 text-2xl font-semibold">{saved.status === "completed" ? "Session complete." : "Session saved. Keep your own pace."}</h2><p className="mt-4 text-lg tabular-nums">{saved.totals.makes} / {saved.totals.attempts} made · {accuracyLabel(saved.totals.makes, saved.totals.attempts)}</p><p className="mt-3 text-sm text-[var(--muted)]">These results were recorded manually. Import a video next to review changes in your shooting motion.</p><div className="mt-6 flex flex-wrap gap-3">{nextStep !== null && saved.status === "completed" ? <Link href={`/training?plan=${plan!.id}&step=${nextStep}`} className="button-primary">Next: {getDrill(plan!.drillIds[nextStep])!.title} →</Link> : <Link href="/progress" className="button-primary">View training history →</Link>}<Link href="/homecourt" className="button-secondary">Import a training video</Link><button onClick={start} className="button-secondary" disabled={otherTab}>Practice again</button></div></section> : mismatched ? <section className="surface mt-7 p-6"><h2 className="text-lg font-semibold">You have a session to resume</h2><p className="mt-3 text-sm text-[var(--muted)]">{getDrill(draft.drillId)?.title} · {attempts} attempts recorded. Starting another drill will replace this draft.</p><div className="mt-5 flex flex-wrap gap-3"><Link href={resumeHref} className="button-primary">Resume your session</Link><button onClick={exportDraft} className="button-secondary">Export draft</button><button onClick={start} disabled={otherTab} className="button-secondary">Discard draft and start a new session</button></div></section> : !draft ? <section className="surface mt-7 grid items-center gap-6 p-6 sm:grid-cols-2 sm:p-9"><div><h2 className="text-xl font-semibold">Set your feet. Find a comfortable release.</h2><p className="mt-4 text-sm leading-7 text-[var(--muted)]">{drill.description}</p><ul className="mt-4 space-y-2 text-sm">{drill.cues.slice(0, 2).map(cue => <li key={cue}>• {cue}</li>)}</ul><button onClick={start} disabled={otherTab} className="button-primary mt-6">{brokenDraft ? "Replace unreadable draft and start" : "Start recording"}</button>{brokenDraft ? <button onClick={exportDraft} className="button-secondary ml-3 mt-3">Export draft</button> : null}</div><CourtDiagram spots={drill.spots} route={drill.route} /></section> : <div className="mt-7 grid gap-5 lg:grid-cols-[1.45fr_1fr]">
      <section className="surface p-6 sm:p-8" aria-label="Shot recorder">
        <div className="flex items-center justify-between text-sm text-[var(--muted)]"><span>{complete ? "All sets complete" : `Set ${currentSet + 1} / ${drill.sets}`}</span><span className="tabular-nums">Elapsed {durationLabel((draft.pending ? Date.parse(draft.pending.completed_at) : now) - Date.parse(draft.startedAt))}</span></div>
        <div className="mt-6 flex items-baseline gap-2"><span className="text-6xl font-semibold tabular-nums tracking-tight">{complete ? drill.reps : draft.sets[currentSet].length}</span><span className="text-xl text-[var(--muted)]">/ {drill.reps} attempts</span></div>
        <div className="mt-5 flex flex-wrap gap-2" aria-label="Shot results for the current set">{Array.from({ length: drill.reps }, (_, i) => { const outcome = draft.sets[complete ? drill.sets - 1 : currentSet][i]; return <span key={i} title={`${i + 1}: ${outcome === undefined ? "Not recorded" : outcome ? "Made" : "Missed"}`} className={`flex size-8 items-center justify-center rounded-full text-xs ${outcome === undefined ? "bg-[var(--background)] text-[var(--muted)]" : outcome ? "bg-[var(--foreground)] text-[var(--background)]" : "bg-[var(--accent-soft)] text-[var(--accent)]"}`}>{outcome === undefined ? i + 1 : outcome ? "✓" : "−"}</span>; })}</div>
        {restSeconds > 0 && !draft.pending ? <div className="mt-6 rounded-2xl bg-[var(--accent-soft)] p-5"><p className="font-medium">Rest between sets · {restSeconds} seconds</p><p className="mt-2 text-sm text-[var(--muted)]">Relax your arms and reset your stance for the next set.</p><button onClick={skipRest} disabled={locked} className="button-secondary mt-4">Skip rest</button></div> : null}
        {expired ? <p role="alert" className="mt-5 text-sm text-[var(--accent)]">This draft is over 7 days old. Export your shot results before starting a new session.</p> : null}
        <div className="mt-6 grid grid-cols-2 gap-3"><button aria-label="Made" onClick={() => shot(true)} disabled={locked || complete || restSeconds > 0} className="min-h-20 rounded-2xl bg-[var(--foreground)] text-lg font-semibold text-[var(--background)] disabled:opacity-40">✓ Made</button><button aria-label="Missed" onClick={() => shot(false)} disabled={locked || complete || restSeconds > 0} className="min-h-20 rounded-2xl border border-[var(--border)] bg-[var(--background)] text-lg font-semibold disabled:opacity-40">− Missed</button></div>
        <button onClick={undo} disabled={locked || attempts === 0} className="mt-3 min-h-11 w-full text-sm text-[var(--muted)] disabled:opacity-40">↶ Undo last shot</button>
        <div className="mt-5 flex justify-between border-t border-[var(--border)] pt-5 text-sm"><span>Session {makes} / {attempts} made</span><span className="tabular-nums">Accuracy {accuracyLabel(makes, attempts)}</span></div>
        <button onClick={() => void finish()} disabled={saving || otherTab || attempts === 0 || expired} className="button-primary mt-6 w-full">{saving ? "Saving…" : draft.pending ? "Retry save" : complete ? "Save session" : "Finish and save"}</button>
        {expired ? <div className="mt-4 flex flex-wrap gap-3"><button onClick={exportDraft} className="button-secondary">Export draft</button><button onClick={start} disabled={otherTab} className="button-secondary">Discard draft and start a new session</button></div> : null}
      </section>
      <aside className="space-y-5"><section className="surface p-6"><p className="eyebrow">One cue at a time</p><h2 className="mt-2 font-semibold">Focus for this set</h2><p className="mt-4 text-sm leading-7">{drill.cues[currentSet % drill.cues.length]}</p><ol className="mt-5 space-y-2 text-sm text-[var(--muted)]">{draft.sets.map((set, index) => <li key={index} className="flex justify-between"><span>Set {index + 1}</span><span className="tabular-nums">{set.filter(Boolean).length} / {set.length} made {set.length === drill.reps ? "✓" : ""}</span></li>)}</ol></section><div className="px-2 text-xs leading-6 text-[var(--muted)]">Shot results are kept in this browser. Save the session to add it to local training history. Accuracy comes from your manual entries, not video detection.</div></aside>
    </div>}
  </div>;
}
