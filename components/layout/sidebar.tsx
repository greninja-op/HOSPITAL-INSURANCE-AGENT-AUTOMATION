"use client";

// =============================================================================
// components/layout/sidebar.tsx
//
// Persistent application sidebar (Requirement 19.1): links to the Dashboard,
// Intake ("New Case"), and Analytics_Page, rendered on every page via the root
// layout. The active route is highlighted using the current pathname.
// =============================================================================

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, FilePlus2, LayoutDashboard, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

interface NavLink {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_LINKS: NavLink[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/intake", label: "New Case", icon: FilePlus2 },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
];

/** Returns true when `href` is the active route for the given pathname. */
function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex h-16 items-center gap-2 border-b border-border px-6">
        <ShieldCheck className="h-6 w-6 text-primary" aria-hidden />
        <span className="text-lg font-semibold tracking-tight">AuthPilot</span>
      </div>

      <nav aria-label="Primary" className="flex-1 space-y-1 p-3">
        {NAV_LINKS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border p-4 text-xs text-muted-foreground">
        Prior-auth &amp; appeal coordinator
      </div>
    </aside>
  );
}
