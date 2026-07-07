// =============================================================================
// lib/sla.test.ts
//
// Property-based test for SLA_Clock deadline computation.
//
// Feature: authpilot, Property 30: SLA deadline computation — for any Case
// creation time and urgent flag, slaDeadline(createdAt, urgent) equals
// createdAt + 72h when urgent and createdAt + 7d when standard.
//
// Validates: Requirements 1.8, 1.9, 12.1, 12.2
// =============================================================================

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { slaDeadline } from "@/lib/sla";
import { FC_CONFIG } from "@/lib/testConfig";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const URGENT_WINDOW_MS = 72 * HOUR_MS;
const STANDARD_WINDOW_MS = 7 * DAY_MS;

// Generate valid createdAt timestamps across a wide range of real Dates.
const createdAtArb = fc
  .date({ min: new Date("1970-01-01T00:00:00.000Z"), max: new Date("2100-01-01T00:00:00.000Z") })
  .filter((d) => !Number.isNaN(d.getTime()));

describe("slaDeadline (Property 30: SLA deadline computation)", () => {
  it("returns createdAt + 72h when urgent and createdAt + 7d when standard (Req 1.8, 1.9, 12.1, 12.2)", () => {
    fc.assert(
      fc.property(createdAtArb, fc.boolean(), (createdAt, urgent) => {
        const deadline = slaDeadline(createdAt, urgent);
        const expectedWindow = urgent ? URGENT_WINDOW_MS : STANDARD_WINDOW_MS;
        expect(deadline.getTime()).toBe(createdAt.getTime() + expectedWindow);
      }),
      FC_CONFIG,
    );
  });

  it("uses the 7-day standard window when the urgent flag is false (Req 1.9, 12.1)", () => {
    fc.assert(
      fc.property(createdAtArb, (createdAt) => {
        const deadline = slaDeadline(createdAt, false);
        expect(deadline.getTime()).toBe(createdAt.getTime() + STANDARD_WINDOW_MS);
      }),
      FC_CONFIG,
    );
  });

  it("makes the urgent deadline strictly earlier than the standard deadline for the same createdAt (Req 12.1)", () => {
    fc.assert(
      fc.property(createdAtArb, (createdAt) => {
        const urgentDeadline = slaDeadline(createdAt, true);
        const standardDeadline = slaDeadline(createdAt, false);
        expect(urgentDeadline.getTime()).toBeLessThan(standardDeadline.getTime());
      }),
      FC_CONFIG,
    );
  });

  // Concrete examples anchoring the two windows.
  it("computes a 72h urgent deadline for a fixed timestamp", () => {
    const createdAt = new Date("2026-01-15T12:00:00.000Z");
    expect(slaDeadline(createdAt, true)).toEqual(new Date("2026-01-18T12:00:00.000Z"));
  });

  it("computes a 7-day standard deadline for a fixed timestamp", () => {
    const createdAt = new Date("2026-01-15T12:00:00.000Z");
    expect(slaDeadline(createdAt, false)).toEqual(new Date("2026-01-22T12:00:00.000Z"));
  });
});
