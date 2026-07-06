// =============================================================================
// lib/caseActions.ts
//
// THE single shared implementation of "what happens when a case is approved,
// rejected, edited, or sent back for more evidence."
//
// Both callers MUST import and call this function — do NOT duplicate the logic:
//   - the dashboard's  POST /api/cases/[id]/action  route handler
//   - the WhatsApp webhook's staff command handler (Approve <id> / Reject <id>)
//
// This is also the ONLY place that writes `human_action` TraceStep rows for
// these transitions, so the two channels can never drift or double-log.
//
// Reference file for the whatsapp-integration package. Once the Next.js app is
// scaffolded, move this to `lib/caseActions.ts`; the imports below (@/lib/*) then
// resolve against the real modules.
// =============================================================================

import { prisma } from "@/lib/prisma";
import { runAgentPipeline } from "@/lib/agentRunner";
import { generateAppealPdf } from "@/lib/agentTools";
import { submitAppeal } from "@/lib/submission"; // the brief's (simulated) Submission stage
import { notifyStaffVerificationFlag } from "@/lib/whatsapp/notifications";

export type CaseActionType = "approve" | "reject" | "edit" | "request_more_evidence";

export interface CaseActionMeta {
  source: "dashboard" | "whatsapp";
  actor: string; // user id (dashboard) or phone number (whatsapp)
  editPayload?: Record<string, unknown>; // only used when actionType === "edit"
  additionalEvidenceText?: string; // only used when actionType === "request_more_evidence"
}

export interface CaseActionResult {
  success: boolean;
  newStatus: string;
  message: string; // human-readable — suitable for a toast OR a WhatsApp reply
  pdfUrl?: string; // populated on approve, if a new/updated PDF was generated
}

/**
 * Perform a human case action. Never throws: any DB failure is caught and
 * returned as `{ success: false, ... }` so both callers can degrade gracefully.
 */
export async function performCaseAction(
  caseId: string,
  actionType: CaseActionType,
  meta: CaseActionMeta,
): Promise<CaseActionResult> {
  try {
    const c = await prisma.case.findUnique({ where: { id: caseId } });
    if (!c) {
      return { success: false, newStatus: "", message: "Case not found." };
    }

    switch (actionType) {
      case "approve": {
        // Generate the appeal PDF now if one doesn't already exist.
        let pdfUrl: string | undefined = c.appealPdfUrl ?? undefined;
        if (!pdfUrl) {
          const generated = await generateAppealPdf(caseId, (c.recommendation as any)?.appealContent);
          pdfUrl = generated?.url;
        }

        await prisma.case.update({
          where: { id: caseId },
          data: { status: "AppealSent", appealPdfUrl: pdfUrl ?? c.appealPdfUrl },
        });

        // Invoke the existing (simulated) submission step — do not reimplement.
        await submitAppeal(caseId);

        await prisma.traceStep.create({
          data: {
            caseId,
            stepType: "human_action",
            reasoning: `Approved by ${meta.actor} via ${meta.source}`,
          },
        });

        return {
          success: true,
          newStatus: "AppealSent",
          message: "Case approved and appeal sent.",
          pdfUrl,
        };
      }

      case "reject": {
        await prisma.case.update({
          where: { id: caseId },
          data: { status: "NeedsHumanInput" },
        });

        await prisma.traceStep.create({
          data: {
            caseId,
            stepType: "human_action",
            reasoning: `Rejected by ${meta.actor} via ${meta.source}`,
          },
        });

        await notifyStaffVerificationFlag(caseId, "Case rejected — needs manual attention.").catch(
          () => {},
        );

        return {
          success: true,
          newStatus: "NeedsHumanInput",
          message: "Case rejected and moved to manual review.",
        };
      }

      case "edit": {
        // Edits are dashboard-only — mirrors the webhook's no-free-text-edits guardrail.
        if (meta.source === "whatsapp") {
          return {
            success: false,
            newStatus: c.status,
            message: "Edits must be made in the dashboard.",
          };
        }

        const merged = { ...((c.recommendation as Record<string, unknown>) ?? {}), ...(meta.editPayload ?? {}) };
        await prisma.case.update({
          where: { id: caseId },
          data: { recommendation: merged as any },
        });

        await prisma.traceStep.create({
          data: {
            caseId,
            stepType: "human_action",
            reasoning: `Recommendation edited by ${meta.actor}`,
          },
        });

        // An edit does not advance the case — the human must still explicitly approve.
        return { success: true, newStatus: c.status, message: "Recommendation updated." };
      }

      case "request_more_evidence": {
        await prisma.extractedField.create({
          data: {
            caseId,
            fieldName: "additional_evidence",
            value: meta.additionalEvidenceText ?? "",
            confidence: 100,
            sourceType: "human_provided",
            reasoning: `Additional evidence provided by ${meta.actor} via ${meta.source}`,
          },
        });

        await prisma.case.update({
          where: { id: caseId },
          data: { status: "Investigating" },
        });

        await prisma.traceStep.create({
          data: {
            caseId,
            stepType: "human_action",
            reasoning: `Additional evidence provided by ${meta.actor}, re-running pipeline.`,
          },
        });

        // Fire-and-forget — the pipeline updates status/trace as it completes,
        // same pattern as initial case creation.
        runAgentPipeline(caseId).catch((err) =>
          console.error(`Re-run pipeline failed for case ${caseId}:`, err),
        );

        return {
          success: true,
          newStatus: "Investigating",
          message: "Additional evidence submitted, re-evaluating case.",
        };
      }

      default: {
        return { success: false, newStatus: c.status, message: `Unknown action: ${actionType}` };
      }
    }
  } catch (err) {
    console.error(`performCaseAction failed for case ${caseId} (${actionType}):`, err);
    return {
      success: false,
      newStatus: "",
      message: "Something went wrong performing that action. Please try again.",
    };
  }
}
