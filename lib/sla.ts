/**
 * SLA_Clock — pure time computations for the CMS 2026 appeal window.
 *
 * No I/O and no side effects: every function is a pure computation over the
 * `Date` values it is given. All arithmetic is done in whole milliseconds.
 *
 * Requirements: 12.1 (deadline: +72h urgent / +7d standard),
 * 12.2 (remaining time, may be negative when overdue),
 * 12.3 (at-risk when remaining < 24h, including overdue).
 */

/** Milliseconds in one hour. */
const HOUR_MS = 60 * 60 * 1000;

/** Milliseconds in one day (24 hours). */
const DAY_MS = 24 * HOUR_MS;

/** Standard SLA window: 7 days from case creation. */
const STANDARD_WINDOW_MS = 7 * DAY_MS;

/** Urgent SLA window: 72 hours from case creation. */
const URGENT_WINDOW_MS = 72 * HOUR_MS;

/** At-risk threshold: less than 24 hours of remaining time. */
const AT_RISK_THRESHOLD_MS = DAY_MS;

/**
 * Compute the SLA deadline for a Case.
 *
 * @param createdAt - The Case creation time.
 * @param urgent - Whether the Case is urgent.
 * @returns `createdAt + 72h` when urgent, `createdAt + 7d` when standard.
 */
export function slaDeadline(createdAt: Date, urgent: boolean): Date {
  const windowMs = urgent ? URGENT_WINDOW_MS : STANDARD_WINDOW_MS;
  return new Date(createdAt.getTime() + windowMs);
}

/**
 * Milliseconds remaining until the SLA deadline.
 *
 * @param deadline - The SLA deadline.
 * @param now - The current time.
 * @returns `deadline - now` in milliseconds; negative when the deadline has
 *   already passed (overdue).
 */
export function remainingMs(deadline: Date, now: Date): number {
  return deadline.getTime() - now.getTime();
}

/**
 * Whether a Case is at risk of missing its SLA deadline.
 *
 * A Case is at risk when it has less than 24 hours of remaining time. Overdue
 * Cases (negative remaining time) are always at risk.
 *
 * @param deadline - The SLA deadline.
 * @param now - The current time.
 * @returns `true` when the remaining time is less than 24 hours (including
 *   overdue), otherwise `false`.
 */
export function isAtRisk(deadline: Date, now: Date): boolean {
  return remainingMs(deadline, now) < AT_RISK_THRESHOLD_MS;
}
