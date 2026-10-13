import Link from "next/link";
import { drills, workoutPlans, getDrill } from "@/lib/drills";
import CourtDiagram from "./components/court-diagram";
import TrainingSummaryCard from "./components/training-summary";

export default function Home() {
  const first = drills[0];
  return <div className="page-shell space-y-10">
    <section className="grid gap-6 lg:grid-cols-[1.15fr_1fr]">
      <div className="flex flex-col justify-center py-4 sm:py-8">
        <p className="eyebrow">One court. One shot. One motion.</p>
        <h1 className="mt-5 text-4xl font-semibold leading-[1.1] tracking-tight sm:text-6xl">Every shot.<br />A step forward.</h1>
        <p className="mt-5 max-w-lg text-base leading-7 text-[var(--muted)]">Your shooting practice starts here. Choose a workout, log every attempt, and bring evidence from your videos back to the court.</p>
        <div className="mt-7 flex flex-wrap gap-3"><Link href={`/training?drill=${first.id}`} className="button-primary">Start a workout ↗</Link><Link href="/analyze" className="button-secondary">Review a shot</Link></div>
        <p className="mt-7 text-sm text-[var(--muted)]">{drills.length} shooting drills · Camera, uploads &amp; HomeCourt videos</p>
      </div>
      <div className="surface relative overflow-hidden p-6 sm:p-8">
        <div className="relative z-10 flex flex-wrap items-center justify-between gap-3"><p className="eyebrow">BACK TO THE BASICS</p><span className="rounded-full bg-[var(--accent-soft)] px-3 py-1 text-xs text-[var(--accent)]">Find your rhythm</span></div>
        <div className="mx-auto my-2 max-w-[21rem]"><CourtDiagram spots={first.spots} /></div>
        <div className="relative z-10 flex items-end justify-between gap-3"><div><h2 className="text-2xl font-semibold">{first.title}</h2><p className="mt-2 text-sm text-[var(--muted)]">{first.sets} sets × {first.reps} shots · About {first.minutes} min</p></div><Link href={`/drills/${first.id}`} aria-label={`View ${first.title}`} className="flex size-12 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-2xl text-[var(--accent)]">↗</Link></div>
      </div>
    </section>
    <section className="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
      <TrainingSummaryCard />
      <div className="surface flex flex-col justify-between gap-5 p-6 sm:flex-row sm:items-center"><div><p className="eyebrow">Practice → Review → Repeat</p><h2 className="mt-2 text-xl font-semibold">Pick one shot. See what changed.</h2><p className="mt-2 max-w-md text-sm leading-6 text-[var(--muted)]">Compare with the Curry reference or review two of your own shots from the same camera position. Reliable feedback guides your next drill.</p></div><Link href="/compare" className="button-secondary shrink-0">Compare shots →</Link></div>
    </section>
    <section><div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="eyebrow">Build your workout</p><h2 className="mt-2 text-2xl font-semibold tracking-tight">A clear plan for today.</h2></div><Link href="/drills" className="text-sm text-[var(--accent)]">Explore all drills →</Link></div>
      <div className="grid gap-4 md:grid-cols-3">{workoutPlans.map((plan, index) => <Link href={`/training?plan=${plan.id}`} key={plan.id} className="surface group flex flex-col p-6 hover:border-[var(--accent)]"><span className="text-xs font-medium text-[var(--muted)]">WORKOUT / 0{index + 1}</span><h3 className="mt-5 text-xl font-semibold">{plan.title}</h3><p className="mt-2 flex-1 text-sm leading-6 text-[var(--muted)]">{plan.description}</p><div className="mt-6 flex items-center justify-between gap-3 text-sm"><span>{plan.drillIds.length} drills · About {plan.drillIds.reduce((sum, id) => sum + (getDrill(id)?.minutes ?? 0), 0)} min</span><span className="shrink-0 text-[var(--accent)]">Start ↗</span></div></Link>)}</div>
    </section>
  </div>;
}
