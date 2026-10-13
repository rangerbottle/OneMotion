"use client";

import { useState } from "react";
import { formatReferenceTime, referenceEmbedUrl, referenceSourceUrl, type CurryReference } from "@/lib/curry-references";

export default function ReferencePlayer({ reference }: { reference: CurryReference }) {
  const [seconds, setSeconds] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const platform = reference.platform === "youtube" ? "YouTube" : "Bilibili";
  return <div className="space-y-4">
    <div className="aspect-video min-h-[200px] w-full min-w-0 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)]">
      {loaded ? <iframe key={`${reference.id}-${seconds}`} title={`${reference.title} — ${platform} player`}
        src={referenceEmbedUrl(reference, seconds)} className="h-full w-full border-0"
        referrerPolicy="strict-origin-when-cross-origin" allow="encrypted-media; fullscreen; picture-in-picture" allowFullScreen />
        : <div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">{platform} · Source video</span>
          <button type="button" className="button-primary" onClick={() => setLoaded(true)}>Load {platform} player ↗</button>
          <p className="max-w-xs text-xs leading-5 text-[var(--muted)]">The external player loads when you choose to watch.</p>
        </div>}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <a href={referenceSourceUrl(reference, seconds)} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-[var(--accent)] underline underline-offset-4">Open source on {platform} ↗</a>
      {loaded ? <button type="button" className="min-h-11 text-sm text-[var(--muted)] underline underline-offset-4" onClick={() => setLoaded(false)}>Unload player</button> : null}
    </div>
    <p className="text-xs leading-6 text-[var(--muted)]">If playback is unavailable or sign-in is required, use the source upload. No account is needed to browse this library.</p>
    {reference.bookmarks.length ? <div>
      <h3 className="text-sm font-semibold">Review bookmarks</h3>
      <p className="mt-1 text-xs leading-5 text-[var(--muted)]">Chapters and inspected positions, rather than complete shot boundaries.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" aria-pressed={seconds === 0} className="reference-bookmark" onClick={() => setSeconds(0)}>0:00 · Start</button>
        {reference.bookmarks.map(bookmark => <button key={bookmark.seconds} type="button" aria-pressed={seconds === bookmark.seconds}
          className="reference-bookmark" onClick={() => setSeconds(bookmark.seconds)}>{formatReferenceTime(bookmark.seconds)} · {bookmark.label}</button>)}
      </div>
      <p className="sr-only" role="status">Selected start position: {formatReferenceTime(seconds)}. {loaded ? "Player loaded." : "Load the player to watch."}</p>
    </div> : null}
  </div>;
}
