// =============================================================================
// lib/extraction.requiredEntities.test.ts
//
// Property 3: Required entities are extracted (Requirement 2.1).
//
// This file adds the DISTINCT required-entity-coverage property for
// `buildEntityExtractionFields`: for ANY extraction input, the construction
// produces an Extracted_Field for EACH of the five required entities — patient,
// payer, procedure code, diagnosis code, and denial reason — keyed by field
// name, with none omitted.
//
// The example-based and set-membership coverage lives in `extraction.test.ts`.
// Here the focus is complementary: build a lookup KEYED BY FIELD NAME from the
// produced records and assert every required entity key resolves to exactly one
// record, no matter which subset of entities the extraction proposed (including
// none at all, and including proposals whose values are undeterminable).
// =============================================================================

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ENTITY_FIELD_NAMES,
  buildEntityExtractionFields,
  type EntityFieldName,
  type EntityProposal,
  type EntityProposalSet,
} from "@/lib/extraction";
import { FC_CONFIG } from "@/lib/testConfig";
import type { PipelineStage, SourceType } from "@/lib/types";

/** The five required entities named in Requirement 2.1. */
const REQUIRED_ENTITIES: readonly EntityFieldName[] = [
  "patient",
  "payer",
  "procedureCode",
  "diagnosisCode",
  "denialReason",
] as const;

const FIXED = new Date("2026-02-01T09:30:00.000Z");
const clock = () => FIXED;

const SOURCE_TYPES: readonly SourceType[] = [
  "raw_intake",
  "chart_note",
  "payer_policy",
  "code_lookup",
  "human_provided",
];

const STAGE_VALUES: readonly PipelineStage[] = [
  "Intake_And_Extraction",
  "Medical_Review",
  "Policy_Review",
];

/**
 * Value generator spanning BOTH partitions the builder recognises: real
 * determinable values (padded so trimming matters) and undeterminable values
 * (null / undefined / blank / the "unknown" sentinel). Covering the
 * undeterminable partition proves required entities are still constructed even
 * when their value cannot be determined.
 */
const valueArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 40 }).map((s) => `  ${s}  `),
  fc.constant(null),
  fc.constant(undefined),
  fc.constantFrom("", "   ", "\t", "unknown", "UNKNOWN", "  Unknown  "),
);

const stepArb = fc.record({
  stage: fc.constantFrom(...STAGE_VALUES),
  tool: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
});

/** A single per-entity proposal entry (fieldName is supplied by the set key). */
const entryArb: fc.Arbitrary<Omit<EntityProposal, "fieldName">> = fc.record({
  value: valueArb,
  confidence: fc.option(fc.integer({ min: -50, max: 200 }), { nil: undefined }),
  sourceType: fc.constantFrom(...SOURCE_TYPES),
  reasoning: fc.string({ minLength: 1, maxLength: 60 }),
  originatingStep: stepArb,
});

/**
 * An EntityProposalSet covering ANY subset of the five entities — the empty set
 * (nothing proposed), every partial subset, and the full set — so omitted
 * entities exercise the "must still be constructed" guarantee.
 */
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

describe("Property 3: required entities are extracted (Req 2.1)", () => {
  // **Validates: Requirements 2.1**
  it("produces an Extracted_Field for each of the five required entities, keyed by field name, for any input", () => {
    fc.assert(
      fc.property(proposalSetArb, (set) => {
        const fields = buildEntityExtractionFields(set, clock);

        // Build the lookup KEYED BY FIELD NAME the audit trail relies on.
        const byName = new Map<EntityFieldName, (typeof fields)[number]>();
        for (const field of fields) {
          byName.set(field.fieldName, field);
        }

        // Every required entity resolves — none omitted.
        for (const entity of REQUIRED_ENTITIES) {
          const record = byName.get(entity);
          expect(record).toBeDefined();
          expect(record?.fieldName).toBe(entity);
        }

        // No duplicate keys collapsed the map: one record per required entity.
        expect(byName.size).toBe(REQUIRED_ENTITIES.length);
      }),
      FC_CONFIG,
    );
  });

  // **Validates: Requirements 2.1**
  it("never omits a required entity even when that entity is absent from the proposals", () => {
    fc.assert(
      fc.property(proposalSetArb, (set) => {
        const producedNames = new Set(
          buildEntityExtractionFields(set, clock).map((f) => f.fieldName),
        );
        for (const entity of REQUIRED_ENTITIES) {
          // Regardless of whether `set` proposed this entity, it is present.
          expect(producedNames.has(entity)).toBe(true);
        }
      }),
      FC_CONFIG,
    );
  });
});
