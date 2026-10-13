"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const methods = [
  { href: "/record", label: "Record" },
  { href: "/upload", label: "Upload" },
  { href: "/homecourt", label: "HomeCourt import" },
];

export default function AnalysisEntryNav() {
  const pathname = usePathname();
  return <nav aria-label="Analysis source" className="entry-nav">
    {methods.map(method => <Link href={method.href} key={method.href}
      aria-current={pathname === method.href ? "page" : undefined}>{method.label}</Link>)}
  </nav>;
}
