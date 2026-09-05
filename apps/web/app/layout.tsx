import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OnMotion — Shoot like Steph",
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
            OnMotion
          </Link>
          <nav className="flex gap-6 text-sm text-zinc-600 dark:text-zinc-400">
            <Link href="/record" className="hover:text-foreground">Record</Link>
            <Link href="/upload" className="hover:text-foreground">Upload</Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
