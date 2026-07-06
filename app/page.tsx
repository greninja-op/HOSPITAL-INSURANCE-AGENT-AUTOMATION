// =============================================================================
// app/page.tsx
//
// Dashboard home (Requirement 10). Composes the current-month denials-by-payer
// analytics widget (Req 10.5) and the Kanban board of every Case grouped by
// Case_Status (Req 10.1), each Case card linking to its Case Detail page
// (Req 10.2, 10.3, 12.2, 12.4). A "New Case" control opens the Intake page
// (Req 10.4).
//
// The board and widget fetch their own data client-side from GET /api/cases and
// GET /api/analytics, so this page itself is a thin server component that lays
// out the header and those two sections.
// =============================================================================

import Link from "next/link";
import { FilePlus2 } from "lucide-react";
import { KanbanBoard } from "@/components/dashboard/kanban-board";
import { DenialsByPayerWidget } from "@/components/dashboard/denials-by-payer-widget";

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Every case grouped by status, with SLA countdowns and denial trends.
          </p>
        </div>
        <Link
          href="/intake"
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <FilePlus2 className="h-4 w-4" aria-hidden />
          New Case
        </Link>
      </div>

      <DenialsByPayerWidget />

      <KanbanBoard />
    </div>
  );
}
