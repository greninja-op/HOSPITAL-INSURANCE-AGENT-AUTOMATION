// =============================================================================
// app/api/cases/[id]/action/route.ts
//
// POST /api/cases/[id]/action — the single validated handler behind EVERY
// Case-mutating operator action taken from the Dashboard (Requirements 8, 24,
// 26, 28, 40).
//
// Two families of action flow through here:
//
//   1. The four Human_Action types — approve | reject | edit |
//      request_more_evidence — are delegated verbatim to the shared
//      `performCaseAction` operation (`lib/caseActions.ts`) with
//      `meta.source: "dashboard"`. The route holds NO case-action logic of its
//      own and is NOT the writer of the `human_action` Trace_Step for these
//      transitions (Req 8.10, 40.1–40.3); it merely maps the structured
//      `CaseActionResult` to the HTTP response.
//
//   2. The two Case_Outcome types — appeal_won | appeal_denied — record the
//      terminal outcome of a submitted appeal for a Case in status
//      "AppealSent": appeal_won → Resolved, appeal_denied → DeniedFinal
//      (Requirement 24). These are dashboard outcome recordings, NOT part of
//      `performCaseAction`'s four types, so the route owns them here.
//
// Every Case_Status change is validated through `assertTransition`
// (`lib/caseStatus.ts`, Req 28) and every mutating effect is wrapped in
// `withIdempotency(key, …)` (`lib/idempotency.ts`, Req 26) so a retried request
// applies its effect at most once and replays the stored original result.
//
// The handler NEVER leaks a thrown error: any unexpected fault is caught and
// returned as a structured `{ success: false, newStatus, message }` body.
//
// Runs on the Node.js runtime because Prisma is not edge-safe.
// =============================================================================

import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { performCaseAction } from "@/lib/caseActions";
import { assertTransition } from "@/lib/caseStatus";
import { withIdempotency } from "@/lib/idempotency";
import type {
  CaseActionResult,
  CaseActionType,
  CaseStatus,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── Action taxonomy ─────────────────────────────────────────────────────────

/** The four shared Human_Action types delegated to `performCaseAction`. */
const SHARED_ACTIONS: readonly CaseActionType[] = [
  "approve",
  "reject",
  "edit",
  "request_more_evidence",
] as const;

/** The two Case_Outcome types recorded by this route (Requirement 24). */
const OUTCOME_ACTIONS = ["appeal_won", "appeal_denied"] as const;
type OutcomeAction = (typeof OUTCOME_ACTIONS)[number];

/** Every action value this route accepts. */
const ALL_ACTIONS: readonly string[] = [...SHARED_ACTIONS, ...OUTCOME_ACTIONS];

function isSharedAction(value: string): value is CaseActionType {
  return (SHARED_ACTIONS as readonly string[]).includes(value);
}

function isOutcomeAction(value: string): value is OutcomeAction {
  return (OUTCOME_ACTIONS as readonly string[]).includes(value);
}

/** Terminal status each Case_Outcome action transitions the Case to. */
const OUTCOME_TARGET: Record<OutcomeAction, CaseStatus> = {
  appeal_won: "Resolved",
  appeal_denied: "DeniedFinal",
};

// ─── Request payload ─────────────────────────────────────────────────────────

/**
 * Accepted JSON body. `action` is validated separately (against the full action
 * taxonomy) so an unknown action yields a 400 with a taxonomy-identifying
 * message rather than a generic schema error. The optional `idempotencyKey`
 * body field is the documented fallback for the `Idempotency-Key` header.
 */
const bodySchema = z.object({
  action: z.string().min(1, "action is required"),
  reason: z.string().optional(),
  editedRecommendation: z.unknown().optional(),
  additionalEvidence: z.string().optional(),
  actor: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

/** Structured error body returned for protocol-level failures. */
interface ErrorBody {
  success: false;
  message: string;
}

const NO_STATUS = "" as unknown as CaseStatus;

// ─── Handler ──────────────────────────────────────────────────────────────

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse<CaseActionResult | ErrorBody>> {
  const caseId = params.id;

  try {
    // ── Parse + validate the payload (400 on malformed body) ────────────────
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, message: "Request body must be valid JSON." },
        { status: 400 },
      );
    }

    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ?? "Malformed request payload.";
      return NextResponse.json({ success: false, message }, { status: 400 });
    }
    const body = parsed.data;

    // ── Validate the action value (400 on unknown action) ───────────────────
    if (!ALL_ACTIONS.includes(body.action)) {
      return NextResponse.json(
        {
          success: false,
          message: `Unknown action "${body.action}". Expected one of: ${ALL_ACTIONS.join(
            ", ",
          )}.`,
        },
        { status: 400 },
      );
    }

    // ── Idempotency key: header first, then body fallback (Req 26.1) ─────────
    const idempotencyKey =
      request.headers.get("Idempotency-Key")?.trim() ||
      body.idempotencyKey?.trim() ||
      "";
    if (!idempotencyKey) {
      return NextResponse.json(
        {
          success: false,
          message:
            "A client-supplied Idempotency-Key is required for this action.",
        },
        { status: 400 },
      );
    }

    // ── Resolve the acting operator (header, then body, then default) ────────
    const actor =
      request.headers.get("X-Actor")?.trim() ||
      body.actor?.trim() ||
      "dashboard-operator";

    // ── 404 when the Case does not exist ─────────────────────────────────────
    const kase = await prisma.case.findUnique({
      where: { id: caseId },
      select: { id: true, status: true },
    });
    if (!kase) {
      return NextResponse.json(
        { success: false, message: `Case "${caseId}" not found.` },
        { status: 404 },
      );
    }

    // ── (1) Shared Human_Action types → delegate to performCaseAction ────────
    // The route contains no action logic and is not the writer of the
    // human_action Trace_Step for these four transitions (Req 8.10, 40.1–40.3).
    if (isSharedAction(body.action)) {
      const result = await performCaseAction(caseId, body.action, {
        source: "dashboard",
        actor,
        reason: body.reason,
        editedRecommendation: body.editedRecommendation,
        additionalEvidence: body.additionalEvidence,
        idempotencyKey,
      });
      // Map the structured CaseActionResult straight to the response body.
      return NextResponse.json(result);
    }

    // ── (2) Case_Outcome recording (Requirement 24) ─────────────────────────
    const outcome = body.action as OutcomeAction;
    const result = await recordOutcome(caseId, outcome, actor, idempotencyKey);
    return NextResponse.json(result);
  } catch (err) {
    // No thrown error ever leaks — return a structured failure (Req 40.4-style).
    console.error(
      `[action route] Unexpected error for case ${caseId}:`,
      err,
    );
    return NextResponse.json(
      {
        success: false,
        message: "Something went wrong performing that action. Please try again.",
      },
      { status: 500 },
    );
  }
}

