"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import Workbench from "./workbench";

export default function ComparePage() {
  return (
    <Suspense fallback={<div role="status" className="px-6 py-12 text-center text-sm text-zinc-500">正在加载…</div>}>
      <CompareInner />
    </Suspense>
  );
}

function CompareInner() {
  const params = useParams<{ id: string }>();
  return <Workbench comparisonId={params.id} />;
}
