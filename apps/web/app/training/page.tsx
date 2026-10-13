import Link from "next/link";
import { getDrill, workoutPlans } from "@/lib/drills";
import TrainingRunner from "./runner";

export default async function TrainingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const plan = workoutPlans.find(item => item.id === query.plan);
  const step = typeof query.step === "string" && /^\d+$/.test(query.step) ? Number(query.step) : 0;
  const drill = getDrill(plan?.drillIds[step] ?? (typeof query.drill === "string" ? query.drill : "close-form"));
  if ((query.plan && !plan) || (plan && (step < 0 || step >= plan.drillIds.length)) || !drill) return <div className="page-shell"><h1 className="page-title">Training session not found</h1><Link href="/drills" className="button-secondary mt-5">Back to drills</Link></div>;
  return <TrainingRunner key={`${plan?.id ?? "single"}:${step}:${drill.id}`} drill={drill} plan={plan ?? null} step={step} />;
}
