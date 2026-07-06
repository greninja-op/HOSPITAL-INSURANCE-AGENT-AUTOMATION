// =============================================================================
// components/dashboard/case-card.tsx
//
// A single Dashboard Kanban Case card (Requirements 10.2, 10.3, 12.2, 12.4).
//
// Shows the patient initials avatar, payer, procedure/denial context, the
// overall Confidence_Score badge, and the SLA_Clock countdown with its at-risk
// indicator. The whole card is a link that opens the Case Detail page at
// `/case/[id]` (Req 10.3).
// =============================================================================

import Link from "next/link";
import { cn } from "@/lib/utils";
import type { CaseSummary } from "@/app/api/cases/route";
import { ConfidenceBadge } from "./confidence-badge";
import { SlaCountdown } from "./sla-countdown";

interface CaseCardProps {
  caseSummary: CaseSummary;
}

/**
 * Derive up-to-two-letter initials from a patient display name. Falls back to
 * "?" when no name is available (the summary keeps patient name optional).
 */
export function patientInitials(name: string | null): string {
  if (!name) return "?";
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function CaseCard({ caseSummary }: CaseCardProps) {
  const {
    id,
    payerName,
    denialReason,
    overallConfidence,
    slaDeadline,
    patientName,
  } = caseSummary;

  return (
    <Link
      href={`/case/${id}`}
      className={cn(
        "block rounded-lg border border-border bg-card p-3 text-left shadow-sm transition-colors",
        "hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground"
          aria-hidden
        >
          {patientInitials(patientName)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {payerName ?? "Unknown payer"}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {denialReason ?? "No procedure / denial reason yet"}
          </p>
        </div>
        <ConfidenceBadge confidence={overallConfidence} />
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-border pt-2">
        <SlaCountdown deadline={slaDeadline} />
        <span className="font-mono text-[10px] text-muted-foreground">
          #{id.slice(0, 6)}
        </span>
      </div>
    </Link>
  );
}
