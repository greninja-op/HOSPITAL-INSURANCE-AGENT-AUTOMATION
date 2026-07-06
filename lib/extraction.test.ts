// =============================================================================
// lib/extraction.test.ts
//
// Unit tests for the pure Extracted_Field builders (Requirements 2.1–2.4, 9.1).
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  ENTITY_FIELD_NAMES,
  UNKNOWN_CONFIDENCE,
  UNKNOWN_VALUE,
  buildEntityExtractionFields,
  buildExtractedField,
  buildExtractedFields,
  type EntityProposal,
} from "@/lib/extraction";

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
