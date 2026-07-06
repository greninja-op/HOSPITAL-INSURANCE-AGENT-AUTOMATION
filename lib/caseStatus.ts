// =============================================================================
// lib/caseStatus.ts
//
// Case_Status state machine (Requirement 28).
//
// A single, pure transition guard that enforces the allowed Status_Transition
// set on EVERY status write across the app — the `/action` route, the
// Agent_Runner's stage-advancing writes, Case_Outcome recording, and the
// WhatsApp staff-command handler all route status changes through
// `assertTransition` and persist only when `ok` is true.
//
// This module is pure and deterministic: no I/O, no side effects, and it never
// throws. Callers get a `TransitionResult` describing the outcome.
//
// Requirements:
//   28.1 — restrict allowed transitions to the table below.
//   28.2 — reject an illegal (differing) to-status: leave status unchanged and
//          return a message identifying the illegal Status_Transition.
//   28.3 — a same-state (to === from) request is an idempotent no-op success.
//   28.4 — "Resolved" and "DeniedFinal" are terminal (no outgoing transitions).
//   28.5 — reject any transition requested from a terminal status to a
//          different status, leaving the status unchanged.
// =============================================================================

import type { CaseStatus, StatusTransition, TransitionResult } from "./types";

// ─── Allowed transition table (Requirement 28) ───────────────────────────────

/**
 * The allowed Case_Status transitions, keyed by from-status. Any
 * (from-status, to-status) pair not listed here is an illegal transition
 * (Req 28.1). The two terminal statuses map to an empty list, so they have no
 * allowed outgoing transition (Req 28.4).
 *
 * Encoded faithfully from the Requirement 28 allowed-transition table:
 *
 *   New              → Investigating
 *   Investigating    → AwaitingApproval, NeedsHumanInput
 *   AwaitingApproval → AppealSent, NeedsHumanInput
 *   NeedsHumanInput  → Investigating, AwaitingApproval
 *   AppealSent       → Resolved, DeniedFinal
 *   Resolved         → (terminal — none)
 *   DeniedFinal      → (terminal — none)
 */
export const ALLOWED_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  New: ["Investigating"],
  Investigating: ["AwaitingApproval", "NeedsHumanInput"],
  AwaitingApproval: ["AppealSent", "NeedsHumanInput"],
  NeedsHumanInput: ["Investigating", "AwaitingApproval"],
  AppealSent: ["Resolved", "DeniedFinal"],
  Resolved: [],
  DeniedFinal: [],
} as const;

/** The terminal statuses that have no allowed outgoing transition (Req 28.4). */
export const TERMINAL_STATUSES: readonly CaseStatus[] = [
  "Resolved",
  "DeniedFinal",
] as const;

// ─── Guards ───────────────────────────────────────────────────────────────

/**
 * Whether `to` is an allowed to-status for `from` per the transition table.
 *
 * This is a strict table lookup: a same-state (`to === from`) pair is NOT in
 * the table and therefore returns `false` here. Same-state requests are handled
 * separately by `assertTransition` as idempotent no-ops (Req 28.3).
 *
 * @param from - The current Case_Status.
 * @param to - The requested Case_Status.
 * @returns `true` iff `(from, to)` is listed in `ALLOWED_TRANSITIONS`.
 */
export function isLegalTransition(from: CaseStatus, to: CaseStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Whether `status` is a terminal status with no outgoing transition. */
export function isTerminalStatus(status: CaseStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

/**
 * Evaluate a requested Status_Transition against the allowed-transition table.
 *
 * Never throws. Returns a `TransitionResult`:
 *
 *   - Same-state (`to === from`) → idempotent no-op success:
 *     `{ ok: true, status: from, noop: true }` (Req 28.3).
 *   - Allowed (`to` in `ALLOWED_TRANSITIONS[from]`) → success:
 *     `{ ok: true, status: to }` (Req 28.1).
 *   - Illegal (a different to-status not in the allowed set, including any
 *     outgoing transition from a terminal status) → rejection with the status
 *     left unchanged and a message identifying the illegal transition:
 *     `{ ok: false, status: from, message }` (Req 28.2, 28.4, 28.5).
 *
 * @param from - The current Case_Status.
 * @param to - The requested Case_Status.
 * @returns The evaluation outcome; on rejection/no-op `status` equals `from`.
 */
export function assertTransition(
  from: CaseStatus,
  to: CaseStatus,
): TransitionResult {
  // Same-state → idempotent no-op success; status unchanged (Req 28.3).
  if (to === from) {
    return { ok: true, status: from, noop: true };
  }

  // Allowed transition → success; the resulting status is `to` (Req 28.1).
  if (isLegalTransition(from, to)) {
    return { ok: true, status: to };
  }

  // Otherwise illegal: reject, leave status unchanged, identify the transition
  // (Req 28.2; covers terminal-status rejections in Req 28.4/28.5).
  return {
    ok: false,
    status: from,
    message: `Illegal status transition: ${from} → ${to}`,
  };
}

/**
 * Convenience overload that evaluates a `StatusTransition` object.
 *
 * @param transition - The requested `{ from, to }` transition.
 * @returns The same outcome as `assertTransition(transition.from, transition.to)`.
 */
export function assertStatusTransition(
  transition: StatusTransition,
): TransitionResult {
  return assertTransition(transition.from, transition.to);
}
