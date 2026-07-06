// =============================================================================
// lib/whatsapp/notifications.ts
//
// WhatsApp staff notifications (Requirement 35).
//
// Sends operational, staff-facing WhatsApp_Messages to the registered
// Staff_Numbers for the four Requirement 35 triggers:
//
//   35.1 new_case                 — a Case was created from a patient WhatsApp
//                                    message.
//   35.2 recommendation_ready     — a Case reached "AwaitingApproval"; carries a
//                                    one-line Decision_Intelligence summary and
//                                    the overall Confidence_Score.
//   35.3 sla_deadline_approaching — a Case SLA_Clock deadline is approaching.
//   35.4 manual_review_required   — the Verification_QA stage flagged an issue
//                                    requiring manual review.
//
// PHI BOUNDARY (Requirement 36.3): the WhatsApp_Channel carries only triggers,
// generic PHI-free status, and staff approvals — PHI and case-specific detail
// stay inside the AuthPilot app and the generated PDFs. These messages are
// addressed to authorized Staff_Numbers only and reference a Case by its opaque
// id plus operational metadata (status readiness, confidence, SLA days). They
// carry NO patient name and NO medical detail. Any `decisionSummary` /
// `issueSummary` text supplied by the caller MUST already be PHI-free; this
// module treats those strings as opaque and does not add PHI of its own.
//
// TESTABILITY: the outbound `Sender` and the Staff_Number list are injected as
// dependencies (defaulting to the App_Configuration WhatsApp channel and the
// WHATSAPP_STAFF_NUMBERS env var), so notifications can be exercised with an
// in-memory fake Sender and no network. Every path is BEST-EFFORT: a send is
// attempted per recipient, failures are captured in the returned result, and
// the module NEVER throws.
// =============================================================================

import { getConfig } from "../config";
import { createSender, type SendResult, type Sender } from "./sender";

// ─── Triggers (Requirement 35.1–35.4) ────────────────────────────────────────

/** The four Requirement 35 staff-notification triggers. */
export type StaffNotificationTrigger =
  | "new_case" // 35.1
  | "recommendation_ready" // 35.2
  | "sla_deadline_approaching" // 35.3
  | "manual_review_required"; // 35.4

// ─── Per-trigger payloads ─────────────────────────────────────────────────────

/** 35.1 — a new Case was created from a patient WhatsApp message. */
export interface NewCaseNotification {
  caseId: string;
}

/** 35.2 — a Case reached "AwaitingApproval" and is ready for a human decision. */
export interface RecommendationReadyNotification {
  caseId: string;
  /** One-line Decision_Intelligence summary (must be PHI-free). */
  decisionSummary: string;
  /** Overall Confidence_Score — accepts a 0..1 fraction or a 0..100 percentage. */
  confidenceScore: number;
}

/** 35.3 — a Case SLA_Clock deadline is approaching. */
export interface SlaDeadlineNotification {
  caseId: string;
  /** SLA days remaining (may be 0; negative means already overdue). */
  daysRemaining: number;
}

/** 35.4 — Verification_QA flagged an issue requiring manual review. */
export interface ManualReviewNotification {
  caseId: string;
  /** Optional short, PHI-free note about the flagged issue. */
  issueSummary?: string;
}

/** A tagged staff-notification request — one variant per Requirement 35 trigger. */
export type StaffNotification =
  | ({ trigger: "new_case" } & NewCaseNotification)
  | ({ trigger: "recommendation_ready" } & RecommendationReadyNotification)
  | ({ trigger: "sla_deadline_approaching" } & SlaDeadlineNotification)
  | ({ trigger: "manual_review_required" } & ManualReviewNotification);

// ─── Dependencies (injectable; default to config + env) ───────────────────────

/**
 * The injected surface: an outbound {@link Sender} and the registered
 * Staff_Numbers to address. Supply these in tests to avoid config/network.
 */
export interface NotificationDeps {
  send: Sender;
  staffNumbers: readonly string[];
}

// ─── Results (never thrown — always returned) ─────────────────────────────────

/** The outcome of the send to a single Staff_Number. */
export interface RecipientDeliveryResult {
  to: string;
  result: SendResult;
}

/** Aggregate outcome of a staff notification across every registered recipient. */
export interface StaffNotificationResult {
  trigger: StaffNotificationTrigger;
  /** The exact message body that was (attempted to be) sent. */
  message: string;
  /** True iff there was at least one recipient and EVERY send returned ok. */
  delivered: boolean;
  /** True iff there were no registered Staff_Numbers / no channel to notify. */
  noRecipients: boolean;
  /** Per-recipient outcomes (empty when there were no recipients). */
  results: RecipientDeliveryResult[];
}

// ─── Default dependency resolution ────────────────────────────────────────────

/**
 * Parse a comma-separated `WHATSAPP_STAFF_NUMBERS` value into a de-duplicated,
 * trimmed list of Staff_Numbers. Total and pure — a nullish/empty value yields
 * an empty list. (Matches the E.164-without-"+" convention Meta sends as `from`.)
 */
export function parseStaffNumbers(raw: string | undefined): string[] {
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const n = part.trim();
    if (n) seen.add(n);
  }
  return [...seen];
}

/**
 * Best-effort default dependencies from the App_Configuration WhatsApp channel
 * and the `WHATSAPP_STAFF_NUMBERS` env var. Returns `null` — never throws — when
 * the channel is disabled or the configuration cannot be loaded, so a caller
 * that omits `deps` simply becomes a no-op instead of crashing a pipeline.
 */
