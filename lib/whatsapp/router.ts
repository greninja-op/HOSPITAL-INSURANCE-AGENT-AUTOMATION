// =============================================================================
// lib/whatsapp/router.ts
//
// WhatsApp role-based routing — maps a NormalizedInbound to an AuthPilot action.
//
// Two roles, decided by whether the sender's number is a registered Staff_Number
// (Requirement 34.7):
//
//   PATIENT:
//     - free text / image  -> create a Case (intakeType "whatsapp_patient_note"),
//                             store the message text as the raw Intake, run the
//                             normal nine-stage pipeline (via the createCase port),
//                             and reply with the generic, PHI-free `caseCreated`
//                             acknowledgement template (Requirements 32.1–32.3, 33).
//     - "status" question  -> look up the sender's most recent OPEN Case by phone
//                             and reply with a generic, PHI-free `statusGeneric`
//                             template (or `noOpenCase`) WITHOUT re-running the
//                             pipeline and WITHOUT any case-specific detail
//                             (Requirements 32.4, 32.5, 33.3).
//
//   STAFF (the approve-from-anywhere differentiator):
//     - "Approve <id>" / "Reject <id>" -> delegate to the SHARED
//                             `performCaseAction` operation (lib/caseActions.ts) —
//                             the SAME implementation the Dashboard invokes, never a
//                             channel-local copy — passing `meta.source: "whatsapp"`
//                             and an idempotency key derived from the inbound message
//                             id, so a redelivery is a no-op (Requirements 8.8, 8.9,
//                             34.2, 34.3, 34.6, 34.8, 40.2).
//     - "Status <id|name>" -> one-line summary (status + confidence + SLA days left);
//                             mutates nothing (Requirement 34.4).
//     - "Show <id>"        -> reply with a deep link to the Case Detail page;
//                             mutates nothing (Requirement 34.5).
//
// Transport-agnostic by design: every side effect is performed through injected
// **ports** (create-case, shared-case-action, lookups, sender) so the router is
// unit- and property-testable with in-memory fakes and no live DB or network.
//
// SCOPE — this is the BASE router. The staff free-text action guardrail
// (Requirement 45, task 26.32), the emergency short-circuit / media quality gate
// (Requirements 41/42, tasks 26.22/26.30), the unsupported-type & ambiguous-reply
// handling (Requirements 46/47, task 26.34), the conversational fallback
// (Requirement 44, task 26.35), and multilingual language switching are added by
// LATER tasks. This module leaves clean, optional seams (the extra `RouterPorts`
// members below) for them but implements none of them here.
// =============================================================================

import type { NormalizedInbound } from "./parseInbound";
import type { Sender } from "./sender";
import type { GuardResult } from "../guard";
import type {
  CaseActionMeta,
  CaseActionResult,
  CaseActionType,
  CaseStatus,
} from "../types";

// ─── Roles ────────────────────────────────────────────────────────────────

export type Role = "patient" | "staff";

/**
 * Resolve a WhatsApp sender's role: a registered `Staff_Number` ⇒ "staff",
 * anyone else ⇒ "patient" (Requirement 34.7). Membership is checked against the
 * raw sender id first, then against a digits-only normalization so a stored
 * number with a leading "+" / spaces still matches Meta's digits-only `wa_id`.
 * Total and pure — an empty/unknown number resolves to "patient".
 */
export function resolveRole(
  phone: string,
  staffNumbers: ReadonlySet<string>,
): Role {
  if (!phone) return "patient";
  if (staffNumbers.has(phone)) return "staff";
  const digits = phone.replace(/\D/g, "");
  if (digits && staffNumbers.has(digits)) return "staff";
  return "patient";
}

// ─── Staff command parsing ──────────────────────────────────────────────────

/** A parsed staff command, or `{ kind: "none" }` for anything unrecognized. */
export type StaffCommand =
  | { kind: "approve"; caseId: string }
  | { kind: "reject"; caseId: string; reason?: string }
  | { kind: "status"; query: string } // case-id | patient name
  | { kind: "show"; caseId: string }
  | { kind: "none" };

/** First whitespace-delimited token of `s`, or "" when there is none. */
function firstToken(s: string): string {
  const t = s.trim().split(/\s+/, 1)[0];
  return t ?? "";
}

