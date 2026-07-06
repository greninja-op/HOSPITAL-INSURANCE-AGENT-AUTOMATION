"use client";

// =============================================================================
// components/analytics/denials-by-payer-chart.tsx
//
// Analytics_Page denials-by-payer chart (Requirement 14.1). Renders the
// denials-by-payer aggregation from GET /api/analytics as a horizontal Recharts
// bar chart, one bar per payer, descending by denial count. Cases with an unset
// payer reference arrive pre-bucketed by the API under "Unknown payer", so the
// bar totals sum to the total number of Cases with a denial reason.
// =============================================================================

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
import type { DenialsByPayerBucket } from "@/app/api/analytics/route";

const BAR_COLOR = "hsl(var(--primary))";

interface DenialsByPayerChartProps {
  data: DenialsByPayerBucket[];
}

export function DenialsByPayerChart({ data }: DenialsByPayerChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center text-center text-sm text-muted-foreground">
        No denials recorded this month.
      </div>
    );
  }

  // Give tall charts room per bar so many payers stay readable.
  const height = Math.max(288, data.length * 44);

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 24, bottom: 4, left: 8 }}
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
            width={140}
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
            {data.map((bucket) => (
              <Cell key={bucket.payerName} fill={BAR_COLOR} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
