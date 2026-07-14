// =============================================================================
// lib/sla.test.ts
//
// Property-based tests for the pure SLA_Clock computations in `lib/sla.ts`.
//
// Feature: authpilot, Property 30: SLA deadline computation — For any creation
// timestamp, `slaDeadline(createdAt, urgent)` returns `createdAt + 72h` when
// urgent is true and `createdAt + 7d` when urgent is false. A Case created
// without the urgent flag is standard (7-day deadline).
// **Validates: Requirements 1.8, 1.9, 12.1, 12.2**
//
// Feature: authpilot, Property 31: At-risk boundary — `isAtRisk` is true iff the
// remaining time until the deadline is strictly less than 24 hours, including
// overdue (negative-remaining) cases; a Case with exactly 24 hours remaining is
// not at risk.
// **Validates: Requirements 12.3**
// =============================================================================

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { slaDeadline, remainingMs, isAtRisk } from "@/lib/sla";
import { FC_CONFIG } from "@/lib/testConfig";

// Canonical window/threshold constants, computed independently of the module
// under test so the test does not merely mirror the implementation constants.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const URGENT_WINDOW_MS = 72 * HOUR_MS; // 259_200_000
const STANDARD_WINDOW_MS = 7 * DAY_MS; // 604_800_000
const AT_RISK_THRESHOLD_MS = DAY_MS; // 86_400_000

/**
 * Arbitrary whole-millisecond epoch timestamp within a broad but safe range
 * (epoch .. ~year 2100). Using integer milliseconds keeps the arithmetic exact
 * and well inside the safe-integer range once offsets are added.
 */
const timestampArb = fc.integer({ min: 0, max: 4_102_444_800_000 });

describe("slaDeadline (Property 30: SLA deadline computation)", () => {
  it("returns createdAt + 72h when urgent and createdAt + 7d when standard", () => {
    fc.assert(
      fc.property(timestampArb, fc.boolean(), (createdMs, urgent) => {
        const createdAt = new Date(createdMs);
        const deadline = slaDeadline(createdAt, urgent);

        const expectedWindow = urgent ? URGENT_WINDOW_MS : STANDARD_WINDOW_MS;
        expect(deadline.getTime()).toBe(createdMs + expectedWindow);
      }),
      FC_CONFIG,
    );
  });

  it("uses the 7-day standard window whenever the urgent flag is false (Req 1.9, 12.2)", () => {
    fc.assert(
      fc.property(timestampArb, (createdMs) => {
        const createdAt = new Date(createdMs);
        expect(slaDeadline(createdAt, false).getTime()).toBe(
          createdMs + STANDARD_WINDOW_MS,
        );
      }),
      FC_CONFIG,
    );
  });

  it("uses the 72-hour urgent window whenever the urgent flag is true (Req 1.8, 12.1)", () => {
    fc.assert(
      fc.property(timestampArb, (createdMs) => {
        const createdAt = new Date(createdMs);
        expect(slaDeadline(createdAt, true).getTime()).toBe(
          createdMs + URGENT_WINDOW_MS,
        );
      }),
      FC_CONFIG,
    );
  });
});

/**
 * Offset (in ms) of the deadline relative to the exact 24h at-risk boundary.
 * The deadline is placed at `now + AT_RISK_THRESHOLD_MS + delta`, so the
 * remaining time is `AT_RISK_THRESHOLD_MS + delta` and the expected at-risk
 * outcome is exactly `delta < 0`.
 *
 * The generator emphasises the boundary (delta = -1, 0, +1), covers overdue
 * cases (large negative delta driving remaining below zero), and spans a broad
 * range on either side.
 */
const boundaryDeltaArb = fc.oneof(
  // Exact boundary and its immediate neighbours.
  fc.constantFrom(-1, 0, 1),
  // Tight cluster straddling the boundary.
  fc.integer({ min: -1000, max: 1000 }),
  // Broad range, including deltas large enough to make the deadline overdue
  // (remaining strictly negative) and far in the future.
  fc.integer({ min: -3 * AT_RISK_THRESHOLD_MS, max: 5 * AT_RISK_THRESHOLD_MS }),
);

describe("isAtRisk (Property 31: at-risk boundary)", () => {
  it("is at risk iff remaining time is strictly less than 24h, including overdue", () => {
    fc.assert(
      fc.property(timestampArb, boundaryDeltaArb, (nowMs, delta) => {
        const now = new Date(nowMs);
        const deadline = new Date(nowMs + AT_RISK_THRESHOLD_MS + delta);

        const remaining = remainingMs(deadline, now);
        // By construction remaining === AT_RISK_THRESHOLD_MS + delta.
        expect(remaining).toBe(AT_RISK_THRESHOLD_MS + delta);

        // At-risk exactly when remaining < 24h, i.e. delta < 0.
        expect(isAtRisk(deadline, now)).toBe(delta < 0);
      }),
      FC_CONFIG,
    );
  });

  it("treats exactly 24 hours remaining as not at risk (boundary is exclusive)", () => {
    fc.assert(
      fc.property(timestampArb, (nowMs) => {
        const now = new Date(nowMs);
        const deadline = new Date(nowMs + AT_RISK_THRESHOLD_MS);
        expect(remainingMs(deadline, now)).toBe(AT_RISK_THRESHOLD_MS);
        expect(isAtRisk(deadline, now)).toBe(false);
      }),
      FC_CONFIG,
    );
  });

  it("always flags overdue cases (deadline at or before now) as at risk", () => {
    fc.assert(
      fc.property(
        timestampArb,
        fc.integer({ min: 0, max: 5 * AT_RISK_THRESHOLD_MS }),
        (nowMs, overdueBy) => {
          const now = new Date(nowMs);
          // Deadline already passed (or exactly now): remaining <= 0 < 24h.
          const deadline = new Date(nowMs - overdueBy);
          expect(isAtRisk(deadline, now)).toBe(true);
        },
      ),
      FC_CONFIG,
    );
  });
});
