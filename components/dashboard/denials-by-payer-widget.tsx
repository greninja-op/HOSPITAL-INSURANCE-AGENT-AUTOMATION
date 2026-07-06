"use client";

// =============================================================================
// components/dashboard/denials-by-payer-widget.tsx
//
// Dashboard analytics widget summarising denials by payer for the CURRENT MONTH
// (Requirement 10.5). Fetches the aggregation from GET /api/analytics and
// renders it as a horizontal Recharts bar chart, one bar per payer, descending
// by denial count. A compact header reports the current-month total.
// =============================================================================

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AnalyticsResponse } from "@/app/api/analytics/route";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: AnalyticsResponse };

/** Bar colour drawn from the theme primary token. */
const BAR_COLOR = "hsl(var(--primary))";

/** Format an ISO month-start as e.g. "March 2026" for the widget header. */
function formatMonth(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function DenialsByPayerWidget() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/analytics", { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to load analytics (${res.status})`);
        const data = (await res.json()) as AnalyticsResponse;
        if (!cancelled) setState({ kind: "ready", data });
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

  return (
    <section
      aria-label="Denials by payer this month"
      className="rounded-lg border border-border bg-card p-4 shadow-sm"
    >
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-foreground">
          Denials by payer
        </h2>
        {state.kind === "ready" ? (
          <span className="text-xs text-muted-foreground">
            {state.data.totalDenialsThisMonth} this month ·{" "}
            {formatMonth(state.data.monthStart)}
          </span>
        ) : null}
      </div>

      {state.kind === "loading" ? (
        <div className="flex h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading analytics…
        </div>
      ) : state.kind === "error" ? (
        <div className="flex h-56 items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 px-4 text-center text-sm text-destructive">
          {state.message}
        </div>
      ) : state.data.denialsByPayer.length === 0 ? (
        <div className="flex h-56 items-center justify-center text-center text-sm text-muted-foreground">
          No denials recorded this month.
        </div>
      ) : (
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={state.data.denialsByPayer}
              layout="vertical"
              margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                horizontal={false}
                stroke="hsl(var(--border))"
              />
              <XAxis
                type="number"
                allowDecimals={false}
                tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                stroke="hsl(var(--border))"
              />
              <YAxis
                type="category"
                dataKey="payerName"
                width={120}
                tick={{ fontSize: 12, fill: "hsl(var(--foreground))" }}
                stroke="hsl(var(--border))"
              />
              <Tooltip
                cursor={{ fill: "hsl(var(--muted))" }}
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "0.5rem",
                  fontSize: "0.75rem",
                  color: "hsl(var(--popover-foreground))",
                }}
                formatter={(value: number) => [`${value} denials`, "Denials"]}
              />
              <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={28}>
                {state.data.denialsByPayer.map((bucket) => (
                  <Cell key={bucket.payerName} fill={BAR_COLOR} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