/**
 * Total parser for the four staff verbs `Approve` / `Reject` / `Status` / `Show`
 * (case-insensitive, Requirement 34.1). Anything that is not a recognized command
 * — including an action verb WITHOUT a case id — yields `{ kind: "none" }` so the
 * caller never guesses or acts on an absent identifier (Requirement 45 seam).
 *
 * `Reject <id> <reason…>` captures the trailing free text as the rejection reason
 * (Requirement 34.3). `Status <id | patient name>` keeps the whole remainder as
 * the lookup query so multi-word patient names survive.
 */
export function parseStaffCommand(text: string): StaffCommand {
  const m = /^\s*(approve|reject|status|show)\b\s*(.*)$/is.exec(text ?? "");
  if (!m) return { kind: "none" };

  const verb = m[1].toLowerCase();
  const rest = (m[2] ?? "").trim();

  switch (verb) {
    case "approve": {
      const caseId = firstToken(rest);
      return caseId ? { kind: "approve", caseId } : { kind: "none" };
    }
    case "reject": {
      const caseId = firstToken(rest);
      if (!caseId) return { kind: "none" };
      const reason = rest.slice(caseId.length).trim();
      return reason
        ? { kind: "reject", caseId, reason }
        : { kind: "reject", caseId };
    }
    case "show": {
      const caseId = firstToken(rest);
      return caseId ? { kind: "show", caseId } : { kind: "none" };
    }
    case "status": {
      return rest ? { kind: "status", query: rest } : { kind: "none" };
    }
    default:
      return { kind: "none" };
  }
}

// ─── Generic, PHI-free patient templates (Requirement 33.1–33.4) ─────────────
//
// Every patient-facing reply is drawn from this set, so the outbound surface is
// structurally incapable of carrying case specifics or PHI (Requirement 33.3).
// `needsMoreInfo` is deliberately generic and NEVER names the missing item
// (Requirement 33.2).

export const PATIENT_TEMPLATES = {
  caseCreated:
    "We've received your message about your insurance issue and started reviewing it. We'll update you here as soon as we have next steps.",
  needsMoreInfo:
    "Thanks — to keep moving forward we need a little more information about your case. Someone from our office will reach out shortly to help.",
  appealFiled:
    "Good news — we've filed the next step on your insurance case. We'll let you know here when there's another update.",
  resolved:
    "There's a resolution on your insurance case. Please check your patient portal or call our office for the details.",
  statusGeneric:
    "Your case is being worked on and there's activity on it. For the specifics, please check your patient portal or call our office.",
  noOpenCase:
    "We don't have an open case for this number right now. If you have a new insurance issue, just describe it here and we'll start one.",
} as const;

export type PatientTemplateKey = keyof typeof PATIENT_TEMPLATES;

// ─── Ports (all side effects flow through these) ─────────────────────────────

/** A generic, PHI-free summary of a Case used for staff status / patient lookup. */
export interface CaseSummary {
  caseId: string;
  status: CaseStatus;
  /** Overall Confidence_Score (0..1 or 0..100 per caller convention), when known. */
  confidenceScore?: number | null;
  /** SLA days remaining (may be negative when overdue), when known. */
  slaDaysRemaining?: number | null;
  /** Free-text patient name hint (staff-facing status only; never patient-facing). */
  patientNameHint?: string | null;
}

/** Input to the create-case port for a WhatsApp patient intake. */
export interface CreateCaseInput {
  rawText: string;
  intakeType: string;
  patientPhone: string;
  patientNameHint?: string;
}

// ── Seam types for LATER tasks (26.22–26.35). Defined here so the port surface
//    is stable; the base router does not use them. ──────────────────────────

/** An inbound media attachment (image / PDF / audio) for the media quality gate. */
export interface InboundMedia {
  mediaId: string;
  mimeType?: string;
  kind: "image" | "document" | "audio";
}

/** Result of the media quality/type gate (Requirement 41). */
export interface MediaQualityResult {
  usable: boolean;
  reason?: string;
  extractedText?: string;
}

/** A request for a staff member to contact a patient directly (Requirement 43). */
export interface HandoffRequestInput {
  caseId?: string;
  patientPhone: string;
  reason: string;
  urgent: boolean;
}

/** Input to the scoped conversational fallback (Requirement 44). */
export interface FallbackInput {
  role: Role;
  text: string;
  caseContext?: CaseSummary | null;
}

