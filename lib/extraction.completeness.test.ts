// =============================================================================
// lib/extraction.completeness.test.ts
//
// Property 4: Extracted field completeness.
//
// **Validates: Requirements 2.2, 2.4, 9.1**
//
// *For any* Extracted_Field the system records, it has a non-empty field name,
// a value, a Confidence_Score within [0, 100], a source type within the allowed
// provenance set, non-empty reasoning, a timestamp, and an originating tool or
// agent step reference.
//
// This file focuses exclusively on the completeness property. The example-based
// builder tests live in `lib/extraction.test.ts`; this file exercises the
// builders across the whole input space with fast-check and asserts that EVERY
// produced Extracted_Field is COMPLETE and well-formed.
// =============================================================================

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ENTITY_FIELD_NAMES,
  buildEntityExtractionFields,
  buildExtractedFields,
  type EntityProposal,
  type EntityProposalSet,
  type ExtractedFieldRecord,
} from "@/lib/extraction";
import { FC_CONFIG } from "@/lib/testConfig";
import type { PipelineStage, SourceType } from "@/lib/types";

// ─── Allowed value sets ──────────────────────────────────────────────────────

/** All allowed Extracted_Field source types (Req 2.4). */
const SOURCE_TYPES: readonly SourceType[] = [
  "raw_intake",
  "chart_note",
  "payer_policy",
  "code_lookup",
  "human_provided",
];

/** Valid originating stages for the step reference (Req 9.1). */
const STAGE_VALUES: readonly PipelineStage[] = [
  "Intake_And_Extraction",
  "Medical_Review",
  "Policy_Review",
  "Strategy",
  "Decision_Intelligence",
  "Appeal_Generation",
  "Verification_QA",
  "Human_Approval",
  "Submission_And_Tracking",
];

// ─── Smart generators (constrained to the real input space) ──────────────────

/**
 * Determinable value: after trimming, non-empty and NOT the "unknown" sentinel.
 * Padding is included so trimming inside the builder is genuinely exercised.
 */
const determinableValueArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0 && s.trim().toLowerCase() !== "unknown");

/** Undeterminable value: null / undefined / blank / whitespace / "unknown". */
const undeterminableValueArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(""),
  fc.constantFrom("   ", "\t", "\n  ", "  \t "),
  fc.constantFrom("unknown", "UNKNOWN", "  Unknown  ", "UnKnOwN"),
);

/** Confidence spanning in-range, out-of-range, and non-finite values (Req 2.2). */
const confidenceArb = fc.oneof(
  fc.double(),
  fc.integer({ min: -200, max: 300 }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);

/** Originating step with an optional tool reference (Req 9.1). */
const stepArb = fc.record({
  stage: fc.constantFrom(...STAGE_VALUES),
  tool: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
});

/** A single full proposal — any entity, either value partition. */
const proposalArb: fc.Arbitrary<EntityProposal> = fc.record({
  fieldName: fc.constantFrom(...ENTITY_FIELD_NAMES),
  value: fc.oneof(determinableValueArb, undeterminableValueArb),
  confidence: fc.option(confidenceArb, { nil: undefined }),
  sourceType: fc.constantFrom(...SOURCE_TYPES),
  reasoning: fc.string({ minLength: 1, maxLength: 60 }),
  originatingStep: stepArb,
});

/** A single per-entity set entry (fieldName supplied by the set key). */
const entryArb = fc.record({
  value: fc.oneof(determinableValueArb, undeterminableValueArb),
  confidence: fc.option(confidenceArb, { nil: undefined }),
  sourceType: fc.constantFrom(...SOURCE_TYPES),
  reasoning: fc.string({ minLength: 1, maxLength: 60 }),
  originatingStep: stepArb,
});

/** Any subset of the five entities (incl. empty and full sets). */
const proposalSetArb: fc.Arbitrary<EntityProposalSet> = fc
  .subarray([...ENTITY_FIELD_NAMES], { minLength: 0 })
  .chain((names) =>
    fc
      .tuple(...names.map(() => entryArb))
      .map(
        (entries) =>
          Object.fromEntries(names.map((name, i) => [name, entries[i]])) as EntityProposalSet,
      ),
  );

// ─── Shared completeness assertion ───────────────────────────────────────────

/**
 * Assert a single Extracted_Field record is COMPLETE and well-formed against
 * every attribute the completeness property requires (Req 2.2, 2.4, 9.1).
 */
function expectComplete(f: ExtractedFieldRecord): void {
  // Field name — present, non-empty, a recognised entity name.
  expect(typeof f.fieldName).toBe("string");
  expect(f.fieldName.length).toBeGreaterThan(0);
  expect(ENTITY_FIELD_NAMES).toContain(f.fieldName);

  // Value — defined and a non-empty string (a real value or the sentinel).
  expect(f.value).toBeDefined();
  expect(typeof f.value).toBe("string");
  expect(f.value.length).toBeGreaterThan(0);

  // Confidence — a finite number within [0, 100] (Req 2.2).
  expect(typeof f.confidence).toBe("number");
  expect(Number.isFinite(f.confidence)).toBe(true);
  expect(f.confidence).toBeGreaterThanOrEqual(0);
  expect(f.confidence).toBeLessThanOrEqual(100);

  // Source type — one of the allowed provenance values (Req 2.4).
  expect(SOURCE_TYPES).toContain(f.sourceType);

  // Reasoning — present and a non-empty string (Req 2.2).
  expect(typeof f.reasoning).toBe("string");
  expect(f.reasoning.length).toBeGreaterThan(0);

  // Timestamp — a valid Date (Req 2.2).
  expect(f.timestamp).toBeInstanceOf(Date);
  expect(Number.isNaN(f.timestamp.getTime())).toBe(false);

  // Originating tool or agent step reference — present with a valid stage (Req 9.1).
  expect(f.originatingStep).toBeDefined();
  expect(typeof f.originatingStep.stage).toBe("string");
  expect(f.originatingStep.stage.length).toBeGreaterThan(0);
  expect(STAGE_VALUES).toContain(f.originatingStep.stage);
  if (f.originatingStep.tool !== undefined) {
    expect(typeof f.originatingStep.tool).toBe("string");
    expect(f.originatingStep.tool.length).toBeGreaterThan(0);
  }
}

const FIXED = new Date("2026-01-15T12:00:00.000Z");
const clock = () => FIXED;

// ─── Property 4 ──────────────────────────────────────────────────────────────

describe("Property 4: Extracted field completeness (Req 2.2, 2.4, 9.1)", () => {
  // **Validates: Requirements 2.2, 2.4, 9.1**
  it("every field built from an arbitrary list of proposals is complete", () => {
    fc.assert(
      fc.property(fc.array(proposalArb, { minLength: 1, maxLength: 12 }), (proposals) => {
        const fields = buildExtractedFields(proposals, clock);
        // One record per input proposal, each complete.
        expect(fields).toHaveLength(proposals.length);
        for (const f of fields) {
          expectComplete(f);
        }
      }),
      FC_CONFIG,
    );
  });

  // **Validates: Requirements 2.2, 2.4, 9.1**
  it("every one of the five entity fields is complete, for any proposal subset", () => {
    fc.assert(
      fc.property(proposalSetArb, (set) => {
        const fields = buildEntityExtractionFields(set, clock);
        expect(fields).toHaveLength(ENTITY_FIELD_NAMES.length);
        for (const f of fields) {
          expectComplete(f);
        }
      }),
      FC_CONFIG,
    );
  });
});
