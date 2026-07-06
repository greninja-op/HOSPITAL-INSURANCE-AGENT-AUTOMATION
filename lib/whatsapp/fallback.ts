// =============================================================================
// lib/whatsapp/fallback.ts
//
// Conversational_Fallback — the scoped, role-aware conversational assistant that
// handles inbound WhatsApp messages which match NEITHER a structured staff
// command, NOR a clear new-case trigger, NOR a status query (Requirement 44.1).
// The deterministic router (lib/whatsapp/router.ts) invokes this as the LAST
// RESORT via its optional `conversationalFallback` port; this module owns only
// the reply generation, never any routing or case mutation.
//
// The whole point of this layer is to answer questions like "what does prior
// authorization mean?", "any idea how long this takes?", or (for staff) "why did
// the agent escalate this one?" — WITHOUT crossing the compliance boundary and
// WITHOUT ever taking an action. That boundary is enforced two ways:
//
//   1. A strict, role-specific SYSTEM PROMPT sent to the model:
//        • PATIENT scope (Req 44.2–44.5): MAY explain general concepts, process,
//          and timelines in general terms, acknowledge frustration, and ask a
//          clarifying question. MUST NOT state any specific denial reason,
//          diagnosis, procedure code, dollar amount, or policy detail; MUST NOT
//          give medical advice (redirect medical questions to the patient's own
//          physician); and MUST NOT promise a case outcome.
//        • STAFF scope (Req 44.6, 44.7): MAY explain a Case's decision reasoning,
//          status, and AuthPilot's decision thresholds. MUST NOT perform any case
//          action from free text, and MUST NOT guess a case identifier that was
//          not clearly provided — it redirects action intent to the exact
//          structured command / Dashboard instead.
//
//   2. CASE CONTEXT INJECTION is role-gated: staff may receive a compact,
//      operational case summary (id/status/confidence/SLA); patients receive
//      only a neutral "there is / is not an active case on file" note so the
//      outbound surface stays structurally PHI-free (Req 33, 44.3).
//
// The single model call is made through an INJECTABLE dependency (`callModel`,
// defaulting to the resilient `callQwen`) so unit/smoke tests need no network,
// no API key, and no real timers. `callQwen` never throws — it resolves to a
// structured outcome — but this function additionally wraps the whole call in a
// try/catch, so ANY failure (a Qwen failure outcome, a missing/invalid config,
// or an unexpected throw) degrades to a SAFE CANNED REPLY appropriate to the
// role. `conversationalFallback` therefore never rejects.
//
// Requirements: 44.1, 44.2, 44.3, 44.4, 44.5, 44.6, 44.7, 32.7, 34.10.
// =============================================================================

import { callQwen, type ChatMessage } from "../qwen";
import type { QwenOutcome } from "../types";
import type { FallbackInput } from "./router";

// ─── Role-specific system prompts ────────────────────────────────────────────

/**
 * PATIENT scope (Req 44.2–44.5). Warm, plain, and WhatsApp-brief. The hard
 * prohibitions are stated as absolutes so the model cannot rationalize around
 * them, and medical questions are redirected to the patient's own physician.
 */
export const PATIENT_SYSTEM_PROMPT = `
You are AuthPilot's patient-facing WhatsApp assistant for a medical practice's
insurance prior-authorization and appeals process. You are warm, plain-spoken,
and brief — 2 to 4 short sentences, WhatsApp length, never an essay.

You MAY:
- Explain general concepts (what "prior authorization" or an "appeal" is, why a
  document might be needed, roughly how long these steps take in general terms).
- Explain, in general terms, what typically happens next in the process.
- Acknowledge frustration or worry with genuine empathy.
- Ask ONE clarifying question when the message is ambiguous.
- Offer to have someone from the office follow up for anything case-specific.

You MUST NEVER:
- State any specific denial reason, diagnosis, procedure/CPT/ICD code, dollar
  amount, or policy detail for their case. Say the specifics are in their patient
  portal or that the office can walk them through it.
- Give medical advice, diagnose, or comment on treatment decisions. Redirect any
  medical question to their own physician.
- Promise or predict a case outcome (never say an appeal "will" be approved or
  denied). Describe the process, not the result.
- Invent information you do not have. If you do not know, say so and offer to have
  staff follow up.

Reply with a single plain-text message and no markdown, headings, or lists.
`.trim();

/**
 * STAFF scope (Req 44.6, 44.7). Concise and operational. Staff may hear the
 * agent's reasoning/status/thresholds, but the assistant is structurally barred
 * from acting on free text or guessing an identifier.
 */
export const STAFF_SYSTEM_PROMPT = `
You are AuthPilot's internal WhatsApp assistant for hospital billing and appeals
staff. You are concise and operational — staff are busy; answer in 2 to 4
sentences unless they explicitly ask for more detail.

You MAY:
- Explain why the agent reached a particular decision on a case, using only the
  case context provided to you.
- Summarize a case's current status, confidence, and SLA in general operational
  terms.
- Explain AuthPilot's own decision logic and thresholds when asked.
- Say plainly when something needs to be done in the Dashboard rather than here.

You MUST NEVER:
- Perform or confirm any case action (approve, reject, edit, request evidence,
  status change) based on this free-text message. If the staff member seems to be
  asking you to act, tell them actions require the exact structured command
  ("Approve <case-id>" / "Reject <case-id>") or the Dashboard, because an action
  needs an unambiguous, auditable trigger.
- Guess a case identifier that was not clearly provided. If no case is clearly
  identified, ask which case they mean rather than assuming one.

Reply with a single plain-text message and no markdown, headings, or lists.
`.trim();

