// =============================================================================
// app/api/cases/[id]/route.ts
//
// GET /api/cases/[id] — full Case detail for the Case Detail screen
// (Requirements 13.1–13.4).
//
// Returns the Case together with:
//   - its Extracted_Fields (value, Confidence_Score, source tag) for the
//     case-facts panel (Req 13.1, 13.2),
//   - its Trace_Steps in chronological order for the live agent trace panel
//     (Req 13.3),
//   - the current recommendation, strategy options, and verification result
//     for the human action zone (Req 13.3),
//   - the Appeal_Packet url when one exists (Req 13.4).
//
// Responds 404 when no Case matches the id. Uses the shared Prisma client
// (`lib/db.ts`); runs on the Node.js runtime because Prisma is not edge-safe.
// =============================================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import type {
  CaseStatus,
  Recommendation,
  ResolutionPath,
  SourceType,
  StepType,
  StrategyOptions,
  VerificationResult,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** An Extracted_Field as shown in the case-facts panel. */
export interface ExtractedFieldDetail {
  id: string;
  fieldName: string;
  value: string;
  confidence: number;
  sourceType: SourceType;
  reasoning: string;
  timestamp: string;
}

/** A Trace_Step as shown in the live agent trace panel. */
export interface TraceStepDetail {
  id: string;
  stepType: StepType;
  toolName: string | null;
  input: unknown;
  output: unknown;
  reasoning: string;
  timestamp: string;
}

/** Full Case detail payload for the Case Detail screen. */
export interface CaseDetail {
  id: string;
  status: CaseStatus;
  intakeType: string;
  rawIntakeText: string;
  payerName: string | null;
  isUrgent: boolean;
  slaDeadline: string;
  resolutionPath: ResolutionPath | null;
  overallConfidence: number | null;
  denialReason: string | null;
  requestedEvidence: string | null;
  plainEnglishExplanation: string | null;
  recommendation: Recommendation | null;
  strategyOptions: StrategyOptions | null;
  verificationResult: VerificationResult | null;
  appealPdfUrl: string | null;
  patientName: string | null;
  createdAt: string;
  resolvedAt: string | null;
  extractedFields: ExtractedFieldDetail[];
  traceSteps: TraceStepDetail[];
}

export interface NotFoundResponse {
  error: string;
}

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse<CaseDetail | NotFoundResponse>> {
  const found = await prisma.case.findUnique({
    where: { id: params.id },
    include: {
      patient: { select: { name: true } },
      extractedFields: { orderBy: { timestamp: "asc" } },
      traceSteps: { orderBy: { timestamp: "asc" } },
    },
  });

  if (!found) {
    return NextResponse.json(
      { error: `Case "${params.id}" not found.` },
      { status: 404 },
    );
  }

  const detail: CaseDetail = {
    id: found.id,
    status: found.status as CaseStatus,
    intakeType: found.intakeType,
    rawIntakeText: found.rawIntakeText,
    payerName: found.payerName,
    isUrgent: found.isUrgent,
    slaDeadline: found.slaDeadline.toISOString(),
    resolutionPath: (found.resolutionPath as ResolutionPath | null) ?? null,
    overallConfidence: found.overallConfidence,
    denialReason: found.denialReason,
    requestedEvidence: found.requestedEvidence,
    plainEnglishExplanation: found.plainEnglishExplanation,
    recommendation: (found.recommendation as Recommendation | null) ?? null,
    strategyOptions: (found.strategyOptions as StrategyOptions | null) ?? null,
    verificationResult:
      (found.verificationResult as VerificationResult | null) ?? null,
    appealPdfUrl: found.appealPdfUrl,
    patientName: found.patient?.name ?? null,
    createdAt: found.createdAt.toISOString(),
    resolvedAt: found.resolvedAt ? found.resolvedAt.toISOString() : null,
    extractedFields: found.extractedFields.map((f) => ({
      id: f.id,
      fieldName: f.fieldName,
      value: f.value,
      confidence: f.confidence,
      sourceType: f.sourceType as SourceType,
      reasoning: f.reasoning,
      timestamp: f.timestamp.toISOString(),
    })),
    traceSteps: found.traceSteps.map((t) => ({
      id: t.id,
      stepType: t.stepType as StepType,
      toolName: t.toolName,
      input: t.input ?? null,
      output: t.output ?? null,
      reasoning: t.reasoning,
      timestamp: t.timestamp.toISOString(),
    })),
  };

  return NextResponse.json(detail);
}
