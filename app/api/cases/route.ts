// =============================================================================
// app/api/cases/route.ts
//
// GET /api/cases — list every Case for the Dashboard Kanban board and the
// denials analytics widget (Requirement 10.1).
//
// Returns a flat list of lightweight Case summaries. The Dashboard groups the
// list by `status` client-side into the seven Case_Status columns (New,
// Investigating, NeedsHumanInput, AwaitingApproval, AppealSent, Resolved,
// DeniedFinal). Each summary carries exactly the fields a Case card needs:
// patient name (for initials), payer, procedure/denial reason, the overall
// Confidence_Score, the urgency flag, and the SLA_Clock deadline.
//
// Uses the shared Prisma client (`lib/db.ts`) so we reuse the single connection
// pool. Runs on the Node.js runtime because Prisma is not edge-compatible.
// =============================================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import type { CaseStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One Case as rendered on a Dashboard Kanban card + denials widget. */
export interface CaseSummary {
  id: string;
  status: CaseStatus;
  payerName: string | null;
  isUrgent: boolean;
  slaDeadline: string;
  overallConfidence: number | null;
  denialReason: string | null;
  /** Patient display name; the client derives initials for the avatar. */
  patientName: string | null;
  createdAt: string;
}

export type ListCasesResponse = CaseSummary[];

export async function GET(): Promise<NextResponse<ListCasesResponse>> {
  const cases = await prisma.case.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      payerName: true,
      isUrgent: true,
      slaDeadline: true,
      overallConfidence: true,
      denialReason: true,
      createdAt: true,
      patient: { select: { name: true } },
    },
  });

  const summaries: ListCasesResponse = cases.map((c) => ({
    id: c.id,
    status: c.status as CaseStatus,
    payerName: c.payerName,
    isUrgent: c.isUrgent,
    slaDeadline: c.slaDeadline.toISOString(),
    overallConfidence: c.overallConfidence,
    denialReason: c.denialReason,
    patientName: c.patient?.name ?? null,
    createdAt: c.createdAt.toISOString(),
  }));

  return NextResponse.json(summaries);
}
