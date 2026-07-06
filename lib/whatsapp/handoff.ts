// =============================================================================
// lib/whatsapp/handoff.ts
//
// Human_Handoff — record a request for a staff member to contact a patient
// directly and drive a staff notification about it (Requirement 43).
//
// A Handoff_Request is raised in two situations:
//   • an EXPLICIT patient request for a human over the WhatsApp_Channel — this is
//     NON-urgent (Requirement 43.1); and
//   • an EMERGENCY detected consistent with Requirement 42 — this is URGENT
//     (Requirements 42.2, 43.2).
//
// `recordHandoff` persists exactly one `HandoffRequest` row (patient phone, the
// optional linked Case, reason, urgent flag — Requirement 43.1) and then drives a
// staff notification identifying the handoff, flagged URGENT when `urgent` is set
// (Requirements 43.3, 43.4).
//
// The staff notification is delivered through an injected **notifier port** so
// this module stays transport-agnostic and unit-/property-testable with an
// in-memory fake. The composition root (task 26.14) wires the real WhatsApp staff
// broadcast; the default port is a best-effort logger. The notification is ALWAYS
// best-effort: a notifier failure never prevents (or undoes) the recorded handoff,
// and `recordHandoff` never throws on account of the notification.
// =============================================================================

import type { HandoffRequest } from "@prisma/client";
import { prisma } from "../db";
import type { HandoffRequestInput } from "./router";

// ─── Notifier port ───────────────────────────────────────────────────────────

/**
 * A staff notification derived from a recorded {@link HandoffRequest}. Carries the
 * persisted row's identity plus a ready-to-send `message` and the `urgent` flag so
 * the wired port can render/route it (an urgent notification is flagged as such —
 * Requirement 43.4).
 */
export interface HandoffNotification {
  /** The persisted `HandoffRequest.id`. */
  handoffId: string;
  /** The optional linked Case id (Requirement 43.1). */
  caseId: string | null;
  /** The patient phone number to be contacted (E.164). */
  patientPhone: string;
  /** Why the handoff was raised. */
  reason: string;
  /** True for emergency-driven handoffs; drives an urgent staff notification. */
  urgent: boolean;
  /** A human-readable notification body identifying the handoff request. */
  message: string;
}

/**
 * The injected staff-notification surface. Implementations should be best-effort
 * and SHOULD NOT throw; `recordHandoff` additionally guards every call so a
 * throwing port can never break the recorded handoff.
 */
export type HandoffNotifier = (notification: HandoffNotification) => Promise<void> | void;

/**
 * Default notifier: a best-effort log. The real WhatsApp staff broadcast is wired
 * by the composition root (task 26.14). Kept side-effect-light and never throws.
 */
export const logHandoffNotifier: HandoffNotifier = (notification) => {
  const tag = notification.urgent ? "URGENT " : "";
  console.info(
    `[handoff] ${tag}staff notification: ${notification.message} (handoffId=${notification.handoffId})`,
  );
};

// ─── Notification message ──────────────────────────────────────────────────

/**
 * Build the staff-facing notification body identifying the handoff request
 * (Requirement 43.3). Prefixed with an explicit "URGENT" marker when the handoff
 * is urgent (Requirement 43.4). Pure and total.
 */
export function formatHandoffNotification(row: HandoffRequest): string {
  const prefix = row.urgent ? "🚨 URGENT human handoff" : "Human handoff requested";
  const caseRef = row.caseId ? ` for case ${row.caseId}` : "";
  return `${prefix}${caseRef}: please contact patient ${row.patientPhone}. Reason: ${row.reason}.`;
}

// ─── recordHandoff ───────────────────────────────────────────────────────────

/**
 * Record a {@link HandoffRequest} and drive a staff notification about it.
 *
 * Persists one row carrying the patient phone, optional linked Case, reason, and
 * urgent flag (Requirement 43.1), then fires the injected {@link HandoffNotifier}
 * with a notification identifying the handoff — flagged urgent when `req.urgent`
 * is set (Requirements 43.3, 43.4). The notification is best-effort: any notifier
 * error is caught and logged and never fails the (already-persisted) handoff.
 *
 * Returns the persisted `HandoffRequest`.
 */
export async function recordHandoff(
  req: HandoffRequestInput,
  notify: HandoffNotifier = logHandoffNotifier,
): Promise<HandoffRequest> {
  const row = await prisma.handoffRequest.create({
    data: {
      caseId: req.caseId ?? null,
      patientPhone: req.patientPhone,
      reason: req.reason,
      urgent: req.urgent,
    },
  });

  // Best-effort staff notification — never throws, never undoes the handoff.
  try {
    await notify({
      handoffId: row.id,
      caseId: row.caseId,
      patientPhone: row.patientPhone,
      reason: row.reason,
      urgent: row.urgent,
      message: formatHandoffNotification(row),
    });
  } catch (err) {
    console.error(
      `[handoff] staff notification failed for handoffId=${row.id}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return row;
}
