import Link from "next/link";
import { referenceLibraryHref, viewLabels, type ReferenceView } from "@/lib/curry-references";

export default function ReferenceLibraryEntry({ analysisId }: { analysisId?: string }) {
  return <section aria-label="Curry reference library" className="surface p-6">
    <p className="eyebrow">Watch. Notice. Practice.</p><h2 className="mt-2 text-xl font-semibold">Explore Curry references</h2>
    <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--muted)]">Choose the view you recorded and study the visible details. These videos are for visual review; your scored reference remains Curry v3.</p>
    <div className="mt-5 flex flex-wrap gap-2">{(["front", "side", "rear", "oblique"] satisfies ReferenceView[]).map(view => <Link key={view}
      href={referenceLibraryHref({ view, analysis: analysisId })} className="reference-filter">{viewLabels[view]} view →</Link>)}</div>
    <Link href={referenceLibraryHref({ analysis: analysisId })} className="mt-5 inline-flex min-h-11 items-center text-sm font-semibold text-[var(--accent)]">Browse all references ↗</Link>
  </section>;
}