/**
 * The injected side-effect surface for {@link routeInbound}.
 *
 * The first block is used by this base router. The remaining, OPTIONAL members
 * are clean seams for later tasks (emergency short-circuit, media gate, human
 * handoff, conversational fallback, Safety_Guard) — the base router never calls
 * them, so fakes in unit tests only need to supply the used ports.
 */
export interface RouterPorts {
  /** Registered `Staff_Number`s (raw or digits-only) used for role resolution. */
  staffNumbers: ReadonlySet<string>;
  /** Create a Case from a patient intake and kick off the nine-stage pipeline. */
  createCase(input: CreateCaseInput): Promise<{ caseId: string }>;
  /**
   * The SHARED Shared_Case_Action operation (lib/caseActions.ts) — the SAME one
   * the Dashboard invokes (Requirements 34.8, 40.2). Staff approve/reject delegate
   * here with `meta.source: "whatsapp"`.
   */
  performCaseAction(
    caseId: string,
    actionType: CaseActionType,
    meta: CaseActionMeta,
  ): Promise<CaseActionResult>;
  /** Most recent OPEN Case for a patient phone, or null (Requirement 32.4/32.5). */
  lookupOpenCaseByPhone(phone: string): Promise<CaseSummary | null>;
  /** Look up a Case by id or patient name for a staff status query (Req 34.4). */
  lookupCase(query: string): Promise<CaseSummary | null>;
  /** Absolute URL to the Case Detail page for a case id (Requirement 34.5). */
  caseDetailUrl(caseId: string): string;
  /** Outbound WhatsApp sender. */
  send: Sender;

  // ── Optional seams for later tasks (not used by the base router) ──────────
  /** Safety_Guard screen for untrusted intake text (Requirement 27, task 11.5/26). */
  guard?: (text: string) => GuardResult;
  /** Media quality/type gate (Requirement 41, task 26.30). */
  classifyMedia?: (files: InboundMedia[]) => Promise<MediaQualityResult[]>;
  /** Deterministic, non-LLM emergency-language detector (Requirement 42.4, task 26.22). */
  detectEmergency?: (text: string) => boolean;
  /** Record a Human_Handoff request (Requirement 43, task 26.24). */
  recordHandoff?: (req: HandoffRequestInput) => Promise<void>;
  /** Scoped, role-aware conversational fallback (Requirement 44, task 26.35). */
  conversationalFallback?: (input: FallbackInput) => Promise<string>;
}

// ─── Route result (returned for the caller + tests; replies are also sent) ───

