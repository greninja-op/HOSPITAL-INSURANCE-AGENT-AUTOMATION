// =============================================================================
// app/case/[id]/audit/page.tsx
//
// Audit Trail page for a Case (Requirement 9). Presents the complete
// chronological Audit_Trail merging the Case's Extracted_Field records,
// Trace_Step records, and human actions (Req 9.3), an "Export PDF" control that
// downloads the full Audit_Trail (Req 9.4), and a "Verify audit chain" control
// that reports whether the tamper-evident Audit_Chain is intact (Req 25.4–25.7).
//
// This is a thin server component: it lays out the header and back-link, then
// delegates data loading and rendering to the client `AuditTrail` component,
// which fetches GET /api/cases/[id].
// =============================================================================

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AuditTrail } from "@/components/audit/audit-trail";

export const metadata = {
  title: "Audit Trail · AuthPilot",
};

export default function CaseAuditPage({
  params,
}: {
  params: { id: string };
}) {
  const { id } = params;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <Link
          href={`/case/${id}`}
          className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to case
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit Trail</h1>
          <p className="text-sm text-muted-foreground">
            Complete chronological record of extracted fields, agent trace steps,
            and human actions for case{" "}
            <span className="font-mono text-foreground">#{id.slice(0, 8)}</span>.
          </p>
        </div>
      </div>

      <AuditTrail caseId={id} />
    </div>
  );
}
