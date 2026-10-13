import type { Metadata } from "next";
import Link from "next/link";
import { curryReferences, referenceLibraryHref, referencesCheckedOn, referenceViews, viewLabels, type ReferencePlatform, type ReferenceView } from "@/lib/curry-references";
import ReferencePlayer from "./reference-player";
import SourceVideo from "@/app/components/reference-source-video";

export const metadata: Metadata = { title: "Curry reference library — OneMotion" };
type Query = Record<string, string | string[] | undefined>;
const value = (item: Query[string]) => typeof item === "string" ? item : undefined;

export default async function ReferencesPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const requestedView = value(query.view);
  const view: ReferenceView = referenceViews.find(item => item === requestedView) ?? "all";
  const requestedPlatform = value(query.platform);
  const platform: ReferencePlatform = requestedPlatform === "youtube" || requestedPlatform === "bilibili" ? requestedPlatform : "all";
  const requestedAnalysis = value(query.analysis);
  const analysis = requestedAnalysis && /^[a-zA-Z0-9_-]{1,64}$/.test(requestedAnalysis) ? requestedAnalysis : undefined;
  const visible = curryReferences.filter(item => (view === "all" || item.views.includes(view)) && (platform === "all" || item.platform === platform));
  const selected = visible.find(item => item.id === value(query.reference)) ?? visible[0];
  const href = (next: { view?: ReferenceView; platform?: ReferencePlatform; reference?: string } = {}) => referenceLibraryHref({ view, platform, analysis, ...next });
  return <div className="page-shell space-y-8">
    <header>
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="eyebrow">Analyze / Reference library</p>
        <Link href={analysis ? `/analysis/${encodeURIComponent(analysis)}` : "/analyze"} className="text-sm text-[var(--accent)]">← {analysis ? "Back to your analysis" : "Back to Analyze"}</Link></div>
      <h1 className="page-title mt-3">Study the shot. Choose your view.</h1>
      <p className="page-description mt-4">Explore Curry footage from different camera positions. Choose a view like your recording and study the visible details at your own pace.</p>
      <p className="mt-3 text-xs leading-6 text-[var(--muted)]">{curryReferences.length} sources · {curryReferences.filter(item => item.reviewed).length} footage spot checks · Reviewed {referencesCheckedOn}</p>
    </header>

    <section aria-label="Current scored reference">
      <details className="surface p-5 sm:p-6">
        <summary className="flex min-h-6 cursor-pointer list-none flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Current benchmark: Curry v3</h2><span className="text-xs font-medium text-[var(--accent)]">About &amp; local source ↓</span>
        </summary>
        <p className="mt-4 max-w-3xl text-sm leading-7 text-[var(--muted)]">The local source supplies the three-second reference used in your report. The new videos in this library are for visual study. Selecting a video or camera view does not change your scores.</p>
        <div className="mt-4"><SourceVideo path="/api/v1/templates/curry_v3/source-video" /></div>
      </details>
    </section>

    <section aria-label="Reference filters" className="space-y-4">
      <div><h2 className="text-sm font-semibold">Camera view</h2><p className="mt-1 text-xs leading-6 text-[var(--muted)]">View labels describe inspected footage. They are not an automatic camera match.</p>
        <nav aria-label="Filter by camera view" className="mt-3 flex flex-wrap gap-2">{referenceViews.map(item => <Link key={item} href={href({ view: item })} scroll={false}
          className="reference-filter" aria-current={view === item ? "true" : undefined}>{viewLabels[item]} <span className="text-xs opacity-75">{curryReferences.filter(source => (item === "all" || source.views.includes(item)) && (platform === "all" || source.platform === platform)).length}</span></Link>)}</nav>
      </div>
      <nav aria-label="Filter by platform" className="flex flex-wrap gap-2">{(["all", "youtube", "bilibili"] as const).map(item => <Link key={item} href={href({ platform: item })} scroll={false}
        aria-current={platform === item ? "true" : undefined} className="reference-filter">{item === "all" ? "All platforms" : item === "youtube" ? "YouTube" : "Bilibili"}</Link>)}</nav>
      <p role="status" className="text-sm text-[var(--muted)]">{visible.length} {visible.length === 1 ? "source" : "sources"} · {viewLabels[view]}</p>
    </section>

    {selected ? <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,.85fr)_minmax(0,1.15fr)]">
      <section id="reference-preview" aria-label="Selected reference" className="surface min-w-0 scroll-mt-40 p-5 sm:p-6 lg:col-start-2 lg:row-start-1">
        <p className="eyebrow">Visual study only</p><h2 className="mt-2 text-xl font-semibold tracking-tight">{selected.title}</h2><p className="mb-5 mt-2 text-sm text-[var(--muted)]">{selected.publisher}</p>
        <ReferencePlayer key={selected.id} reference={selected} />
        <div className="mt-6 rounded-xl bg-[var(--surface-muted)] p-4"><h3 className="text-sm font-semibold">What to keep in mind</h3>
          <ul className="mt-2 list-disc space-y-2 pl-4 text-sm leading-6 text-[var(--muted)]">{selected.limitations.map(item => <li key={item}>{item}</li>)}</ul>
          <p className="mt-3 text-xs leading-6 text-[var(--muted-strong)]">{selected.speed === "slow_motion" ? "Slow-motion scale is unknown. Timing and velocity comparisons are unavailable." : "Original playback speed is unverified. Do not use this source to judge shot tempo."}</p>
        </div>
      </section>
      <section aria-label="Reference sources" className="grid gap-3 sm:grid-cols-2 lg:col-start-1 lg:row-start-1 lg:grid-cols-1">
        {visible.map(item => <Link key={item.id} href={`${href({ reference: item.id })}#reference-preview`} aria-current={item.id === selected.id ? "true" : undefined}
          className="surface reference-card p-5" aria-label={`View ${item.title}`}>
          <div className="flex flex-wrap gap-2 text-xs text-[var(--muted)]"><span>{item.platform === "youtube" ? "YouTube" : "Bilibili"}</span><span>·</span><span>{item.views.map(view => viewLabels[view]).join(" / ")}</span></div>
          <h3 className="mt-3 text-lg font-semibold tracking-tight">{item.title}</h3><p className="mt-1 text-xs text-[var(--muted)]">{item.publisher}</p>
          <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{item.description}</p>
          <div className="mt-4 flex flex-wrap gap-2"><span className="reference-badge">{item.reviewed ? "Footage spot checked" : "Source details only"}</span><span className="reference-badge">{item.speed === "slow_motion" ? "Slow motion" : "Speed unverified"}</span></div>
          <span className="mt-4 inline-block text-sm font-medium text-[var(--accent)]">{item.id === selected.id ? "Viewing now" : "View reference →"}</span>
        </Link>)}
      </section>
    </div> : <section className="surface p-7 sm:p-10" aria-label="No matching references">
      <p className="eyebrow">A clear view comes first</p><h2 className="mt-3 text-xl font-semibold">{view === "side" ? "No reviewed side-view shots yet" : "No sources match these filters"}</h2>
      <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--muted)]">{view === "side" ? "The new sources do not yet include a verified, complete shooting-arm or opposite-side shot. Use the current Curry source above, or explore oblique footage for visual study." : "Try another camera view or include both platforms to explore more footage."}</p>
      <Link href={referenceLibraryHref({ analysis })} className="button-secondary mt-5">Show all references</Link>
    </section>}
  </div>;
}
