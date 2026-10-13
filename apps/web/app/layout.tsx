import type { Metadata } from "next";
import Link from "next/link";
import localFont from "next/font/local";
import "./globals.css";
import AppNav from "./components/app-nav";

// Self-hosted Geist (OFL) — next/font/google fetches at build time, which
// breaks offline / network-restricted builds.
const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
});

export const metadata: Metadata = {
  title: "OneMotion — Shooting practice & analysis",
  description:
    "Build a shooting workout, record every attempt, and review your form with evidence-aware video analysis.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <a href="#content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-background focus:p-3">Skip to content</a>
        <header className="app-header">
          <div className="mx-auto flex max-w-[76rem] flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
          <Link href="/" className="flex min-h-11 items-center gap-2 text-lg font-semibold tracking-tight">
            <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-[var(--accent)] text-white">◒</span>
            OneMotion
          </Link>
          <AppNav />
          </div>
        </header>
        <main id="content" className="flex min-w-0 flex-1 flex-col">{children}</main>
      </body>
    </html>
  );
}
