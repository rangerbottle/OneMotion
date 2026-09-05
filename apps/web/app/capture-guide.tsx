export default function CaptureGuide() {
  return (
    <section className="w-full max-w-2xl rounded-2xl border border-amber-500/25 bg-amber-500/[.06] p-4">
      <div className="grid items-center gap-4 sm:grid-cols-[180px_1fr]">
        <svg
          viewBox="0 0 180 112"
          role="img"
          aria-label="Camera positioned at a 90 degree side view of the shooter"
          className="mx-auto w-full max-w-[180px]"
        >
          <rect x="6" y="43" width="34" height="25" rx="5" fill="currentColor" opacity=".85" />
          <path d="M40 49l13-8v29l-13-8z" fill="currentColor" opacity=".65" />
          <path d="M57 56h52" stroke="#f59e0b" strokeWidth="2" strokeDasharray="5 4" />
          <path d="M109 18v77" stroke="#10b981" strokeWidth="2" strokeDasharray="5 4" />
          <circle cx="128" cy="27" r="9" fill="none" stroke="currentColor" strokeWidth="3" />
          <path d="M128 36v28m0-18l-15 13m15-13l17 9m-17 9l-11 27m11-27l13 27" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <circle cx="151" cy="49" r="5" fill="#f59e0b" />
          <path d="M66 51a45 45 0 0 1 41-32" fill="none" stroke="#f59e0b" strokeWidth="2" />
          <text x="66" y="42" fill="#f59e0b" fontSize="12" fontWeight="700">90°</text>
        </svg>
        <div>
          <h2 className="font-semibold">Match Curry&rsquo;s 90° side view</h2>
          <ul className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-300">
            <li>• Put the camera on your shooting-hand side, perpendicular to the rim.</li>
            <li>• Keep your full body, shooting arm, and ball visible from dip through follow-through.</li>
            <li>• Use a stable camera around chest height; avoid zooming or panning.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