// ─── Case_Outcome recording (Requirement 24) ─────────────────────────────────

/**
 * Record a Case_Outcome (appeal_won / appeal_denied) for a Case in status
 * "AppealSent". Sets the terminal status, stamps `resolvedAt` with the
 * processing timestamp, and writes a single `human_action` Trace_Step — all in
 * ONE transaction so a persistence fault rolls back all three effects
 * (Req 24.2, 24.3, 24.5). Rejects the action when the Case is not in status
 * "AppealSent", leaving status and `resolvedAt` unchanged and writing no
 * Trace_Step (Req 24.4). The whole mutating effect is applied at most once via
 * `withIdempotency` (Req 26) and the status change flows through
 * `assertTransition` (Req 28).
 */
async function recordOutcome(
  caseId: string,
  outcome: OutcomeAction,
  actor: string,
  idempotencyKey: string,
): Promise<CaseActionResult> {
  // Re-read the current status inside the recording path so the guard and the
  // transition decision act on the freshest value.
  const kase = await prisma.case.findUnique({
    where: { id: caseId },
    select: { status: true },
  });
  if (!kase) {
    return { success: false, newStatus: NO_STATUS, message: `Case "${caseId}" not found.` };
  }

  const currentStatus = kase.status as CaseStatus;

  // Outcome guard: only valid from AppealSent (Req 24.1, 24.4). Leave status /
  // resolvedAt unchanged and record no Trace_Step.
  if (currentStatus !== "AppealSent") {
    return {
      success: false,
      newStatus: currentStatus,
      message:
        'The Case must be in status "AppealSent" for a Case_Outcome action to proceed.',
    };
  }

  const target = OUTCOME_TARGET[outcome];

  // Validate the transition through the state machine (Req 28). From AppealSent
  // both Resolved and DeniedFinal are legal; guard defensively regardless.
  const transition = assertTransition(currentStatus, target);
  if (!transition.ok) {
    return {
      success: false,
      newStatus: currentStatus,
      message:
        transition.message ??
        `Cannot record ${outcome} from status ${currentStatus}.`,
    };
  }

  try {
    // Apply the whole effect at most once (Req 26). The inner transaction makes
    // the status change, the resolvedAt stamp, and the Trace_Step atomic
    // (Req 24.5): if any write fails they all roll back.
    return await withIdempotency<CaseActionResult>(
      idempotencyKey,
      caseId,
      outcome,
      async () => {
        // Timestamp captured at the moment the action is processed (Req 24.2/24.3).
        const resolvedAt = new Date();

        await prisma.$transaction([
          prisma.case.update({
            where: { id: caseId },
            data: { status: target, resolvedAt },
          }),
          prisma.traceStep.create({
            data: {
              caseId,
              stepType: "human_action",
              toolName: null,
              reasoning: `Case_Outcome ${outcome} recorded by ${actor} via dashboard; case ${target}.`,
              output: {
                action: outcome,
                source: "dashboard",
                actor,
                newStatus: target,
              },
              prevHash: "",
              hash: "",
            },
          }),
        ]);

        return {
          success: true,
          newStatus: target,
          message:
            outcome === "appeal_won"
              ? "Appeal won recorded; case resolved."
              : "Appeal denied recorded; case marked denied final.",
        };
      },
    );
  } catch (err) {
    // Atomicity fault (Req 24.5): the transaction rolled back, so the Case
    // retains AppealSent with its prior resolvedAt. Report a structured failure.
    console.error(
      `[action route] Failed to record outcome ${outcome} for case ${caseId}:`,
      err,
    );
    return {
      success: false,
      newStatus: currentStatus,
      message: "The outcome could not be recorded. Please try again.",
    };
  }
}
