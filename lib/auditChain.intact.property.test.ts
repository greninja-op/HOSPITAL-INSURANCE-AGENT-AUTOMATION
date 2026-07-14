/**
 * lib/auditChain.intact.property.test.ts
 *
 * Property test (Task 23.6): an untampered Audit_Chain verifies as intact.
 *
 * For an arbitrary generated list of audit-event contents, computing the chain
 * links (prevHash/hash) with the real `computeChainHashes` and then verifying
 * with `verifyAuditChain` must yield an intact result with no tamper
 * localization (`firstBrokenEventId`/`reason` absent), and the reported
 * `headHash` must be the stored hash of the most recent event (GENESIS_HASH for
 * an empty chain). Chains of length 0..N all verify as intact when unmodified.
 *
 * Uses Vitest + fast-check (numRuns 100), consistent with the rest of the suite.
 *
 * Validates: Requirements 25.1, 25.2, 25.4, 25.7
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  GENESIS_HASH,
  computeChainHashes,
  verifyAuditChain,
  type AuditEvent,
  type AuditEventContent,
} from "./auditChain";

/**
 * Arbitrary for a single audit-event content. Exercises the optional/nullable
 * content fields (toolName, input, output, beforeState, afterState, caseId)
 * with varied JSON values so canonical serialization and hashing see diverse
 * shapes.
 */
const jsonValue = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.double({ noNaN: true }),
  fc.string(),
  fc.array(fc.string(), { maxLength: 4 }),
  fc.dictionary(fc.string(), fc.string(), { maxKeys: 4 }),
);

const eventContentArb: fc.Arbitrary<AuditEventContent> = fc.record({
  stepType: fc.constantFrom(
    "tool_call",
    "reasoning",
    "human_action",
    "decision",
    "observation",
    "plan",
    "final",
  ),
  toolName: fc.option(fc.string(), { nil: undefined }),
  input: jsonValue,
  output: jsonValue,
  reasoning: fc.string(),
  beforeState: fc.option(jsonValue, { nil: undefined }),
  afterState: fc.option(jsonValue, { nil: undefined }),
  caseId: fc.option(fc.string(), { nil: undefined }),
});

/**
 * Build an ordered list of stored AuditEvents from generated content by running
 * the real chain-hashing, then attaching stable ids (as the caller would).
 */
function buildChain(contents: readonly AuditEventContent[]): AuditEvent[] {
  return computeChainHashes(contents).map((e, i) => ({
    ...e,
    id: `evt-${i}`,
  }));
}

describe("auditChain — untampered chain verifies as intact (Task 23.6)", () => {
  it("verifies an unmodified chain of length 0..N as intact with no tamper localization", () => {
    fc.assert(
      fc.property(
        fc.array(eventContentArb, { minLength: 0, maxLength: 12 }),
        (contents) => {
          const chain = buildChain(contents);
          const result = verifyAuditChain(chain);

          // Intact, and never localizes tampering on an unmodified chain.
          expect(result.intact).toBe(true);
          expect(result.firstBrokenEventId).toBeUndefined();
          expect(result.reason).toBeUndefined();

          // headHash is the stored hash of the most recent event, or GENESIS
          // for the empty chain (Req 25.7).
          const expectedHead =
            chain.length === 0 ? GENESIS_HASH : chain[chain.length - 1].hash;
          expect(result.headHash).toBe(expectedHead);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("verifies the empty chain as trivially intact with GENESIS headHash", () => {
    const result = verifyAuditChain([]);
    expect(result.intact).toBe(true);
    expect(result.headHash).toBe(GENESIS_HASH);
    expect(result.firstBrokenEventId).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });
});
