// =============================================================================
// app/analytics/page.tsx
//
// Analytics_Page (Requirement 14). Presents AuthPilot's denial-intelligence:
// the denials-by-payer chart (Req 14.1), the resolution rate (Req 14.2), the
// average time-to-resolution (Req 14.3), and the at-risk list of Cases nearing
// their SLA_Clock deadline (Req 12.4, 14.4).
//
// This is a thin server component that lays out the page header and delegates
// data loading and rendering to the client `AnalyticsView` component.
// =============================================================================

import { AnalyticsView } from "@/components/analytics/analytics-view";

export const metadata = {
  title: "Analytics · AuthPilot",
};

export default function AnalyticsPage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">
          Denial intelligence across every case: denials by payer, resolution
          performance, and the cases most at risk of missing their SLA deadline.
        </p>
      </div>

      <AnalyticsView />
    </div>
  );
}
