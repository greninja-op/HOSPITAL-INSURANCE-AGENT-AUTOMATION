"use client";

// =============================================================================
// components/dashboard/sla-countdown.tsx
//
// SLA_Clock countdown + at-risk indicator for a Dashboard Case card
// (Requirements 10.2, 12.2, 12.4).
//
// Shows the remaining time until the Case's SLA_Clock deadline, ticking once a
// minute on the client. Remaining time is computed with `remainingMs` and the
// at-risk decision with `isAtRisk` from `lib/sla.ts`, so the UI shares the exact
// same threshold logic as the API. When the Case is at risk (< 24h remaining,
// including overdue) the countdown switches to a destructive style and shows an
// explicit "At risk" indicator (Req 12.4).
// =============================================================================

import { useEffect, useState } from "react";
import { AlertTriangle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { isAtRisk, remainingMs } from "@/lib/sla";

/** Re-tick every minute; the deadline granularity does not need finer updates. */
const TICK_MS = 60_000;

interface SlaCountdownProps {
  /** ISO-8601 SLA_Clock deadline for the Case. */
  deadline: string;
  className?: string;
}

/**
 * Format a remaining-millisecond span as a compact countdown label.
 * Negative spans (overdue) render as "Overdue".
 */
function formatRemaining(ms: number): string {
  if (ms <= 0) return "Overdue";

  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

export function SlaCountdown({ deadline, className }: SlaCountdownProps) {
  // Start from the deadline itself so the first client render is deterministic;
  // the effect immediately re-syncs to the real "now" and ticks each minute.
  const [now, setNow] = useState<Date>(() => new Date(deadline));

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, [deadline]);

  const deadlineDate = new Date(deadline);
  const remaining = remainingMs(deadlineDate, now);
  const atRisk = isAtRisk(deadlineDate, now);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium",
        atRisk ? "text-destructive" : "text-muted-foreground",
        className,
      )}
      title={`SLA deadline ${deadlineDate.toLocaleString()}`}
    >
      {atRisk ? (
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Clock className="h-3.5 w-3.5" aria-hidden />
      )}
      <span className="font-mono">{formatRemaining(remaining)}</span>
      {atRisk ? (
        <span className="ml-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive">
          At risk
        </span>
      ) : null}
    </span>
  );
}
