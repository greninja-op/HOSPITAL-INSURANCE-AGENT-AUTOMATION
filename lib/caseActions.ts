// =============================================================================
// lib/caseActions.ts
//
// Shared_Case_Action — the SINGLE implementation of the four operator actions
// (approve, reject, edit, request_more_evidence) invoked by BOTH callers
// (Requirement 40):
//
//   • the Dashboard action route  `POST /api/cases/[id]/action`  (task 15.1)
//   • the WhatsApp staff-command handler `lib/whatsapp/router.ts` (task 26.11)
//
// The two channels differ ONLY in the `meta.source` they pass ("dashboard" |
// "whatsapp"). Neither contains its own copy of this logic, so they can never
// drift or double-log (Req 40.1, 40.2).
//
// This module is also the SOLE writer of the `human_action` Trace_Step for
// these four transitions, regardless of channel (Req 8.10, 40.3), and it
// records `meta.source` as the channel source (Req 8.8).
//
// NO-THROW CONTRACT (Req 40.4): the whole body runs under a guard that converts
// any thrown persistence / tool error into a structured
// `{ success: false, newStatus: <unchanged>, message }` result — an exception
// never propagates to either caller.
//
// Every Case_Status change is applied through `assertTransition` (Req 28) and
// wrapped in `withIdempotency(meta.idempotencyKey, …)` (Req 26) so a legal
// transition takes effect AT MOST ONCE across retries / redeliveries
// (Req 40.10, 8.9).
// =============================================================================

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma, isValidStepType } from "./db";
import { assertTransition as defaultAssertTransition } from "./caseStatus";
import { withIdempotency as defaultWithIdempotency } from "./idempotency";
import { runAgent as defaultRunAgent } from "./agentRunner";
import { generateAppealPdf as defaultGenerateAppealPdf } from "./appealPdf";
import type {
  AppealContent,
  CaseActionMeta,
  CaseActionResult,
  CaseActionType,
  CaseStatus,
  Recommendation,
} from "./types";

// ─── Injectable dependencies (defaults wire the real app modules) ─────────────
//
// Declaring the collaborators as an injectable bag keeps `performCaseAction`
// unit-testable without a live network / Qwen client (mirrors the DI style used
// by `runStage` and `withIdempotency`). Production callers pass nothing and get
// the real Prisma client, state machine, idempotency store, Agent_Runner, and
// Appeal_Packet generator.

/** The simulated Submission_And_Tracking step (Req 8.7, 40.5). */
export type SubmitAppealFn = (caseId: string) => Promise<void>;

/** Send a staff manual-review notification on the WhatsApp_Channel (Req 40.6). */
export type NotifyStaffManualReviewFn = (
  caseId: string,
  message: string,
) => Promise<void>;

/** Collaborators for `performCaseAction`; each defaults to the real module. */
export interface CaseActionDeps {
  prisma?: PrismaClient;
  assertTransition?: typeof defaultAssertTransition;
  withIdempotency?: typeof defaultWithIdempotency;
  runAgent?: typeof defaultRunAgent;
  generateAppealPdf?: typeof defaultGenerateAppealPdf;
  /** Simulated send — never transmits to any external system (Req 8.7). */
  submitAppeal?: SubmitAppealFn;
  /** Best-effort staff manual-review notification for reject (Req 40.6). */
  notifyStaffManualReview?: NotifyStaffManualReviewFn;
}

interface ResolvedDeps {
  prisma: PrismaClient;
  assertTransition: typeof defaultAssertTransition;
  withIdempotency: typeof defaultWithIdempotency;
  runAgent: typeof defaultRunAgent;
  generateAppealPdf: typeof defaultGenerateAppealPdf;
  submitAppeal: SubmitAppealFn;
  notifyStaffManualReview: NotifyStaffManualReviewFn;
}

/**
 * Default simulated Submission_And_Tracking step. AuthPilot never transmits to
 * an external payer system (Req 8.7); this simulated send is a no-op placeholder
 * the SLA tracker / stage 9 build on. Injectable so callers/tests can observe it.
 */
const defaultSubmitAppeal: SubmitAppealFn = async (caseId: string) => {
  console.info(`[caseActions] Simulated Submission_And_Tracking for case ${caseId}.`);
};

