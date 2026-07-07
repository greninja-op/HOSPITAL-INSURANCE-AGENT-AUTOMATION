// =============================================================================
// lib/decisionEngine.confidence.test.ts
//
// Property-based test for `computeOverallConfidence()` (Requirement 5.1).
//
// Feature: authpilot, Property 15: Overall confidence stays in range
// Validates: Requirements 5.1
//
// This lives in its own file (separate from decisionEngine.test.ts) so the
// Property 15 confidence-range test does not collide with the Property 14
// decision-mapping tests authored in parallel.
// =============================================================================

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { computeOverallConfidence, type ConfidenceLike } from "@/lib/decisionEngine";
import { FC_CONFIG } from "@/lib/testConfig";

/**
 * A generator for a single confidence input. It intentionally covers the whole
 * input space the aggregator must tolerate:
 *   - in-range scores [0, 100] (typical),
 *   - out-of-range and negative values,
 *   - non-finite values (NaN / ±Infinity),
 *   - both the bare-number and `{ confidence }` object shapes.
 */
const confidenceLikeArb: fc.Arbitrary<ConfidenceLike> = fc.oneof(
  // Well-formed in-range scores (the common case).
  fc.integer({ min: 0, max: 100 }),
  fc.double({ min: 0, max: 100, noNaN: true }),
  // Out-of-range / negative / extreme values the clamp must absorb.
  fc.double({ min: -1_000_000, max: 1_000_000 }),
  // Explicit non-finite readings.
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
  // The `{ confidence }` object shape (mirrors ExtractedField).
  fc
    .double({ min: -1_000_000, max: 1_000_000 })
    .map((confidence): ConfidenceLike => ({ confidence })),
);

describe("computeOverallConfidence (Property 15: overall confidence stays in range)", () => {
  it("always returns a number within [0, 100] for any set of confidence inputs (Req 5.1)", () => {
    fc.assert(
      fc.property(fc.array(confidenceLikeArb), (fields) => {
        const result = computeOverallConfidence(fields);
        expect(typeof result).toBe("number");
        expect(Number.isNaN(result)).toBe(false);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(100);
      }),
      FC_CONFIG,
    );
  });

  it("returns 0 for empty input (Req 5.1)", () => {
    expect(computeOverallConfidence([])).toBe(0);
  });

  it("returns 0 when every field is zero-confidence (Req 5.1)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (count) => {
        const fields = Array.from({ length: count }, () => 0 as ConfidenceLike);
        expect(computeOverallConfidence(fields)).toBe(0);
      }),
      FC_CONFIG,
    );
  });

  it("returns 100 when every field is at the maximum (Req 5.1)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (count) => {
        const fields = Array.from({ length: count }, () => 100 as ConfidenceLike);
        expect(computeOverallConfidence(fields)).toBe(100);
      }),
      FC_CONFIG,
    );
  });

  it("stays within [0, 100] even when all inputs are out of range (Req 5.1)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.double({ min: 100.0001, max: 1_000_000 }),
            fc.double({ min: -1_000_000, max: -0.0001 }),
          ),
          { minLength: 1 },
        ),
        (fields) => {
          const result = computeOverallConfidence(fields);
          expect(result).toBeGreaterThanOrEqual(0);
          expect(result).toBeLessThanOrEqual(100);
        },
      ),
      FC_CONFIG,
    );
  });
});
