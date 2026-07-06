"use client";

// =============================================================================
// components/analytics/at-risk-list.tsx
//
// Analytics_Page at-risk list (Requirements 12.4, 14.4). Lists the unresolved
// Cases nearing their SLA_Clock deadline (as computed by the API using
// `isAtRisk`), soonest deadline first, each showing the at-risk indicator and
// linking to its Case Detail page. The SLA countdown reuses the shared
// `SlaCountdown` component so the threshold logic matches the Dashboard.
// =============================================================================

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { SlaCountdown } from "@/components/dashboard/sla-countdown";
import type { AtRiskCase } from "@/app/api/analytics/route";

interface AtRiskListProps {
  cases: AtRiskCase[];
}

export function AtRiskList({ cases }: AtRiskListProps) {
  if (cases.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md border border-border bg-card text-center text-sm text-muted-foreground">
        No cases are currently at risk. Every open case has more than 24 hours of
        SLA runway.
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border bg-card">
      {cases.map((c) => (
        <li key={c.id}>
          <Link
            href={`/case/${c.id}`}
            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <AlertTriangle
              className="h-4 w-4 shrink-0 text-destructive"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {c.patientName ?? "Unknown patient"}
                <span className="ml-2 font-normal text-muted-foreground">
                  · {c.payerName ?? "Unknown payer"}
                </span>
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {c.denialReason ?? "No denial reason yet"} · {c.status}
                {c.isUrgent ? " · Urgent" : ""}
              </p>
            </div>
            <SlaCountdown deadline={c.slaDeadline} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
