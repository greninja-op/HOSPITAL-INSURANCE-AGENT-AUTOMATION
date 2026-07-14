// =============================================================================
// lib/extraction.test.ts
//
// Unit tests for the pure Extracted_Field builders (Requirements 2.1–2.4, 9.1).
// =============================================================================

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ENTITY_FIELD_NAMES,
  UNKNOWN_CONFIDENCE,
  UNKNOWN_VALUE,
  buildEntityExtractionFields,
  buildExtractedField,
  buildExtractedFields,
  type EntityProposal,
  type EntityProposalSet,
} from "@/lib/extraction";
import { FC_CONFIG } from "@/lib/testConfig";
import type { PipelineStage, SourceType } from "@/lib/types";

const FIXED = new Date("2026-01-15T12:00:00.000Z");
const clock = () => FIXED;

function proposal(overrides: Partial<EntityProposal> = {}): EntityProposal {
  return {
    fieldName: "patient",
    value: "Jane Doe",
    confidence: 90,
    sourceType: "raw_intake",
    reasoning: "Named in the denial letter header.",
    originatingStep: { stage: "Intake_And_Extraction" },
    ...overrides,
  };
}

describe("buildExtractedField", () => {
  it("stores field name, value, confidence, source type, reasoning, timestamp, and step (Req 2.2, 9.1)", () => {
    const field = buildExtractedField(proposal(), clock);
    expect(field).toEqual({
      fieldName: "patient",
      value: "Jane Doe",
      confidence: 90,
      sourceType: "raw_intake",
      reasoning: "Named in the denial letter header.",
      timestamp: FIXED,
      originatingStep: { stage: "Intake_And_Extraction" },
    });
  });

  it("preserves a tool reference on the originating step (Req 9.1)", () => {
    const field = buildExtractedField(
      proposal({
        fieldName: "diagnosisCode",
        value: "E11.9",
        sourceType: "code_lookup",
        originatingStep: { stage: "Intake_And_Extraction", tool: "lookupDiagnosisCode" },
      }),
      clock,
    );
    expect(field.originatingStep).toEqual({
      stage: "Intake_And_Extraction",
      tool: "lookupDiagnosisCode",
    });
  });

  it("trims a determinable value", () => {
    const field = buildExtractedField(proposal({ value: "  Aetna  " }), clock);
    expect(field.value).toBe("Aetna");
  });

  it.each([undefined, null, "", "   ", "unknown", "UNKNOWN", "  Unknown  "])(
    "records value 'unknown' and confidence 0 for undeterminable value %p (Req 2.3)",
    (value) => {
      const field = buildExtractedField(
        proposal({ value: value as string | null | undefined, confidence: 88 }),
        clock,
      );
      expect(field.value).toBe(UNKNOWN_VALUE);
      expect(field.confidence).toBe(UNKNOWN_CONFIDENCE);
    },
  );

  it.each([
    [150, 100],
    [-20, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [72.5, 72.5],
  ])("clamps a determinable confidence %p into [0,100] → %p (Req 2.2)", (input, expected) => {
    const field = buildExtractedField(proposal({ confidence: input }), clock);
    expect(field.confidence).toBe(expected);
  });

  it("defaults confidence to 0 when none is proposed", () => {
    const field = buildExtractedField(proposal({ confidence: undefined }), clock);
    expect(field.confidence).toBe(0);
  });
});

describe("buildExtractedFields", () => {
  it("shares one timestamp across all fields in a pass", () => {
    let calls = 0;
    const countingClock = () => {
      calls += 1;
      return new Date(FIXED.getTime() + calls * 1000);
    };
    const fields = buildExtractedFields(
      [proposal({ fieldName: "patient" }), proposal({ fieldName: "payer", value: "Aetna" })],
      countingClock,
    );
    expect(calls).toBe(1);
    expect(fields[0].timestamp).toEqual(fields[1].timestamp);
  });
});

describe("buildEntityExtractionFields", () => {
  it("always produces exactly the five entity fields in fixed order (Req 2.1)", () => {
    const fields = buildEntityExtractionFields({}, clock);
    expect(fields.map((f) => f.fieldName)).toEqual([...ENTITY_FIELD_NAMES]);
  });

  it("records missing entities as unknown / 0 (Req 2.1, 2.3)", () => {
    const fields = buildEntityExtractionFields(
      {
        patient: {
          value: "Jane Doe",
          confidence: 95,
          sourceType: "raw_intake",
          reasoning: "Header name.",
          originatingStep: { stage: "Intake_And_Extraction" },
        },
      },
      clock,
    );
    const byName = Object.fromEntries(fields.map((f) => [f.fieldName, f]));
    expect(byName.patient.value).toBe("Jane Doe");
    expect(byName.payer.value).toBe(UNKNOWN_VALUE);
    expect(byName.payer.confidence).toBe(UNKNOWN_CONFIDENCE);
    expect(byName.diagnosisCode.value).toBe(UNKNOWN_VALUE);
  });

  it("is deterministic for identical inputs", () => {
    const set = {
      procedureCode: {
        value: "70553",
        confidence: 80,
        sourceType: "code_lookup" as const,
        reasoning: "MRI brain.",
        originatingStep: { stage: "Intake_And_Extraction" as const },
      },
    };
    expect(buildEntityExtractionFields(set, clock)).toEqual(
      buildEntityExtractionFields(set, clock),
    );
  });
});

// =============================================================================
// Property-based tests (fast-check) for the Extracted_Field builders.
//
// These complement the example-based tests above by exercising the builders
// across the whole input space with smart generators constrained to the
// determinable / undeterminable value partitions.
// =============================================================================

/** All allowed Extracted_Field source types (Req 2.4). */
const SOURCE_TYPES: readonly SourceType[] = [
  "raw_intake",
  "chart_note",
  "payer_policy",
  "code_lookup",
  "human_provided",
];

/** A handful of valid originating stages for the step reference (Req 9.1). */
const STAGE_VALUES: readonly PipelineStage[] = [
  "Intake_And_Extraction",
  "Medical_Review",
  "Policy_Review",
];

/**
 * Determinable value generator: after trimming, non-empty and NOT the literal
 * "unknown" sentinel (case-insensitive). Padding is added so trimming is real.
 */
const determinableValueArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0 && s.trim().toLowerCase() !== UNKNOWN_VALUE);

