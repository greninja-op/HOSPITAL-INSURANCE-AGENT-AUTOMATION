// =============================================================================
// app/api/cases/[id]/audit/verify/route.ts
//
// GET /api/cases/[id]/audit/verify — verify a Case's tamper-evident Audit_Chain
// (Requirements 25.4–25.7).
//
// Loads the Case's TraceSteps in chronological (chain) order, maps each row to
// the AuditEvent shape verifyAuditChain expects, re-walks the chain to detect
// tampering, and returns the AuditVerifyResult as JSON:
//   { intact, headHash, firstBrokenEventId?, reason? }
//
// Runs on the Node.js runtime because verifyAuditChain hashes with Node's
// built-in `node:crypto` (SHA-256), which is unavailable on the Edge runtime.
// =============================================================================

import { NextResponse } from "next/server";

import { verifyAuditChain, type AuditEvent } from "@/lib/auditChain";
import { prisma } from "@/lib/db";
import type { AuditVerifyResult } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const caseId = params.id;

  // 404 for an unknown Case (Req 25.4 verification targets a specific Case).
  const existingCase = await prisma.case.findUnique({
    where: { id: caseId },
    select: { id: true },
  });

  if (!existingCase) {
    return NextResponse.json(
      { error: `Case "${caseId}" not found.` },
      { status: 404 },
    );
  }

  // Load the Case's audit events in chronological order — verifyAuditChain
  // requires the events in chain order (the caller owns ordering; the module is
  // pure and does no DB access).
  const traceSteps = await prisma.traceStep.findMany({
    where: { caseId },
    orderBy: { timestamp: "asc" },
  });

  // Map each TraceStep row to the AuditEvent shape the verifier hashes over.
  const events: AuditEvent[] = traceSteps.map((step) => ({
    id: step.id,
    prevHash: step.prevHash,
    hash: step.hash,
    stepType: step.stepType,
    toolName: step.toolName,
    input: step.input,
    output: step.output,
    reasoning: step.reasoning,
    beforeState: step.beforeState,
    afterState: step.afterState,
    caseId: step.caseId,
  }));

  const result: AuditVerifyResult = verifyAuditChain(events);

  return NextResponse.json(result);
}
