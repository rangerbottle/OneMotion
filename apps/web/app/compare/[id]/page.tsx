"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import Workbench from "./workbench";

export default function ComparePage() {
  return (
    <Suspense fallback={<div role="status" className="page-shell text-center text-sm text-[var(--muted)]">Loading…</div>}>
      <CompareInner />
    </Suspense>
  );
}

function CompareInner() {
  const params = useParams<{ id: string }>();
  return <Workbench comparisonId={params.id} />;
}