/**
 * Undeterminable value generator: null / undefined / blank / whitespace-only /
 * the "unknown" sentinel in assorted casings (Req 2.3).
 */
const undeterminableValueArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(""),
  fc.constantFrom("   ", "\t", "\n  ", "  \t "),
  fc.constantFrom("unknown", "UNKNOWN", "  Unknown  ", "UnKnOwN", "unKNOWN"),
);

/** Confidence generator spanning in-range, out-of-range, and non-finite values. */
const confidenceArb = fc.oneof(
  fc.double(),
  fc.integer({ min: -200, max: 300 }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);

/** Originating step generator with an optional tool reference (Req 9.1). */
const stepArb = fc.record({
  stage: fc.constantFrom(...STAGE_VALUES),
  tool: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
});

/** A full single proposal (any of the five entities, either value partition). */
const proposalArb: fc.Arbitrary<EntityProposal> = fc.record({
  fieldName: fc.constantFrom(...ENTITY_FIELD_NAMES),
  value: fc.oneof(determinableValueArb, undeterminableValueArb),
  confidence: fc.option(confidenceArb, { nil: undefined }),
  sourceType: fc.constantFrom(...SOURCE_TYPES),
  reasoning: fc.string({ minLength: 1, maxLength: 60 }),
  originatingStep: stepArb,
});

/** A single per-entity proposal entry (fieldName supplied by the set key). */
const entryArb = fc.record({
  value: fc.oneof(determinableValueArb, undeterminableValueArb),
  confidence: fc.option(confidenceArb, { nil: undefined }),
  sourceType: fc.constantFrom(...SOURCE_TYPES),
  reasoning: fc.string({ minLength: 1, maxLength: 60 }),
  originatingStep: stepArb,
});

/**
 * An EntityProposalSet covering any subset of the five entities (including the
 * empty set and the full set), so omitted entities exercise the unknown/0 path.
 */
const proposalSetArb: fc.Arbitrary<EntityProposalSet> = fc
  .subarray([...ENTITY_FIELD_NAMES], { minLength: 0 })
  .chain((names) =>
    fc
      .tuple(...names.map(() => entryArb))
      .map(
        (entries) =>
          Object.fromEntries(
            names.map((name, i) => [name, entries[i]]),
          ) as EntityProposalSet,
      ),
  );

describe("Property 3: required entities are extracted (Req 2.1)", () => {
  // **Validates: Requirements 2.1**
  it("always produces exactly one Extracted_Field for each of the five required entities", () => {
    fc.assert(
      fc.property(proposalSetArb, (set) => {
        const fields = buildEntityExtractionFields(set, clock);
        // Exactly the five required entities, one Extracted_Field each.
        expect(fields).toHaveLength(ENTITY_FIELD_NAMES.length);
        const names = fields.map((f) => f.fieldName);
        expect(new Set(names)).toEqual(new Set(ENTITY_FIELD_NAMES));
        for (const entity of ENTITY_FIELD_NAMES) {
          expect(names.filter((n) => n === entity)).toHaveLength(1);
        }
      }),
      FC_CONFIG,
    );
  });
});

describe("Property 4: extracted field completeness (Req 2.2, 2.4, 9.1)", () => {
  // **Validates: Requirements 2.2, 2.4, 9.1**
  it("every produced Extracted_Field carries all required attributes", () => {
    fc.assert(
      fc.property(fc.array(proposalArb, { minLength: 1, maxLength: 8 }), (proposals) => {
        const fields = buildExtractedFields(proposals, clock);
        for (const f of fields) {
          // Field name — a recognised entity name.
          expect(typeof f.fieldName).toBe("string");
          expect(ENTITY_FIELD_NAMES).toContain(f.fieldName);
          // Value — always a non-empty string (a real value or the sentinel).
          expect(typeof f.value).toBe("string");
          expect(f.value.length).toBeGreaterThan(0);
          // Confidence — a finite number within [0, 100] (Req 2.2).
          expect(typeof f.confidence).toBe("number");
          expect(Number.isFinite(f.confidence)).toBe(true);
          expect(f.confidence).toBeGreaterThanOrEqual(0);
          expect(f.confidence).toBeLessThanOrEqual(100);
          // Source type — one of the allowed provenance values (Req 2.4).
          expect(SOURCE_TYPES).toContain(f.sourceType);
          // Reasoning — present as a string.
          expect(typeof f.reasoning).toBe("string");
          // Timestamp — a Date (Req 2.2).
          expect(f.timestamp).toBeInstanceOf(Date);
          // Originating step reference — present with a valid stage (Req 9.1).
          expect(f.originatingStep).toBeDefined();
          expect(typeof f.originatingStep.stage).toBe("string");
          expect(f.originatingStep.stage.length).toBeGreaterThan(0);
        }
      }),
      FC_CONFIG,
    );
  });

  it("guarantees the same complete attribute set for every entity in a full pass", () => {
    fc.assert(
      fc.property(proposalSetArb, (set) => {
        const fields = buildEntityExtractionFields(set, clock);
        for (const f of fields) {
          expect(Object.keys(f).sort()).toEqual(
            [
              "confidence",
              "fieldName",
              "originatingStep",
              "reasoning",
              "sourceType",
              "timestamp",
              "value",
            ].sort(),
          );
          expect(SOURCE_TYPES).toContain(f.sourceType);
          expect(f.timestamp).toBeInstanceOf(Date);
          expect(f.originatingStep.stage.length).toBeGreaterThan(0);
        }
      }),
      FC_CONFIG,
    );
  });
});

describe("Property 5: undetermined entities are marked unknown (Req 2.3)", () => {
  // **Validates: Requirements 2.3**
  it("records value 'unknown' and confidence 0 for any undeterminable proposal", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ENTITY_FIELD_NAMES),
        undeterminableValueArb,
        fc.option(confidenceArb, { nil: undefined }),
        fc.constantFrom(...SOURCE_TYPES),
        stepArb,
        (fieldName, value, confidence, sourceType, originatingStep) => {
          const field = buildExtractedField(
            {
              fieldName,
              value: value as string | null | undefined,
              confidence,
              sourceType,
              reasoning: "no determinable value",
              originatingStep,
            },
            clock,
          );
          expect(field.value).toBe(UNKNOWN_VALUE);
          expect(field.confidence).toBe(UNKNOWN_CONFIDENCE);
        },
      ),
      FC_CONFIG,
    );
  });

  it("marks entities omitted from the proposal set as unknown / 0", () => {
    fc.assert(
      fc.property(proposalSetArb, (set) => {
        const fields = buildEntityExtractionFields(set, clock);
        const byName = Object.fromEntries(fields.map((f) => [f.fieldName, f]));
        for (const entity of ENTITY_FIELD_NAMES) {
          const proposed = set[entity];
          const isProposedUnknown =
            proposed === undefined ||
            proposed.value === null ||
            proposed.value === undefined ||
            proposed.value.trim().length === 0 ||
            proposed.value.trim().toLowerCase() === UNKNOWN_VALUE;
          if (isProposedUnknown) {
            expect(byName[entity].value).toBe(UNKNOWN_VALUE);
            expect(byName[entity].confidence).toBe(UNKNOWN_CONFIDENCE);
          }
        }
      }),
      FC_CONFIG,
    );
  });
});
