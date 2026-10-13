"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import CourtDiagram from "@/app/components/court-diagram";
import { categoryLabels, drillCategories, drills, getDrill, levelLabels, workoutPlans, type DrillCategory } from "@/lib/drills";

export default function DrillsPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<DrillCategory | "all">("all");
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return drills.filter((drill) => (category === "all" || drill.category === category) &&
      (!search || [drill.title, drill.description, drill.id, categoryLabels[drill.category], ...drill.cues].join(" ").toLocaleLowerCase().includes(search)));
  }, [query, category]);

  return (
    <div className="page-shell space-y-9">
      <header className="flex flex-col gap-3">
        <p className="eyebrow">One shot at a time</p>
        <h1 className="page-title">Shooting drills</h1>
        <p className="max-w-2xl leading-7 text-[var(--muted)]">{drills.length} drills, from close-range form to shots on the move. Pick one for today’s time and goal.</p>
      </header>

      <section aria-label="Find a drill" className="space-y-4">
        <label className="surface flex min-h-12 max-w-xl items-center gap-3 px-4">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" className="shrink-0 text-[var(--muted)]">
            <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" />
          </svg>
          <input type="search" aria-label="Search drills" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Search names, movements or cues" className="min-h-12 min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-[var(--muted)]" />
        </label>
        <div role="group" aria-label="Drill categories" className="flex flex-wrap gap-2">
          {[{ id: "all" as const, title: "All" }, ...drillCategories].map((item) => <button key={item.id}
            aria-pressed={category === item.id} onClick={() => setCategory(item.id)}
            className={`min-h-11 rounded-full border px-5 py-2 text-sm font-medium ${category === item.id
              ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
              : "border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}>
            {item.title}
          </button>)}
        </div>
        <p role="status" className="text-sm text-[var(--muted)]">{filtered.length} {filtered.length === 1 ? "drill" : "drills"} found{category !== "all" ? ` · ${categoryLabels[category]}` : ""}</p>
      </section>

      <section aria-label="Drill list" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((drill) => <article key={drill.id} className="surface overflow-hidden">
          <Link href={`/drills/${drill.id}`} aria-label={drill.title} className="group flex h-full flex-col gap-4 p-5 sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <span className="eyebrow">{categoryLabels[drill.category]}</span>
              <span className="rounded-full bg-[var(--background)] px-3 py-1 text-xs text-[var(--muted)]">{levelLabels[drill.level]}</span>
            </div>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-xl font-semibold tracking-tight group-hover:text-[var(--accent)]">{drill.title}</h2>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{drill.description}</p>
              </div>
              <div className="w-24 shrink-0"><CourtDiagram spots={drill.spots} route={drill.route} compact title={drill.title} /></div>
            </div>
            <div className="mt-auto flex items-center justify-between gap-3 border-t border-[var(--border)] pt-4 text-sm">
              <span className="text-[var(--muted)]">About {drill.minutes} min <span aria-hidden="true">·</span> {drill.sets} sets × {drill.reps} attempts</span>
              <span aria-hidden="true" className="text-lg text-[var(--accent)]">↗</span>
            </div>
          </Link>
        </article>)}
      </section>
      {!filtered.length ? <div className="surface flex flex-col items-center gap-3 px-6 py-12 text-center">
        <h2 className="text-lg font-semibold">No matching drills</h2>
        <p className="text-sm text-[var(--muted)]">Try a shorter search or a different category.</p>
        <button className="button-secondary" onClick={() => { setQuery(""); setCategory("all"); }}>Clear filters</button>
      </div> : null}

      <section aria-labelledby="plans-title" className="space-y-4 border-t border-[var(--border)] pt-8">
        <div><p className="eyebrow">A plan for today</p><h2 id="plans-title" className="mt-2 text-2xl font-semibold tracking-tight">Three workout plans</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">Follow a plan in order or choose one drill. Estimated times include practice and rests between sets.</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {workoutPlans.map((plan, index) => {
            const items = plan.drillIds.map(getDrill).filter((drill) => drill !== undefined);
            return <article key={plan.id} className="surface flex flex-col gap-4 p-6">
              <div className="flex items-baseline gap-3"><span className="text-sm tabular-nums text-[var(--accent)]">0{index + 1}</span><h3 className="text-lg font-semibold">{plan.title}</h3></div>
              <p className="text-sm leading-6 text-[var(--muted)]">{plan.description}</p>
              <ol className="space-y-1 text-sm">{items.map((drill, itemIndex) => <li key={drill.id}>
                <Link href={`/drills/${drill.id}`} className="inline-flex min-h-11 items-center gap-3 underline decoration-[var(--border)] underline-offset-4 hover:text-[var(--accent)]">
                  <span className="text-[var(--muted)]">{itemIndex + 1}</span>{drill.title}
                </Link>
              </li>)}</ol>
              <p className="mt-auto text-xs text-[var(--muted)]">{items.length} drills · About {items.reduce((minutes, drill) => minutes + drill.minutes, 0)} min</p>
              <Link href={`/training?plan=${plan.id}`} className="button-secondary">Start workout plan →</Link>
            </article>;
          })}
        </div>
      </section>
    </div>
  );
}
