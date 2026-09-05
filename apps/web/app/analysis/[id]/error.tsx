"use client";

import Link from "next/link";

export default function AnalysisError({ retry }: { retry: () => void }) {
  return <div role="alert" className="mx-auto max-w-xl space-y-4 px-6 py-12">
    <h1 className="text-xl font-semibold">Your report could not be loaded</h1>
    <p>Check your connection and try again. If the service is unavailable, your saved report can be opened later.</p>
    <button className="rounded-full border px-5 py-2" onClick={() => retry()}>Try again</button>
    <Link href="/upload" className="ml-4 underline">Upload a new shot</Link>
  </div>;
}
