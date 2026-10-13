"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/", label: "Dashboard", routes: ["/"] },
  { href: "/drills", label: "Training", routes: ["/drills", "/training"] },
  { href: "/progress", label: "Progress", routes: ["/progress"] },
  { href: "/analyze", label: "Analyze", routes: ["/analyze", "/record", "/upload", "/homecourt", "/analysis", "/references"] },
  { href: "/compare", label: "Compare", routes: ["/compare"] },
];
export default function AppNav() {
  const pathname = usePathname();
  return <nav aria-label="Main navigation" className="app-nav flex w-full min-w-0 gap-1 overflow-x-auto sm:w-auto">
    {items.map(item => <Link key={item.href} href={item.href}
      aria-current={item.routes.some(route => pathname === route || (route !== "/" && pathname.startsWith(`${route}/`))) ? "page" : undefined}>{item.label}</Link>)}
  </nav>;
}
