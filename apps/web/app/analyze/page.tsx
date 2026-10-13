import Link from "next/link";
import ReferenceLibraryEntry from "@/app/components/reference-library-entry";

const methods = [
  { href: "/homecourt", step: "01", title: "Import from HomeCourt", description: "Bring in a training video and select one complete shot. Keep the original camera view and identify the shooter.", detail: "Up to 200 MB · 10-minute source · 12-second selection", action: "Import a session" },
  { href: "/record", step: "02", title: "Record a shot", description: "Set your camera to the side, record a single shot, and review the clip before starting analysis.", detail: "Camera access · One shot · Up to 12 seconds", action: "Open the camera" },
  { href: "/upload", step: "03", title: "Upload a clip", description: "Choose a short shot clip already on your device to compare your form against the Curry v3 reference.", detail: "MP4, MOV or WebM · Up to 50 MB · 12 seconds", action: "Choose a clip" },
];

export default function AnalyzePage() {
  return <div className="page-shell space-y-8">
    <header><p className="eyebrow">Review your form</p><h1 className="page-title mt-2">One place for every shot.</h1><p className="page-description mt-4">Choose your video source. Each workflow leads to the same analysis report, with playback, measurement evidence, and drills for your next workout.</p></header>
    <section aria-label="Choose a video source" className="grid gap-5 lg:grid-cols-3">
      {methods.map(method => <article key={method.href} className="surface flex flex-col p-6 sm:p-8"><span className="eyebrow">SOURCE / {method.step}</span><h2 className="mt-5 text-xl font-semibold tracking-tight">{method.title}</h2><p className="mt-3 flex-1 text-sm leading-7 text-[var(--muted)]">{method.description}</p><p className="my-6 text-xs leading-6 text-[var(--muted)]">{method.detail}</p><Link href={method.href} className="button-primary">{method.action} ↗</Link></article>)}
    </section>
    <section className="surface flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-semibold">Review your progress side by side</h2><p className="page-description mt-2 text-sm">Have two clips from the same camera position? Compare your own shots frame by frame.</p></div><Link href="/compare/new" className="button-secondary shrink-0">Compare two clips →</Link></section>
    <ReferenceLibraryEntry />
    <p className="max-w-3xl text-sm leading-7 text-[var(--muted)]">Record your full body from the side and include the complete shooting motion. Low-confidence measurements stay visible with an explanation. Timing comparisons require verified real-time playback.</p>
  </div>;
}
