import Link from "next/link";
import { notFound } from "next/navigation";
import CourtDiagram from "@/app/components/court-diagram";
import { categoryLabels, drills, getDrill, levelLabels } from "@/lib/drills";

export const dynamicParams = false;
export function generateStaticParams() {
  return drills.map((drill) => ({ id: drill.id }));
}

export default async function DrillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drill = getDrill(id);
  if (!drill) notFound();
  const related = drills.filter((item) => item.category === drill.category && item.id !== drill.id).slice(0, 2);
  return (
    <div className="page-shell space-y-8">
      <Link href="/drills" className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--muted)] hover:text-[var(--accent)]">← Back to drills</Link>
      <section aria-labelledby="drill-title" className="grid items-center gap-8 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-5">
          <p className="eyebrow">{categoryLabels[drill.category]} <span aria-hidden="true">/</span> {levelLabels[drill.level]}</p>
          <h1 id="drill-title" className="page-title">{drill.title}</h1>
          <p className="max-w-xl leading-7 text-[var(--muted)]">{drill.description}</p>
          <dl className="surface grid grid-cols-2 gap-y-5 p-5 sm:grid-cols-4">
            {[
              ["Estimated time", `About ${drill.minutes} min`], ["Sets", `${drill.sets} sets`],
              ["Attempts per set", `${drill.reps} attempts`], ["Rest between sets", `${drill.restSeconds} seconds`],
            ].map(([label, value]) => <div key={label}><dt className="text-xs text-[var(--muted)]">{label}</dt><dd className="mt-1 font-semibold">{value}</dd></div>)}
          </dl>
          <p className="text-xs text-[var(--muted)]">Count attempts, including makes and misses. Actual time depends on how quickly you retrieve the ball and reset.</p>
          <Link href={`/training?drill=${drill.id}`} className="button-primary w-full sm:w-auto">Start this drill <span aria-hidden="true">→</span></Link>
        </div>
        <div className="surface mx-auto w-full max-w-sm p-5 sm:p-7"><CourtDiagram spots={drill.spots} route={drill.route} title={drill.title} /></div>
      </section>

      <div className="grid items-start gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <section aria-labelledby="steps-title" className="surface p-6 sm:p-8">
          <p className="eyebrow">Step by step</p><h2 id="steps-title" className="mt-2 text-2xl font-semibold tracking-tight">How to practice</h2>
          <ol className="mt-6 space-y-6">{drill.steps.map((step, index) => <li key={step} className="flex gap-4">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-sm font-semibold text-[var(--accent)]">{index + 1}</span>
            <p className="pt-0.5 text-sm leading-7">{step}</p>
          </li>)}</ol>
        </section>
        <section aria-labelledby="cues-title" className="surface p-6 sm:p-8">
          <p className="eyebrow">One focus for today</p><h2 id="cues-title" className="mt-2 text-xl font-semibold">Keep in mind</h2>
          <ul className="mt-5 space-y-4">{drill.cues.map((cue) => <li key={cue} className="flex gap-3 text-sm leading-7">
            <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-[var(--accent)]" />{cue}
          </li>)}</ul>
        </section>
      </div>

      <section aria-labelledby="capture-title" className="surface flex flex-col gap-5 p-6 sm:p-8">
        <div><p className="eyebrow">Keep a record</p><h2 id="capture-title" className="mt-2 text-2xl font-semibold tracking-tight">Record a shot for review</h2></div>
        <ul className="max-w-3xl space-y-3 text-sm leading-7 text-[var(--muted)]">{drill.captureGuidance.map((guidance) => <li key={guidance}>{guidance}</li>)}</ul>
        <div className="flex flex-wrap gap-3">
          <Link href="/record" className="button-secondary">Record a shot</Link>
          <Link href="/homecourt" className="button-secondary">Import from HomeCourt</Link>
        </div>
      </section>

      {related.length ? <section aria-labelledby="related-title" className="space-y-4">
        <h2 id="related-title" className="text-xl font-semibold">Try next</h2>
        <div className="grid gap-4 sm:grid-cols-2">{related.map((item) => <Link key={item.id} href={`/drills/${item.id}`}
          className="surface flex min-h-20 items-center justify-between gap-4 p-5 hover:text-[var(--accent)]">
          <div><p className="font-semibold">{item.title}</p><p className="mt-1 text-xs text-[var(--muted)]">{item.sets} sets × {item.reps} attempts · About {item.minutes} min</p></div><span aria-hidden="true">→</span>
        </Link>)}</div>
      </section> : null}
    </div>
  );
}
