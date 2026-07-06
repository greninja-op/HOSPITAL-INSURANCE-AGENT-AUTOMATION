"use client";

// =============================================================================
// components/analytics/analytics-view.tsx
//
// Client controller for the Analytics_Page (Requirement 14). Loads the
// denial-intelligence data and renders the four required views:
//
//   1. Denials-by-payer bar chart      (Req 14.1) — from GET /api/analytics.
//   2. Resolution rate                 (Req 14.2) — derived from GET /api/cases.
//   3. Average time-to-resolution      (Req 14.3) — derived from the resolved
//                                        Cases' createdAt → resolvedAt spans.
//   4. At-risk list                    (Req 12.4, 14.4) — from GET /api/analytics.
//
// Resolution-rate and average-time-to-resolution are computed on the client
// from the existing read endpoints: the case list supplies every Case's status
// (Resolved / DeniedFinal are the closed states retained for these analytics per
// Req 24.6), and each closed Case's detail supplies its `createdAt`/`resolvedAt`
// span. All fetches degrade gracefully so a partial failure never blanks the
// page.
// =============================================================================

import { useEffect, useState } from "react";
import { Clock, Gauge, Loader2, TrendingUp } from "lucide-react";
import type { AnalyticsResponse } from "@/app/api/analytics/route";
import type { CaseSummary, ListCasesResponse } from "@/app/api/cases/route";
import type { CaseDetail } from "@/app/api/cases/[id]/route";
import type { CaseStatus } from "@/lib/types";
import { DenialsByPayerChart } from "./denials-by-payer-chart";
import { AtRiskList } from "./at-risk-list";
import { StatCard } from "./stat-card";

/** Case_Status values that represent a closed (resolved) Case (Req 24.6). */
const CLOSED_STATUSES: ReadonlySet<CaseStatus> = new Set<CaseStatus>([
  "Resolved",
  "DeniedFinal",
]);

/** Derived resolution metrics computed client-side from the read endpoints. */
interface ResolutionMetrics {
  totalCases: number;
  closedCases: number;
  /** Fraction in [0, 1]; null when there are no cases to rate. */
  resolutionRate: number | null;
  /** Mean createdAt→resolvedAt span in ms; null when no timed resolutions. */
  avgTimeToResolutionMs: number | null;
  /** Number of closed cases that contributed a timed span. */
  timedResolutions: number;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; analytics: AnalyticsResponse; metrics: ResolutionMetrics };

/** Format a fraction as a whole-percent string, or an em dash when unknown. */
function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${Math.round(rate * 100)}%`;
}

/** Format a millisecond duration as a compact "Xd Yh" / "Yh Zm" label. */
function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Compute resolution rate and average time-to-resolution. The case list gives
 * status and count; each closed Case's detail (fetched in parallel) supplies
 * the createdAt→resolvedAt span used for the average. Detail fetch failures are
 * skipped so a partial outage still yields a resolution rate.
 */
async function computeResolutionMetrics(
  cases: CaseSummary[],
): Promise<ResolutionMetrics> {
  const totalCases = cases.length;
  const closed = cases.filter((c) => CLOSED_STATUSES.has(c.status));
  const closedCases = closed.length;
  const resolutionRate = totalCases === 0 ? null : closedCases / totalCases;

  const details = await Promise.all(
    closed.map(async (c) => {
      try {
        const res = await fetch(`/api/cases/${c.id}`, { cache: "no-store" });
        if (!res.ok) return null;
        return (await res.json()) as CaseDetail;
      } catch {
        return null;
      }
    }),
  );

  const spans: number[] = [];
  for (const detail of details) {
    if (!detail?.resolvedAt) continue;
    const span = new Date(detail.resolvedAt).getTime() - new Date(detail.createdAt).getTime();
    if (Number.isFinite(span) && span >= 0) spans.push(span);
  }

  const avgTimeToResolutionMs =
    spans.length === 0
      ? null
      : spans.reduce((sum, s) => sum + s, 0) / spans.length;

  return {
    totalCases,
    closedCases,
    resolutionRate,
    avgTimeToResolutionMs,
    timedResolutions: spans.length,
  };
}

export function AnalyticsView() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [analyticsRes, casesRes] = await Promise.all([
          fetch("/api/analytics", { cache: "no-store" }),
          fetch("/api/cases", { cache: "no-store" }),
        ]);
        if (!analyticsRes.ok) {
          throw new Error(`Failed to load analytics (${analyticsRes.status})`);
        }
        if (!casesRes.ok) {
          throw new Error(`Failed to load cases (${casesRes.status})`);
        }
        const analytics = (await analyticsRes.json()) as AnalyticsResponse;
        const cases = (await casesRes.json()) as ListCasesResponse;
        const metrics = await computeResolutionMetrics(cases);
        if (!cancelled) setState({ kind: "ready", analytics, metrics });
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: "error",
            message:
              err instanceof Error ? err.message : "Failed to load analytics",
          });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading analytics…
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="flex h-64 items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 px-4 text-center text-sm text-destructive">
        {state.message}
      </div>
    );
  }

  const { analytics, metrics } = state;

  return (
    <div className="flex flex-col gap-6">
      {/* Headline metrics (Req 14.2, 14.3) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Resolution rate"
          value={formatRate(metrics.resolutionRate)}
          hint={`${metrics.closedCases} of ${metrics.totalCases} cases closed`}
          icon={Gauge}
        />
        <StatCard
          label="Avg time to resolution"
          value={formatDuration(metrics.avgTimeToResolutionMs)}
          hint={
            metrics.timedResolutions > 0
              ? `Across ${metrics.timedResolutions} resolved case${metrics.timedResolutions === 1 ? "" : "s"}`
              : "No resolved cases yet"
          }
          icon={Clock}
        />
        <StatCard
          label="Denials this month"
          value={String(analytics.totalDenialsThisMonth)}
          hint={`${analytics.denialsByPayer.length} payer${analytics.denialsByPayer.length === 1 ? "" : "s"} with denials`}
          icon={TrendingUp}
        />
      </div>

      {/* Denials by payer (Req 14.1) */}
      <section
        aria-label="Denials by payer this month"
        className="rounded-lg border border-border bg-card p-4 shadow-sm"
      >
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">
            Denials by payer
          </h2>
          <span className="text-xs text-muted-foreground">
            {analytics.totalDenialsThisMonth} this month
          </span>
        </div>
        <DenialsByPayerChart data={analytics.denialsByPayer} />
      </section>

      {/* At-risk list (Req 12.4, 14.4) */}
      <section aria-label="Cases nearing their SLA deadline">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">
            At-risk cases
          </h2>
          <span className="text-xs text-muted-foreground">
            {analytics.atRisk.length} nearing SLA deadline
          </span>
        </div>
        <AtRiskList cases={analytics.atRisk} />
      </section>
    </div>
  );
}
