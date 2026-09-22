import type { Metadata } from "next";
import Link from "next/link";
import localFont from "next/font/local";
import "./globals.css";

// Self-hosted Geist (OFL) — next/font/google fetches at build time, which
// breaks offline / network-restricted builds.
const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "OneMotion — Shoot like Steph",
  description:
    "Learn Stephen Curry's one-motion shot: compare your shooting form to a pose-estimation benchmark and get concrete feedback.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="flex items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            OneMotion
          </Link>
          <nav className="flex gap-6 text-sm text-zinc-600 dark:text-zinc-400">
            <Link href="/record" className="hover:text-foreground">Record</Link>
            <Link href="/upload" className="hover:text-foreground">Upload</Link>
            <Link href="/compare" className="hover:text-foreground">对比</Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
