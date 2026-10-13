"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/api";

export default function ReferenceSourceVideo({ path, timingReliable }: { path: string; timingReliable?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  return <section className="space-y-3">
    <button type="button" className="button-secondary" aria-expanded={!!url}
      onClick={() => { setFailed(false); setUrl((current) => current ? null : apiUrl(path)); }}>
      {url ? "Hide full Curry source video" : "View full Curry source video"}
    </button>
    {url ? <div className="space-y-2">
      <p className="text-sm leading-6 text-[var(--muted)]">The reference uses the first 3 seconds of this complete source. {timingReliable === undefined ? "Playback alone does not establish original speed. Your report shows whether timing comparison is available." : !timingReliable ? "Real-time playback has not been independently verified, so timing scores remain disabled." : "The source has been verified as real-time playback."}</p>
      <video src={url} controls playsInline preload="metadata" className="max-h-[600px] w-full rounded-xl bg-black"
        onError={() => setFailed(true)} />
      {failed ? <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">The source video could not be played. Check the local media and service connection.</p> : null}
    </div> : null}
  </section>;
}
