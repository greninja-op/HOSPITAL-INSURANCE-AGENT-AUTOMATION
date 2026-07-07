// =============================================================================
// lib/decisionEngine.test.ts
//
// Property-based test for the pure Decision_Engine mapping (`decide`).
//
// Feature: authpilot, Property 14: Decision engine mapping — For any decision
// input (overall confidence in [0, 100], contradiction count >= 0,
// iterations-exhausted flag), the Decision_Engine returns: Escalate_To_Human
// (status NeedsHumanInput) when iterations are exhausted or the contradiction
// count is greater than 0; otherwise Auto_Draft (status AwaitingApproval) when
// confidence > 85; otherwise Draft_And_Request_Evidence (status
// AwaitingApproval) when 60 <= confidence <= 85; otherwise Escalate_To_Human
// (status NeedsHumanInput) when confidence < 60.
//
// **Validates: Requirements 4.4, 5.3, 5.4, 5.5, 5.7, 5.8, 5.9**
// =============================================================================

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decide, type DecisionInput } from "@/lib/decisionEngine";
import { FC_CONFIG } from "@/lib/testConfig";

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
  contradictionCount: fc.oneof(
    fc.constant(0),
    fc.integer({ min: 0, max: 10 }),
  ),
  iterationsExhausted: fc.boolean(),
});

describe("decide (Decision_Engine mapping)", () => {
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
