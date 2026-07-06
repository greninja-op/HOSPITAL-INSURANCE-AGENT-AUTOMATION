// =============================================================================
// app/api/policies/compare/route.ts
//
// GET /api/policies/compare?procedureCode=CPT[&payerId=...&payerId=...]
//
// Multi-payer policy diffing (Requirement 17.1, 17.2): retrieve the matching
// Payer_Policy criteria for a procedure code across payers so an Operator can
// compare payer-specific medical-necessity criteria side by side.
//
//   - `procedureCode` (required) — the CPT procedure code to compare.
//   - `payerId` (optional, repeatable) — restrict the comparison to the given
//     payers. When omitted, every payer with a matching policy is returned.
//
// Responds 400 when `procedureCode` is missing. Uses the shared Prisma client
// (`lib/db.ts`); runs on the Node.js runtime because Prisma is not edge-safe.
// =============================================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One payer's policy criteria for the requested procedure code. */
export interface PolicyComparisonEntry {
  payerId: string;
  payerName: string;
  policyId: string;
  policyCode: string;
  procedureCode: string;
  criteriaText: string;
}

export interface PolicyComparisonResponse {
  procedureCode: string;
  /** Matching policies across payers, one entry per payer policy. */
  policies: PolicyComparisonEntry[];
  /**
   * True when at least two payers were compared and their criteria text is not
   * identical — i.e. there is a meaningful difference to explain (Req 17.2).
   */
  hasDifferences: boolean;
}

export interface ErrorResponse {
  error: string;
}

export async function GET(
  request: Request,
): Promise<NextResponse<PolicyComparisonResponse | ErrorResponse>> {
  const { searchParams } = new URL(request.url);
  const procedureCode = searchParams.get("procedureCode")?.trim();
  const payerIds = searchParams.getAll("payerId").filter((id) => id.length > 0);

  if (!procedureCode) {
    return NextResponse.json(
      { error: "Query parameter 'procedureCode' is required." },
      { status: 400 },
    );
  }

  const found = await prisma.payerPolicy.findMany({
    where: {
      procedureCode,
      ...(payerIds.length > 0 ? { payerId: { in: payerIds } } : {}),
    },
    orderBy: [{ payer: { name: "asc" } }, { policyCode: "asc" }],
    select: {
      id: true,
      policyCode: true,
      procedureCode: true,
      criteriaText: true,
      payerId: true,
      payer: { select: { name: true } },
    },
  });

  const policies: PolicyComparisonEntry[] = found.map((p) => ({
    payerId: p.payerId,
    payerName: p.payer.name,
    policyId: p.id,
    policyCode: p.policyCode,
    procedureCode: p.procedureCode,
    criteriaText: p.criteriaText,
  }));

  // Distinct payers with a matching policy, and whether their criteria differ.
  const distinctPayers = new Set(policies.map((p) => p.payerId));
  const distinctCriteria = new Set(policies.map((p) => p.criteriaText.trim()));
  const hasDifferences = distinctPayers.size >= 2 && distinctCriteria.size > 1;

  return NextResponse.json({
    procedureCode,
    policies,
    hasDifferences,
  });
}