export function defaultNotificationDeps(
  env: NodeJS.ProcessEnv = process.env,
): NotificationDeps | null {
  try {
    const cfg = getConfig(env);
    if (!cfg.whatsapp) return null;
    return {
      // WhatsAppConfig structurally satisfies SenderConfig (token + phoneNumberId).
      send: createSender(cfg.whatsapp),
      staffNumbers: parseStaffNumbers(env.WHATSAPP_STAFF_NUMBERS),
    };
  } catch {
    // Misconfiguration must not turn a notification into a thrown error.
    return null;
  }
}

// ─── Message formatting (staff-facing, operational, PHI-free) ─────────────────

/**
 * Render a Confidence_Score as an integer percentage. Accepts either a 0..1
 * fraction (0.82 → "82%") or an already-scaled 0..100 value (82 → "82%").
 */
function formatConfidence(score: number): string {
  if (!Number.isFinite(score)) return "n/a";
  const pct = score <= 1 ? score * 100 : score;
  return `${Math.round(pct)}%`;
}

/** "1 day" / "N days", handling the singular and negative (overdue) cases. */
function formatDays(days: number): string {
  return `${days} day${Math.abs(days) === 1 ? "" : "s"}`;
}

/**
 * Build the operational, PHI-free message body for a notification. Every message
 * references the Case only by its opaque id plus channel-safe status metadata
 * (Requirement 36.3).
 */
export function formatStaffNotification(n: StaffNotification): string {
  switch (n.trigger) {
    case "new_case":
      return `AuthPilot: New case ${n.caseId} was created from a patient WhatsApp message. Review it in the dashboard.`;

    case "recommendation_ready":
      return `AuthPilot: Case ${n.caseId} is ready for approval — ${n.decisionSummary} (confidence ${formatConfidence(
        n.confidenceScore,
      )}). Open the dashboard to Approve or Reject.`;

    case "sla_deadline_approaching":
      return `AuthPilot: Case ${n.caseId} SLA deadline is approaching — ${formatDays(
        n.daysRemaining,
      )} remaining. Please review soon.`;

    case "manual_review_required":
      return `AuthPilot: Case ${n.caseId} was flagged during verification and needs manual review.${
        n.issueSummary ? ` ${n.issueSummary}` : ""
      }`;
  }
}

// ─── Core send (best-effort, never throws) ────────────────────────────────────

/**
 * Send `message` to every registered Staff_Number, best-effort. Each send is
 * isolated so one recipient's failure never blocks another, and any thrown error
 * from the Sender is captured into that recipient's {@link SendResult}. Never throws.
 */
async function sendToAllStaff(
  trigger: StaffNotificationTrigger,
  message: string,
  deps: NotificationDeps,
): Promise<StaffNotificationResult> {
  const recipients = parseStaffNumbers(deps.staffNumbers.join(","));

  if (recipients.length === 0) {
    return { trigger, message, delivered: false, noRecipients: true, results: [] };
  }

  const results: RecipientDeliveryResult[] = await Promise.all(
    recipients.map(async (to) => {
      try {
        const result = await deps.send.sendText(to, message);
        return { to, result };
      } catch (err) {
        // The Sender is documented never to throw, but stay defensive so a
        // single misbehaving recipient can never break the whole notification.
        return {
          to,
          result: {
            ok: false,
            detail: err instanceof Error ? err.message : "send failed",
          } satisfies SendResult,
        };
      }
    }),
  );

  return {
    trigger,
    message,
    delivered: results.every((r) => r.result.ok),
    noRecipients: false,
    results,
  };
}

// ─── Public surface ───────────────────────────────────────────────────────────

/**
 * Send a staff notification to every registered Staff_Number for the given
 * Requirement 35 trigger. When `deps` is omitted, the App_Configuration WhatsApp
 * channel and `WHATSAPP_STAFF_NUMBERS` are used; if the channel is disabled the
 * call is a safe no-op (`noRecipients: true`). BEST-EFFORT and NEVER throws.
 */
export async function notifyStaff(
  notification: StaffNotification,
  deps?: NotificationDeps,
): Promise<StaffNotificationResult> {
  const message = formatStaffNotification(notification);
  const resolved = deps ?? defaultNotificationDeps();

  if (!resolved) {
    return {
      trigger: notification.trigger,
      message,
      delivered: false,
      noRecipients: true,
      results: [],
    };
  }

  return sendToAllStaff(notification.trigger, message, resolved);
}

// ── Per-trigger convenience helpers (thin wrappers over notifyStaff) ──────────

/** 35.1 — notify staff that a new Case was created from a patient WhatsApp message. */
export function notifyNewCase(
  input: NewCaseNotification,
  deps?: NotificationDeps,
): Promise<StaffNotificationResult> {
  return notifyStaff({ trigger: "new_case", ...input }, deps);
}

/** 35.2 — notify staff that a Case reached "AwaitingApproval" and is ready to review. */
export function notifyRecommendationReady(
  input: RecommendationReadyNotification,
  deps?: NotificationDeps,
): Promise<StaffNotificationResult> {
  return notifyStaff({ trigger: "recommendation_ready", ...input }, deps);
}

/** 35.3 — notify staff that a Case SLA_Clock deadline is approaching. */
export function notifySlaDeadlineApproaching(
  input: SlaDeadlineNotification,
  deps?: NotificationDeps,
): Promise<StaffNotificationResult> {
  return notifyStaff({ trigger: "sla_deadline_approaching", ...input }, deps);
}

/** 35.4 — notify staff that Verification_QA flagged a Case for manual review. */
export function notifyManualReviewRequired(
  input: ManualReviewNotification,
  deps?: NotificationDeps,
): Promise<StaffNotificationResult> {
  return notifyStaff({ trigger: "manual_review_required", ...input }, deps);
}
