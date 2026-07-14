// =============================================================================
// lib/decisionEngine.test.ts
//
// Property-based tests for the pure Decision_Engine (`lib/decisionEngine.ts`).
//
// This single file covers both Decision_Engine properties:
//
//   • Property 14 — Decision engine mapping (`decide`)
//     For any decision input (overall confidence in [0, 100], contradiction
//     count >= 0, iterations-exhausted flag), the Decision_Engine returns:
//     Escalate_To_Human (status NeedsHumanInput) when iterations are exhausted
//     or the contradiction count is greater than 0; otherwise Auto_Draft
//     (status AwaitingApproval) when confidence > 85; otherwise
//     Draft_And_Request_Evidence (status AwaitingApproval) when
//     60 <= confidence <= 85; otherwise Escalate_To_Human (status
//     NeedsHumanInput) when confidence < 60.
//     **Validates: Requirements 4.4, 5.3, 5.4, 5.5, 5.7, 5.8, 5.9**
//
//   • Property 15 — Overall confidence stays in range
//     (`computeOverallConfidence`) For any set of extracted-field confidences,
//     the aggregate result is clamped to [0, 100].
//     **Validates: Requirements 5.1**
// =============================================================================

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  computeOverallConfidence,
  decide,
  type ConfidenceLike,
  type DecisionInput,
} from "@/lib/decisionEngine";
import { FC_CONFIG } from "@/lib/testConfig";

// ─── Property 14: Decision engine mapping (task 3.2) ─────────────────────────

/**
 * A confidence generator that emphasises the two routing boundaries (60 and
 * 85). It mixes broad-range floats/ints across [0, 100] with values clustered
 * tightly around each boundary (and the exact boundary values themselves), so
 * the "> 85" vs ">= 60" edge behaviour is exercised heavily.
 */
const confidenceArb = fc.oneof(
  // Broad coverage of the whole valid range.
  fc.float({ min: 0, max: 100, noNaN: true }),
  fc.integer({ min: 0, max: 100 }),
  // Exact boundary values (must land in the documented bands).
  fc.constantFrom(0, 59, 60, 61, 84, 85, 86, 100),
  // Tight clusters just below / at / just above each boundary.
  fc.float({ min: 59, max: 61, noNaN: true }),
  fc.float({ min: 84, max: 86, noNaN: true }),
);

/**
 * Decision-input generator. Independently varies confidence, the blocking
 * contradiction count (>= 0, weighted toward 0 so the confidence bands are
 * reachable), and the iterations-exhausted flag.
 */
const decisionInputArb: fc.Arbitrary<DecisionInput> = fc.record({
  overallConfidence: confidenceArb,
  contradictionCount: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 10 })),
  iterationsExhausted: fc.boolean(),
});

describe("decide (Property 14: Decision_Engine mapping)", () => {
  it("maps every decision input to the documented path and derived status (Property 14)", () => {
    fc.assert(
      fc.property(decisionInputArb, (input) => {
        const result = decide(input);

        if (input.iterationsExhausted || input.contradictionCount > 0) {
          // Rule 1 — contradictions / exhausted loop dominate confidence (Req 4.4).
          expect(result.path).toBe("Escalate_To_Human");
          expect(result.status).toBe("NeedsHumanInput"); // Req 5.9
        } else if (input.overallConfidence > 85) {
          // Rule 2 — high confidence, no contradictions (Req 5.3).
          expect(result.path).toBe("Auto_Draft");
          expect(result.status).toBe("AwaitingApproval"); // Req 5.7
        } else if (input.overallConfidence >= 60) {
          // Rule 3 — medium band [60, 85] (Req 5.4).
          expect(result.path).toBe("Draft_And_Request_Evidence");
          expect(result.status).toBe("AwaitingApproval"); // Req 5.8
        } else {
          // Rule 4 — low confidence < 60 (Req 5.5).
          expect(result.path).toBe("Escalate_To_Human");
          expect(result.status).toBe("NeedsHumanInput"); // Req 5.9
        }
      }),
      FC_CONFIG,
    );
  });

  it("always derives status solely from path (Req 5.7, 5.8, 5.9)", () => {
    fc.assert(
      fc.property(decisionInputArb, (input) => {
        const { path, status } = decide(input);
        const expected =
          path === "Escalate_To_Human" ? "NeedsHumanInput" : "AwaitingApproval";
        expect(status).toBe(expected);
      }),
      FC_CONFIG,
    );
  });
});

// ─── Property 15: Overall confidence stays in range (task 3.4) ───────────────

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
