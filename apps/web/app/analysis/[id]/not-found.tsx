import Link from "next/link";

export default function AnalysisNotFound() {
  return <div className="mx-auto max-w-xl space-y-4 px-6 py-12">
    <h1 className="text-xl font-semibold">Analysis not found</h1>
    <p>This report may have been deleted, or the link is incomplete.</p>
    <Link href="/upload" className="underline">Upload a new shot</Link>
  </div>;
}
