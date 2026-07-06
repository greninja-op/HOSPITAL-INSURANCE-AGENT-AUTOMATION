/**
 * WhatsApp intent router — maps a normalized inbound message to an AuthPilot action.
 *
 * Two roles, decided by whether the sender's number is a registered staff member:
 *
 *  PATIENT:
 *   - free text / image  -> create a Case (intakeType "whatsapp_patient_note"), run the
 *                           normal nine-stage pipeline; reply with a generic ack template.
 *   - "status" question  -> look up the sender's most recent open Case, reply with a
 *                           GENERIC status template (no PHI). Does NOT re-run the pipeline.
 *
 *  STAFF (the differentiator — approve-from-anywhere):
 *   - "Approve <id>"  -> same effect as the dashboard Approve & Send (Human_Action),
 *                        audit trail records source "whatsapp".
 *   - "Reject <id>"   -> move Case to NeedsHumanInput, log rejection.
 *   - "Status <id|name>" -> one-line status summary (status + confidence + SLA days left).
 *   - "Show <id>"     -> reply with a deep link to the Case Detail page.
 *
 * Every WhatsApp-originated action still writes the same Trace_Step / audit entries as
 * the in-app flow, so the tamper-evident audit chain has no channel-shaped gap.
 *
 * This module is transport-agnostic: it takes ports (actions + sender + lookups) so it
 * can be unit/property-tested with in-memory fakes and no network.
 */
import type { NormalizedInbound } from "./parseInbound";

export type Role = "patient" | "staff";

export interface RouterPorts {
  /** Resolve the role of a WhatsApp sender by phone number. */
  resolveRole(phone: string): Promise<Role>;
  /** Create a Case from an inbound message; returns the new case id. */
  createCaseFromIntake(input: {
    phone: string;
    text: string;
    imageMediaId?: string;
  }): Promise<{ caseId: string }>;
  /** Most recent open Case for a patient phone, or null. */
  latestOpenCaseForPhone(phone: string): Promise<{ caseId: string; status: string } | null>;
  /** Perform a staff Human_Action on a case (source recorded as "whatsapp"). */
  humanAction(input: {
    caseId: string;
    action: "approve" | "reject";
    actorPhone: string;
    idempotencyKey: string;
  }): Promise<{ ok: boolean; message: string }>;
  /** One-line status summary for a case id or patient name. */
  statusSummary(query: string): Promise<string | null>;
  /** Absolute URL to a Case Detail page. */
  caseDetailUrl(caseId: string): string;
}

export interface StaffCommand {
  verb: "approve" | "reject" | "status" | "show";
  arg: string;
}

/** Parse a free-text staff reply like "Approve 114" / "status Jane Doe". Case-insensitive. */
export function parseStaffCommand(body: string): StaffCommand | null {
  const m = /^\s*(approve|reject|status|show)\s+(.+?)\s*$/i.exec(body ?? "");
  if (!m) return null;
  return { verb: m[1].toLowerCase() as StaffCommand["verb"], arg: m[2].trim() };
}

// Generic, PHI-free patient templates (must be pre-approved WhatsApp templates in prod).
export const PATIENT_TEMPLATES = {
  received:
    "We've received your message about your insurance issue and started reviewing it. We'll update you here as soon as we have next steps.",
  statusGeneric:
    "There's an update on your case. Please check your patient portal or call our office for the details.",
  noOpenCase:
    "We don't have an open case for this number right now. If you have a new insurance issue, just describe it here and we'll start one.",
} as const;

export interface RouteResult {
  reply?: string;
  caseId?: string;
  handled: boolean;
}

/**
 * Route one inbound message. The caller (the webhook route) is responsible for dedupe
 * before invoking this, and for actually sending `reply` via the Sender.
 */
export async function routeInbound(
  inbound: NormalizedInbound,
  ports: RouterPorts,
): Promise<RouteResult> {
  const role = await ports.resolveRole(inbound.phone);

  if (role === "staff") {
    const cmd = parseStaffCommand(inbound.body);
    if (!cmd) {
      return { handled: true, reply: "Commands: Approve <id> | Reject <id> | Status <id|name> | Show <id>" };
    }
    switch (cmd.verb) {
      case "approve":
      case "reject": {
        const res = await ports.humanAction({
          caseId: cmd.arg,
          action: cmd.verb,
          actorPhone: inbound.phone,
          // Idempotency key derived from the inbound message id so a redelivery is a no-op.
          idempotencyKey: `wa:${inbound.messageId}`,
        });
        return { handled: true, reply: res.message, caseId: cmd.arg };
      }
      case "status": {
        const summary = await ports.statusSummary(cmd.arg);
        return { handled: true, reply: summary ?? `No case found for "${cmd.arg}".` };
      }
      case "show":
        return { handled: true, reply: ports.caseDetailUrl(cmd.arg) };
    }
  }

  // PATIENT
  const asksStatus = /\b(status|what('| i)?s happening|update|any news)\b/i.test(inbound.body);
  if (asksStatus && !inbound.hasImage) {
    const open = await ports.latestOpenCaseForPhone(inbound.phone);
    if (!open) return { handled: true, reply: PATIENT_TEMPLATES.noOpenCase };
    return { handled: true, caseId: open.caseId, reply: PATIENT_TEMPLATES.statusGeneric };
  }

  // New intake (text and/or image).
  if (inbound.body.trim().length > 0 || inbound.hasImage) {
    const { caseId } = await ports.createCaseFromIntake({
      phone: inbound.phone,
      text: inbound.body,
      imageMediaId: inbound.imageRef,
    });
    return { handled: true, caseId, reply: PATIENT_TEMPLATES.received };
  }

  return { handled: false };
}
