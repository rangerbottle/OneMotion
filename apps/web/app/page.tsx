import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
        Shoot like Steph.
      </h1>
      <p className="mt-4 max-w-xl text-lg text-zinc-600 dark:text-zinc-400">
        OneMotion compares your shot to Stephen Curry&rsquo;s one-motion
        benchmark — release angle, tempo, and form — then tells you exactly
        what to fix.
      </p>
      <div className="mt-10 flex flex-col gap-4 sm:flex-row">
        <Link
          href="/record"
          className="flex h-12 items-center justify-center rounded-full bg-foreground px-8 text-background transition-opacity hover:opacity-80"
        >
          Record a shot
        </Link>
        <Link
          href="/upload"
          className="flex h-12 items-center justify-center rounded-full border border-black/[.08] px-8 transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-[#1a1a1a]"
        >
          Upload a clip
        </Link>
      </div>
    </div>
  );
}