export interface RouteResult {
  /** True when this turn produced a definitive action/reply. */
  handled: boolean;
  role: Role;
  /** The base action taken, when any. */
  action?: "intake" | "status" | "approve" | "reject" | "show";
  /** The Case this turn touched or referenced, when any. */
  caseId?: string;
  /** The text sent back to the sender, when any. */
  reply?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Best-effort outbound send. The Sender never throws — it returns a SendResult. */
async function reply(ports: RouterPorts, to: string, body: string): Promise<void> {
  await ports.send.sendText(to, body);
}

/**
 * Does the patient text read as a status enquiry (Requirement 32.4)? Deterministic
 * and intentionally conservative so ordinary intake descriptions are not misread
 * as status checks.
 */
function isStatusQuestion(text: string): boolean {
  return /\b(status|any\s+news|any\s+update|update\s+me|what('|’)?s\s+happening|whats\s+happening|any\s+progress|how('|’)?s\s+(it|my\s+case)\s+going)\b/i.test(
    text ?? "",
  );
}

/** One-line staff status summary: status + confidence + SLA days left (Req 34.4). */
function formatStaffStatus(summary: CaseSummary): string {
  const parts = [`Case ${summary.caseId}: ${summary.status}`];
  if (summary.confidenceScore != null) {
    parts.push(`confidence ${summary.confidenceScore}`);
  }
  if (summary.slaDaysRemaining != null) {
    const d = summary.slaDaysRemaining;
    parts.push(`SLA ${d} day${Math.abs(d) === 1 ? "" : "s"} left`);
  }
  return parts.join(" · ");
}

// ─── The router ─────────────────────────────────────────────────────────────

/**
 * Route one inbound WhatsApp message. The caller (the webhook route) is responsible
 * for signature verification and dedupe BEFORE invoking this. Replies are sent
 * through `ports.send`; the returned {@link RouteResult} describes what happened so
 * the caller can record the WhatsApp_Message / audit entry and tests can assert on it.
 */
export async function routeInbound(
  inbound: NormalizedInbound,
  ports: RouterPorts,
): Promise<RouteResult> {
  const role = resolveRole(inbound.phone, ports.staffNumbers);
  return role === "staff"
    ? routeStaff(inbound, ports)
    : routePatient(inbound, ports);
}

/** Staff path: structured commands only; approve/reject go through the shared action. */
async function routeStaff(
  inbound: NormalizedInbound,
  ports: RouterPorts,
): Promise<RouteResult> {
  const cmd = parseStaffCommand(inbound.body);

  switch (cmd.kind) {
    case "approve":
    case "reject": {
      // Delegate to the SHARED performCaseAction — the same operation the Dashboard
      // invokes (Req 34.8, 40.2). The idempotency key is derived from the inbound
      // message id so a Meta redelivery is a no-op (Req 8.9, 34.6, 26).
      const meta: CaseActionMeta = {
        source: "whatsapp",
        actor: inbound.phone,
        idempotencyKey: `wa:${inbound.messageId}`,
        ...(cmd.kind === "reject" && cmd.reason ? { reason: cmd.reason } : {}),
      };
      const result = await ports.performCaseAction(cmd.caseId, cmd.kind, meta);
      await reply(ports, inbound.phone, result.message);
      return {
        handled: true,
        role: "staff",
        action: cmd.kind,
        caseId: cmd.caseId,
        reply: result.message,
      };
    }

    case "status": {
      const summary = await ports.lookupCase(cmd.query);
      const body = summary
        ? formatStaffStatus(summary)
        : `No case found for "${cmd.query}".`;
      await reply(ports, inbound.phone, body);
      return {
        handled: true,
        role: "staff",
        action: "status",
        caseId: summary?.caseId,
        reply: body,
      };
    }

    case "show": {
      const url = ports.caseDetailUrl(cmd.caseId);
      await reply(ports, inbound.phone, url);
      return {
        handled: true,
        role: "staff",
        action: "show",
        caseId: cmd.caseId,
        reply: url,
      };
    }

    case "none":
    default:
      // Seam: staff free-text action guardrail (Req 45, task 26.32) and the
      // conversational fallback (Req 44, task 26.35) handle non-command staff
      // messages. The base router takes no case action from free text.
      return { handled: false, role: "staff" };
  }
}

/** Patient path: intake and generic, PHI-free status only. No case mutation. */
async function routePatient(
  inbound: NormalizedInbound,
  ports: RouterPorts,
): Promise<RouteResult> {
  // Seam: emergency short-circuit (Req 42, task 26.22) and the media quality gate
  // (Req 41, task 26.30) run at the head of the patient path in later tasks.

  // A non-staff sender using an action command must NOT mutate or create a Case
  // (Requirement 34.7). Do not treat it as intake; the conversational fallback
  // (task 26.35) will craft the reply.
  if (!inbound.hasImage && parseStaffCommand(inbound.body).kind !== "none") {
    return { handled: false, role: "patient" };
  }

  // Patient status question → generic, PHI-free reply; no pipeline re-run
  // (Requirements 32.4, 32.5, 33.3).
  if (!inbound.hasImage && isStatusQuestion(inbound.body)) {
    const open = await ports.lookupOpenCaseByPhone(inbound.phone);
    const body = open ? PATIENT_TEMPLATES.statusGeneric : PATIENT_TEMPLATES.noOpenCase;
    await reply(ports, inbound.phone, body);
    return {
      handled: true,
      role: "patient",
      action: "status",
      caseId: open?.caseId,
      reply: body,
    };
  }

  // Patient intake (free text and/or image) → create a Case and run the pipeline,
  // then acknowledge with the generic PHI-free template (Requirements 32.1–32.3).
  if (inbound.body.trim().length > 0 || inbound.hasImage) {
    const { caseId } = await ports.createCase({
      rawText: inbound.body,
      intakeType: "whatsapp_patient_note",
      patientPhone: inbound.phone,
    });
    await reply(ports, inbound.phone, PATIENT_TEMPLATES.caseCreated);
    return {
      handled: true,
      role: "patient",
      action: "intake",
      caseId,
      reply: PATIENT_TEMPLATES.caseCreated,
    };
  }

  // Seam: nothing usable (empty / unsupported / ambiguous). Handled by the
  // unsupported-type & ambiguous-reply logic (Req 46/47, task 26.34) and the
  // conversational fallback (Req 44, task 26.35).
  return { handled: false, role: "patient" };
}
