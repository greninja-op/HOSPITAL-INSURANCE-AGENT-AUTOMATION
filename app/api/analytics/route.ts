// =============================================================================
// app/api/analytics/route.ts
//
// GET /api/analytics — denial-intelligence data for the Dashboard analytics
// widget and the Analytics_Page.
//
// Returns two views:
//   1. denialsByPayer — a denials-by-payer aggregation for the CURRENT MONTH,
//      grouping every Case that has a denial reason by its Case payer reference
//      (`Case.payerName`). Cases whose payer reference is unset fall into a
//      single "Unknown payer" bucket, so the grouped totals sum to the number
//      of current-month Cases that have a denial reason (Requirements 10.5,
//      14.1).
//   2. atRisk — the list of unresolved Cases nearing their SLA_Clock deadline,
//      computed with `isAtRisk(slaDeadline, now)` from `lib/sla.ts`
//      (Requirements 12.3, 12.4, 14.4).
//
// Uses the shared Prisma client (`lib/db.ts`) so we reuse the single connection
// pool. Runs on the Node.js runtime because Prisma is not edge-compatible.
// =============================================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isAtRisk } from "@/lib/sla";
import type { CaseStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bucket label used when a Case has no resolved payer reference. */
const UNKNOWN_PAYER_BUCKET = "Unknown payer";

/** One payer's denial breakdown within the current month. */
export interface DenialsByPayerBucket {
  /** Payer name, or "Unknown payer" for Cases with an unset payer reference. */
  payerName: string;
  /** Total current-month Cases with a denial reason for this payer. */
  count: number;
  /** Per-denial-reason counts for this payer, descending by count. */
  reasons: { reason: string; count: number }[];
}

/** An unresolved Case flagged as nearing its SLA_Clock deadline. */
export interface AtRiskCase {
  id: string;
  status: CaseStatus;
  payerName: string | null;
  patientName: string | null;
  denialReason: string | null;
  isUrgent: boolean;
  slaDeadline: string;
}

export interface AnalyticsResponse {
  /** Start of the current calendar month (inclusive) used for the aggregation. */
  monthStart: string;
  /** Denials-by-payer buckets for the current month, descending by count. */
  denialsByPayer: DenialsByPayerBucket[];
  /** Total current-month Cases with a denial reason (sum of bucket counts). */
  totalDenialsThisMonth: number;
  /** Unresolved Cases nearing their SLA deadline, soonest deadline first. */
  atRisk: AtRiskCase[];
}

/** Case_Status values that represent an unresolved (still-open) Case. */
const UNRESOLVED_STATUSES: CaseStatus[] = [
  "New",
  "Investigating",
  "NeedsHumanInput",
  "AwaitingApproval",
  "AppealSent",
];

export async function GET(): Promise<NextResponse<AnalyticsResponse>> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // --- Denials-by-payer for the current month (Req 10.5, 14.1) ---------------
  const denialCases = await prisma.case.findMany({
    where: {
      denialReason: { not: null },
      createdAt: { gte: monthStart },
    },
    select: { payerName: true, denialReason: true },
  });

  const buckets = new Map<string, Map<string, number>>();
  for (const c of denialCases) {
    const payerKey = c.payerName ?? UNKNOWN_PAYER_BUCKET;
    const reason = c.denialReason ?? "Unknown reason";
    const reasonCounts = buckets.get(payerKey) ?? new Map<string, number>();
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    buckets.set(payerKey, reasonCounts);
  }

  const denialsByPayer: DenialsByPayerBucket[] = Array.from(buckets.entries())
    .map(([payerName, reasonCounts]) => {
      const reasons = Array.from(reasonCounts.entries())
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count);
      const count = reasons.reduce((sum, r) => sum + r.count, 0);
      return { payerName, count, reasons };
    })
    .sort((a, b) => b.count - a.count);

  const totalDenialsThisMonth = denialCases.length;

  // --- At-risk list (Req 12.3, 12.4, 14.4) -----------------------------------
  const openCases = await prisma.case.findMany({
    where: { status: { in: UNRESOLVED_STATUSES } },
    orderBy: { slaDeadline: "asc" },
    select: {
      id: true,
      status: true,
      payerName: true,
      denialReason: true,
      isUrgent: true,
      slaDeadline: true,
      patient: { select: { name: true } },
    },
  });

  const atRisk: AtRiskCase[] = openCases
    .filter((c) => isAtRisk(c.slaDeadline, now))
    .map((c) => ({
      id: c.id,
      status: c.status as CaseStatus,
      payerName: c.payerName,
      patientName: c.patient?.name ?? null,
      denialReason: c.denialReason,
      isUrgent: c.isUrgent,
      slaDeadline: c.slaDeadline.toISOString(),
    }));

  return NextResponse.json({
    monthStart: monthStart.toISOString(),
    denialsByPayer,
    totalDenialsThisMonth,
    atRisk,
  });
}
