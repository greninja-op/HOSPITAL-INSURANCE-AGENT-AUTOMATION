/**
 * Property test — Missing policy-required evidence is flagged.
 *
 * // Feature: authpilot, Property 12: Missing policy-required evidence is flagged
 * **Validates: Requirements 4.2**
 *
 * For any (policy-required-evidence set, available-evidence set),
 * `detectEvidenceGaps` flags EXACTLY the required items that are NOT present in
 * the available evidence:
 *   • none spuriously flagged — a requirement satisfied by some available
 *     evidence text is never reported as a gap;
 *   • none missed — every requirement absent from the available evidence is
 *     reported as a gap.
 * i.e. the set of flagged requirement ids equals the set difference
 * (required − present).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { SourceType } from "./types";
import {
  detectEvidenceGaps,
  type PolicyEvidenceRequirement,
  type AvailableEvidence,
  type SourceRef,
} from "./detection";
import { FC_CONFIG } from "./testConfig";

const SOURCE_TYPES: readonly SourceType[] = [
  "raw_intake",
  "chart_note",
  "payer_policy",
  "code_lookup",
  "human_provided",
];

const arbSourceRef: fc.Arbitrary<SourceRef> = fc.record({
  sourceType: fc.constantFrom<SourceType>(...SOURCE_TYPES),
  label: fc.string(),
});

/**
 * A fixed-length (6), lowercase-letter token. Fixed length + global uniqueness
 * guarantees no token is a substring of another, so a term satisfies exactly the
 * one requirement it belongs to — the detection is a clean substring match.
 */
const arbToken: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
    minLength: 6,
    maxLength: 6,
  })
  .map((chars) => chars.join(""));

/**
 * A generated scenario: a set of policy requirements (each keyed by a unique
 * match token), a per-requirement "present" flag, casing/noise variation, and
 * the expected set of gap requirement ids derived directly from the flags.
 */
const arbScenario = fc
  .uniqueArray(arbToken, { minLength: 0, maxLength: 8 })
  .chain((tokens) =>
    fc.record({
      tokens: fc.constant(tokens),
      // Whether each requirement's evidence is present in the available sources.
      present: fc.array(fc.boolean(), {
        minLength: tokens.length,
        maxLength: tokens.length,
      }),
      // Whether the present token appears upper-cased (exercises case-insensitivity).
      upper: fc.array(fc.boolean(), {
        minLength: tokens.length,
        maxLength: tokens.length,
      }),
      sources: fc.array(arbSourceRef, {
        minLength: tokens.length,
        maxLength: tokens.length,
      }),
      // Digit-only noise evidence that can never contain a lowercase token.
      noise: fc.array(
        fc
          .array(fc.constantFrom(..."0123456789 ".split("")), {
            minLength: 0,
            maxLength: 12,
          })
          .map((cs) => cs.join("")),
        { maxLength: 4 },
      ),
    }),
  )
  .map(({ tokens, present, upper, sources, noise }) => {
    const requirements: PolicyEvidenceRequirement[] = tokens.map((token, i) => ({
      id: `req-${token}`,
      description: `evidence ${token}`,
      matchTerms: [token],
    }));

    const availableEvidence: AvailableEvidence[] = [];
    const expectedGapIds: string[] = [];

    tokens.forEach((token, i) => {
      if (present[i]) {
        const term = upper[i] ? token.toUpperCase() : token;
        availableEvidence.push({
          source: sources[i] ?? { sourceType: "chart_note", label: "note" },
          text: `record contains ${term} as supporting evidence`,
        });
      } else {
        expectedGapIds.push(`req-${token}`);
      }
    });

    // Interleave digit-only noise that satisfies no requirement.
    noise.forEach((text, i) => {
      availableEvidence.push({
        source: { sourceType: "raw_intake", label: `noise-${i}` },
        text,
      });
    });

    return { requirements, availableEvidence, expectedGapIds };
  });

describe("Missing policy-required evidence flagging (Property 12)", () => {
  it("flags exactly the required evidence absent from the available sources", () => {
    fc.assert(
      fc.property(arbScenario, ({ requirements, availableEvidence, expectedGapIds }) => {
        const gaps = detectEvidenceGaps(requirements, availableEvidence);
        const flaggedIds = gaps.map((g) => g.requirementId).sort();

        // The flagged set equals the set difference (required − present):
        // none spuriously flagged, none missed (Req 4.2).
        expect(flaggedIds).toEqual([...expectedGapIds].sort());
      }),
      FC_CONFIG,
    );
  });

  it("never flags a requirement whose evidence is present, regardless of casing", () => {
    fc.assert(
      fc.property(arbScenario, ({ requirements, availableEvidence, expectedGapIds }) => {
        const gaps = detectEvidenceGaps(requirements, availableEvidence);
        const flagged = new Set(gaps.map((g) => g.requirementId));
        const expectedGaps = new Set(expectedGapIds);

        for (const req of requirements) {
          // A satisfied requirement (not in the expected-gap set) is never flagged.
          if (!expectedGaps.has(req.id)) {
            expect(flagged.has(req.id)).toBe(false);
          }
        }
      }),
      FC_CONFIG,
    );
  });
});
