// =============================================================================
// app/case/[id]/page.tsx
//
// Case Detail screen (Requirement 13). A thin server component that hands the
// Case id to the client-side CaseDetailView, which fetches the full Case detail
// from GET /api/cases/[id] and composes the three panels — case-facts, live
// agent trace (polls /trace every 1s while Investigating), and the human action
// zone (recommendation, actions, appeal preview/download, and — for AppealSent
// cases — the Appeal Won / Appeal Denied outcome controls).
//
// The data-fetching, 1-second trace polling, and action wiring all live in the
// client component; this page only resolves the route param.
// =============================================================================

import { CaseDetailView } from "@/components/case/case-detail-view";

export const dynamic = "force-dynamic";

export default function CaseDetailPage({
  params,
}: {
  params: { id: string };
}) {
  return <CaseDetailView caseId={params.id} />;
}