/**
 * Default staff manual-review notifier. The real WhatsApp staff-notification
 * wiring is injected by the composition root (task 26.14); the default is a
 * best-effort log so the shared action stays self-contained and never throws.
 */
const defaultNotifyStaffManualReview: NotifyStaffManualReviewFn = async (
  caseId: string,
  message: string,
) => {
  console.info(`[caseActions] Staff manual-review notification for case ${caseId}: ${message}`);
};

function resolveDeps(deps: CaseActionDeps): ResolvedDeps {
  return {
    prisma: deps.prisma ?? defaultPrisma,
    assertTransition: deps.assertTransition ?? defaultAssertTransition,
    withIdempotency: deps.withIdempotency ?? defaultWithIdempotency,
    runAgent: deps.runAgent ?? defaultRunAgent,
    generateAppealPdf: deps.generateAppealPdf ?? defaultGenerateAppealPdf,
    submitAppeal: deps.submitAppeal ?? defaultSubmitAppeal,
    notifyStaffManualReview:
      deps.notifyStaffManualReview ?? defaultNotifyStaffManualReview,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Placeholder status for the genuinely status-less failure paths (Case not
 * found, or an error thrown before any Case status was observed). There is no
 * real Case_Status to report, so this documents the "unknown/unchanged" intent
 * while satisfying the `CaseActionResult.newStatus: CaseStatus` contract.
 */
const NO_STATUS = "" as unknown as CaseStatus;

/** Build a structured failure/refusal result (never throws — Req 40.4). */
function refusal(message: string, newStatus: CaseStatus): CaseActionResult {
  return { success: false, newStatus, message };
}

/**
 * Coerce a stored Case `recommendation` JSON into a renderable `AppealContent`
 * for `generateAppealPdf`, filling blanks so the generator (which placeholders
 * empty fields) always receives a well-formed value.
 */
function toAppealContent(
  recommendation: unknown,
  patientName: string,
  denialReason: string,
): AppealContent {
  const rec = (recommendation ?? {}) as Partial<Recommendation>;
  const existing = rec.appealContent;
  if (existing && typeof existing === "object") {
    return {
      patientName: existing.patientName || patientName,
      denialReason: existing.denialReason || denialReason,
      policyClause: existing.policyClause ?? "",
      supportingEvidence: Array.isArray(existing.supportingEvidence)
        ? existing.supportingEvidence
        : [],
      argument: existing.argument ?? "",
    };
  }
  return {
    patientName,
    denialReason,
    policyClause: "",
    supportingEvidence: [],
    argument: typeof rec.reason === "string" ? rec.reason : "",
  };
}

/**
 * Write the single `human_action` Trace_Step for a transition. This module is
 * the SOLE writer of `human_action` Trace_Steps for these four actions
 * (Req 8.10, 40.3); `meta.source` is recorded as the channel source (Req 8.8).
 */
async function writeHumanAction(
  prisma: PrismaClient,
  caseId: string,
  meta: CaseActionMeta,
  actionType: CaseActionType,
  reasoning: string,
): Promise<void> {
  // "human_action" is one of the seven allowed Trace_Step types; assert it here
  // so the sole-writer stays consistent with the createTraceStep guard (Req 23.3).
  const stepType = "human_action";
  if (!isValidStepType(stepType)) return;

  await prisma.traceStep.create({
    data: {
      caseId,
      stepType,
      toolName: null,
      reasoning,
      output: {
        action: actionType,
        source: meta.source, // channel source: "dashboard" | "whatsapp" (Req 8.8)
        actor: meta.actor,
        ...(meta.reason ? { reason: meta.reason } : {}),
      },
      prevHash: "",
      hash: "",
    },
  });
}

// ─── The shared action ────────────────────────────────────────────────────

/**
 * Perform a human Case action (approve / reject / edit / request_more_evidence).
 *
 * Never throws (Req 40.4): any refusal or thrown persistence/tool error is
 * returned as `{ success: false, newStatus: <unchanged>, message }`. Every
 * status change flows through `assertTransition` (Req 28) and the whole mutating
 * effect is applied at most once via `withIdempotency(meta.idempotencyKey, …)`
 * (Req 26, 40.10).
 *
 * @param caseId     The Case to act on.
 * @param actionType One of approve | reject | edit | request_more_evidence.
 * @param meta       Channel source, actor, idempotency key, and action payload.
 * @param deps       Injectable collaborators (default to the real app modules).
 */
export async function performCaseAction(
  caseId: string,
  actionType: CaseActionType,
  meta: CaseActionMeta,
  deps: CaseActionDeps = {},
): Promise<CaseActionResult> {
  const d = resolveDeps(deps);
  let observedStatus: CaseStatus | undefined;

  try {
    const kase = await d.prisma.case.findUnique({
      where: { id: caseId },
      include: { patient: { select: { name: true } } },
    });
    if (!kase) {
      return refusal("Case not found.", NO_STATUS);
    }
    const currentStatus = kase.status as CaseStatus;
    observedStatus = currentStatus;

    switch (actionType) {
      // ── approve (Req 40.5, 8.2, 8.7) ───────────────────────────────────────
      case "approve": {
        const transition = d.assertTransition(currentStatus, "AppealSent");
        if (!transition.ok) {
          return refusal(
            transition.message ?? `Cannot approve from status ${currentStatus}.`,
            currentStatus,
          );
        }

        return d.withIdempotency<CaseActionResult>(
          meta.idempotencyKey,
          caseId,
          "approve",
          async () => {
            // Generate the Appeal_Packet if none exists yet (Req 40.5).
            let pdfUrl: string | undefined = kase.appealPdfUrl ?? undefined;
            if (!pdfUrl) {
              const content = toAppealContent(
                kase.recommendation,
                kase.patient?.name ?? kase.patientNameHint ?? "",
                kase.denialReason ?? "",
              );
              const generated = await d.generateAppealPdf(caseId, content);
              pdfUrl = generated.url;
            }

            // Apply the status change (guarded) and store the PDF location.
            await d.prisma.case.update({
              where: { id: caseId },
              data: { status: "AppealSent", appealPdfUrl: pdfUrl ?? null },
            });

            // Invoke the simulated Submission_And_Tracking step (Req 8.7, 40.5).
            await d.submitAppeal(caseId);

            // Sole writer of the human_action Trace_Step (Req 8.10, 40.3).
            await writeHumanAction(
              d.prisma,
              caseId,
              meta,
              actionType,
              `Approved by ${meta.actor} via ${meta.source}; appeal sent (simulated).`,
            );

            return {
              success: true,
              newStatus: "AppealSent",
              message: "Case approved and appeal sent.",
              ...(pdfUrl ? { pdfUrl } : {}),
            };
          },
          d.prisma,
        );
      }

      // ── reject (Req 40.6, 8.3) ─────────────────────────────────────────────
      case "reject": {
        const transition = d.assertTransition(currentStatus, "NeedsHumanInput");
        if (!transition.ok) {
          return refusal(
            transition.message ?? `Cannot reject from status ${currentStatus}.`,
            currentStatus,
          );
        }

        return d.withIdempotency<CaseActionResult>(
          meta.idempotencyKey,
          caseId,
          "reject",
          async () => {
            await d.prisma.case.update({
              where: { id: caseId },
              data: { status: "NeedsHumanInput" },
            });

            await writeHumanAction(
              d.prisma,
              caseId,
              meta,
              actionType,
              `Rejected by ${meta.actor} via ${meta.source}; moved to manual review.`,
            );

            // Best-effort staff manual-review notification (Req 40.6); a send
            // failure must not fail the action.
            await d
              .notifyStaffManualReview(
                caseId,
                "Case rejected — needs manual attention.",
              )
              .catch((err) =>
                console.error(
                  `[caseActions] staff notification failed for case ${caseId}:`,
                  err,
                ),
              );

            return {
              success: true,
              newStatus: "NeedsHumanInput",
              message: "Case rejected and moved to manual review.",
            };
          },
          d.prisma,
        );
      }

      // ── edit (Req 40.7 dashboard-only, 40.8 whatsapp-refused, 8.4) ─────────
      case "edit": {
        // Req 40.8 — edits over the WhatsApp_Channel are refused; recommendation
        // and Case_Status are left unchanged. No transition, no Trace_Step.
        if (meta.source === "whatsapp") {
          return refusal("Edits must be made in the dashboard.", currentStatus);
        }

        return d.withIdempotency<CaseActionResult>(
          meta.idempotencyKey,
          caseId,
          "edit",
          async () => {
            // Apply the revised recommendation content to the Case (Req 8.4,
            // 40.7). Merge onto the existing recommendation when both are
            // objects; otherwise store the supplied content verbatim.
            const revised = meta.editedRecommendation;
            const existing = kase.recommendation;
            const merged =
              revised && typeof revised === "object" && !Array.isArray(revised)
                ? {
                    ...((existing && typeof existing === "object"
                      ? (existing as Record<string, unknown>)
                      : {}) as Record<string, unknown>),
                    ...(revised as Record<string, unknown>),
                  }
                : (revised ?? existing ?? {});

            await d.prisma.case.update({
              where: { id: caseId },
              // Do NOT change Case_Status (Req 40.7).
              data: { recommendation: merged as object },
            });

            await writeHumanAction(
              d.prisma,
              caseId,
              meta,
              actionType,
              `Recommendation edited by ${meta.actor} via ${meta.source}.`,
            );

            // Status intentionally unchanged (Req 40.7).
            return {
              success: true,
              newStatus: currentStatus,
              message: "Recommendation updated.",
            };
          },
          d.prisma,
        );
      }

      // ── request_more_evidence (Req 40.9, 8.5, 16) ──────────────────────────
      case "request_more_evidence": {
        // NOTE — FSM interaction (Req 28 vs Req 40.9): Req 40.9 sets the Case to
        // "Investigating", but the Req 28 transition table has no direct
        // AwaitingApproval → Investigating edge. The status change is therefore
        // applied through `assertTransition` and persisted ONLY when legal
        // (honoring Req 40.10 / 28); the evidence append, Trace_Step, and
        // fire-and-forget re-run always happen so Req 16 replanning proceeds.
        const transition = d.assertTransition(currentStatus, "Investigating");

        return d.withIdempotency<CaseActionResult>(
          meta.idempotencyKey,
          caseId,
          "request_more_evidence",
          async () => {
            // Append the additional evidence as a human_provided Extracted_Field
            // (Req 40.9, 8.5).
            await d.prisma.extractedField.create({
              data: {
                caseId,
                fieldName: "additional_evidence",
                value: meta.additionalEvidence ?? "",
                confidence: 1,
                sourceType: "human_provided",
                reasoning: `Additional evidence provided by ${meta.actor} via ${meta.source}.`,
              },
            });

            // Apply the guarded status change to Investigating when legal.
            const newStatus: CaseStatus = transition.ok
              ? "Investigating"
              : currentStatus;
            if (transition.ok && !transition.noop) {
              await d.prisma.case.update({
                where: { id: caseId },
                data: { status: "Investigating" },
              });
            }

            await writeHumanAction(
              d.prisma,
              caseId,
              meta,
              actionType,
              `Additional evidence provided by ${meta.actor} via ${meta.source}; re-running the Agent_Runner.`,
            );

            // Fire-and-forget re-run with the new context (Req 16). Not awaited;
            // the pipeline updates status/trace as it completes. Guarded so a
            // re-run failure never rejects this action.
            void d
              .runAgent(caseId, meta.additionalEvidence)
              .catch((err) =>
                console.error(
                  `[caseActions] re-run pipeline failed for case ${caseId}:`,
                  err,
                ),
              );

            return {
              success: true,
              newStatus,
              message: "Additional evidence submitted; re-evaluating the case.",
            };
          },
          d.prisma,
        );
      }

      default: {
        // Exhaustiveness guard — unknown action type is refused, not thrown.
        return refusal(
          `Unknown action type: ${String(actionType)}`,
          currentStatus,
        );
      }
    }
  } catch (err) {
    // No-throw contract (Req 40.4): any thrown persistence/tool error becomes a
    // structured failure with the status left unchanged.
    console.error(
      `[caseActions] performCaseAction failed for case ${caseId} (${actionType}):`,
      err,
    );
    return refusal(
      "Something went wrong performing that action. Please try again.",
      observedStatus ?? NO_STATUS,
    );
  }
}
