// =============================================================================
// lib/sla.atrisk.test.ts
//
// Property-based test for the SLA_Clock at-risk boundary (Requirement 12.3).
//
// Feature: authpilot, Property 31: At-risk boundary — For any deadline and
// current time, a Case is flagged at-risk if and only if the remaining time
// until the deadline is less than 24 hours (including overdue Cases).
// =============================================================================

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { isAtRisk, remainingMs } from "@/lib/sla";
import { FC_CONFIG } from "@/lib/testConfig";

/** Milliseconds in one hour. */
const HOUR_MS = 60 * 60 * 1000;

/** Milliseconds in one day (the 24-hour at-risk threshold). */
const DAY_MS = 24 * HOUR_MS;

/**
 * A generator that produces `now` values whose remaining time relative to a
 * fixed deadline clusters tightly around the exact 24-hour boundary — just
 * under, exactly at, and just over 24h remaining — as well as deep-overdue and
 * comfortably-safe cases. This exercises the boundary the property hinges on.
 */
const scenario = fc
  .record({
    deadline: fc.date({
      min: new Date("2000-01-01T00:00:00.000Z"),
      max: new Date("2100-01-01T00:00:00.000Z"),
    }),
    // Chosen remaining-time offsets (ms), emphasizing the ±24h boundary.
    remaining: fc.oneof(
      // Exactly at the boundary (24h remaining) -> NOT at risk.
      fc.constant(DAY_MS),
      // Just under / just over the boundary by 1ms.
      fc.constant(DAY_MS - 1),
      fc.constant(DAY_MS + 1),
      // Overdue exactly at the deadline and just past it.
      fc.constant(0),
      fc.constant(-1),
      // Broad spread around the boundary (±48h) at millisecond resolution.
      fc.integer({ min: -2 * DAY_MS, max: 2 * DAY_MS }),
      // Deep overdue and comfortably safe, far from the boundary.
      fc.integer({ min: -365 * DAY_MS, max: -DAY_MS }),
      fc.integer({ min: DAY_MS, max: 365 * DAY_MS }),
    ),
  })
  .map(({ deadline, remaining }) => ({
    deadline,
    // now = deadline - remaining, so remainingMs(deadline, now) === remaining.
    now: new Date(deadline.getTime() - remaining),
    remaining,
  }));

describe("isAtRisk — at-risk boundary (Property 31)", () => {
  it("is at-risk iff remaining time is strictly less than 24h, including overdue (Req 12.3)", () => {
    // Validates: Requirements 12.3
    fc.assert(
      fc.property(scenario, ({ deadline, now }) => {
        const remaining = remainingMs(deadline, now);
        expect(isAtRisk(deadline, now)).toBe(remaining < DAY_MS);
      }),
      FC_CONFIG,
    );
  });

  it("treats exactly 24h remaining as NOT at-risk (boundary is strict)", () => {
    // Validates: Requirements 12.3
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2000-01-01T00:00:00.000Z"),
          max: new Date("2100-01-01T00:00:00.000Z"),
        }),
        (deadline) => {
          const now = new Date(deadline.getTime() - DAY_MS); // exactly 24h remaining
          expect(remainingMs(deadline, now)).toBe(DAY_MS);
          expect(isAtRisk(deadline, now)).toBe(false);
        },
      ),
      FC_CONFIG,
    );
  });

  it("flags every overdue Case (negative remaining) as at-risk", () => {
    // Validates: Requirements 12.3
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2000-01-01T00:00:00.000Z"),
          max: new Date("2100-01-01T00:00:00.000Z"),
        }),
        fc.integer({ min: 1, max: 365 * DAY_MS }),
        (deadline, overdueBy) => {
          const now = new Date(deadline.getTime() + overdueBy); // past the deadline
          expect(remainingMs(deadline, now)).toBeLessThan(0);
          expect(isAtRisk(deadline, now)).toBe(true);
        },
      ),
      FC_CONFIG,
    );
  });
});