// ─── Safe canned replies (used on ANY model/config failure) ──────────────────
//
// These are deterministic, PHI-free, action-free fallbacks. They are what the
// caller receives if the model call fails for any reason, so the sender always
// gets a helpful, in-scope reply (Req 32.7 / 34.10 last-resort guarantee).

export const PATIENT_SAFE_REPLY =
  "Thanks for your message. I can help with general questions about the insurance " +
  "process, but for anything specific to your case please check your patient portal " +
  "or call our office and someone will be glad to help.";

export const STAFF_SAFE_REPLY =
  "I can help explain a case's status, reasoning, or our decision thresholds. To " +
  "act on a case, please use the exact command (e.g. \"Approve <case-id>\") or the " +
  "Dashboard, and let me know which case you mean if it isn't clear.";

// ─── Injectable dependency (testability) ─────────────────────────────────────

/** The single model call this module depends on. Defaults to `callQwen`. */
export type FallbackModelCaller = (messages: ChatMessage[]) => Promise<QwenOutcome>;

export interface FallbackDeps {
  /**
   * Perform the scoped chat completion. Injected in tests so no network, API
   * key, or timers are needed; the default forwards to the resilient `callQwen`.
   */
  callModel: FallbackModelCaller;
}

/**
 * Default deps. `callQwen` builds its own config-backed transport lazily on
 * call, so constructing the default here does no I/O; any config/transport
 * problem surfaces as a failure outcome (or throw) that {@link conversationalFallback}
 * turns into a safe canned reply.
 */
function defaultDeps(): FallbackDeps {
  return { callModel: (messages) => callQwen(messages) };
}

// ─── Case-context blocks (role-gated) ────────────────────────────────────────

/**
 * Build the context note appended to the system prompt.
 *
 * PATIENT: intentionally carries NO case specifics — only whether an active case
 * exists — so the outbound surface cannot leak PHI (Req 33, 44.3).
 *
 * STAFF: a compact operational summary (id/status/confidence/SLA) so the
 * assistant can explain reasoning and status (Req 44.6). No patient-identifying
 * free text is included.
 */
function buildContextBlock(input: FallbackInput): string {
  if (input.role === "patient") {
    return input.caseContext
      ? "Context: this patient has an active case on file. Do NOT reveal any case-specific detail; direct them to their portal or the office for specifics."
      : "Context: there is no active case on file for this patient right now.";
  }

  // staff
  const c = input.caseContext;
  if (!c) {
    return "Context: no case was clearly identified in this message. Do not assume a case id — ask which case they mean if they need case-specific help.";
  }
  const parts = [`id=${c.caseId}`, `status=${c.status}`];
  if (c.confidenceScore != null) parts.push(`confidence=${c.confidenceScore}`);
  if (c.slaDaysRemaining != null) parts.push(`slaDaysRemaining=${c.slaDaysRemaining}`);
  return `Context (staff-only, for explanation — never act on it): ${parts.join(", ")}.`;
}

/** The safe canned reply for a role, used whenever the model call cannot be used. */
function safeReply(role: FallbackInput["role"]): string {
  return role === "patient" ? PATIENT_SAFE_REPLY : STAFF_SAFE_REPLY;
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Produce a scoped conversational reply for an inbound WhatsApp message that
 * matched neither a structured staff command, a new-case trigger, nor a status
 * query (Req 44.1). Never throws: on any model/config failure it resolves to a
 * role-appropriate safe canned reply.
 *
 * @param input  role, the raw inbound text, and an optional case summary.
 * @param deps   injectable model caller (defaults to the resilient `callQwen`).
 */
export async function conversationalFallback(
  input: FallbackInput,
  deps: FallbackDeps = defaultDeps(),
): Promise<string> {
  const systemPrompt =
    input.role === "patient" ? PATIENT_SYSTEM_PROMPT : STAFF_SYSTEM_PROMPT;

  const userText = (input.text ?? "").trim();
  // An empty message has nothing to answer conversationally — give the safe,
  // in-scope reply rather than prompting the model with nothing.
  if (userText.length === 0) {
    return safeReply(input.role);
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "system", content: buildContextBlock(input) },
    { role: "user", content: userText },
  ];

  try {
    const outcome = await deps.callModel(messages);
    if (outcome.ok && typeof outcome.content === "string") {
      const reply = outcome.content.trim();
      if (reply.length > 0) return reply;
    }
    // Failure outcome, tool-call-only, or empty content → safe canned reply.
    return safeReply(input.role);
  } catch {
    // Defensive: even an unexpected throw (e.g. invalid config) degrades safely.
    return safeReply(input.role);
  }
}
