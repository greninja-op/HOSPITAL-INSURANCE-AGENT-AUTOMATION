// =============================================================================
// lib/extraction.undetermined.test.ts
//
// Property 5: Undetermined entities are marked unknown (Requirement 2.3).
//
//   *For any* required entity that cannot be determined from any available
//   source, the corresponding Extracted_Field has value "unknown" and
//   Confidence_Score 0.
//
// The example-based and undeterminable-direction property tests for the pure
// builders already live in `lib/extraction.test.ts`. This file focuses on the
// BIDIRECTIONAL statement of Property 5 across a mixed set of entities: every
// undeterminable entity is marked unknown/0, AND — the converse — every
// determinable entity is NOT spuriously marked unknown (its real value is
// kept and its confidence is not forced to 0). Using `buildEntityExtractionFields`
// exercises both the "proposed but undeterminable" and "omitted entirely" paths
// for the same required-entity set.
// =============================================================================

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ENTITY_FIELD_NAMES,
  UNKNOWN_CONFIDENCE,
  UNKNOWN_VALUE,
  buildEntityExtractionFields,
  type EntityFieldName,
  type EntityProposal,
  type EntityProposalSet,
} from "@/lib/extraction";
import { FC_CONFIG } from "@/lib/testConfig";
import type { PipelineStage, SourceType } from "@/lib/types";

// Deterministic clock so construction is stable across runs.
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
 * Determinable value: after trimming, non-empty and NOT the literal "unknown"
 * sentinel (case-insensitive). Mirrors the production `isUndeterminable` rule's
 * negation. Padding is allowed so trimming is meaningful.
 */
const determinableValueArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0 && s.trim().toLowerCase() !== UNKNOWN_VALUE);

/**
 * Undeterminable value: null / blank / whitespace-only / the "unknown" sentinel
 * in assorted casings (Req 2.3). `undefined` values are handled by the "omit
 * the entity entirely" path in the set generator below.
 */
const undeterminableValueArb = fc.oneof(
  fc.constant<null>(null),
  fc.constant<string>(""),
  fc.constantFrom("   ", "\t", "\n  ", "  \t "),
  fc.constantFrom("unknown", "UNKNOWN", "  Unknown  ", "UnKnOwN", "unKNOWN"),
);

/** Confidence spanning in-range, out-of-range, and non-finite values. */
const confidenceArb = fc.oneof(
  fc.double(),
  fc.integer({ min: -200, max: 300 }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);

const stepArb = fc.record({
  stage: fc.constantFrom(...STAGE_VALUES),
  tool: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
});

type EntityEntry = Omit<EntityProposal, "fieldName">;

/**
 * Per-entity plan describing what we hand to the builder and whether we EXPECT
 * that entity to be undeterminable, so the assertions can check both directions.
 *
 *  - "omit"          — entity absent from the set          ⇒ undeterminable
 *  - "undeterminable"— present with a null/blank/"unknown"  ⇒ undeterminable
 *  - "determinable"  — present with a real value            ⇒ NOT unknown
 */
type EntityPlan =
  | { kind: "omit" }
  | { kind: "undeterminable"; entry: EntityEntry }
  | { kind: "determinable"; entry: EntityEntry; value: string };

const entryFieldsArb = fc.record({
  confidence: fc.option(confidenceArb, { nil: undefined }),
  sourceType: fc.constantFrom(...SOURCE_TYPES),
  reasoning: fc.string({ minLength: 1, maxLength: 60 }),
  originatingStep: stepArb,
});

const entityPlanArb: fc.Arbitrary<EntityPlan> = fc.oneof(
  fc.constant<EntityPlan>({ kind: "omit" }),
  fc
    .tuple(undeterminableValueArb, entryFieldsArb)
    .map(([value, rest]) => ({ kind: "undeterminable", entry: { value, ...rest } }) as EntityPlan),
  fc
    .tuple(determinableValueArb, entryFieldsArb)
    .map(([value, rest]) => ({
      kind: "determinable",
      entry: { value, ...rest },
      value,
    }) as EntityPlan),
);

/** A plan for every required entity, so each pass covers the full five. */
const entityPlansArb: fc.Arbitrary<Record<EntityFieldName, EntityPlan>> = fc
  .tuple(...ENTITY_FIELD_NAMES.map(() => entityPlanArb))
  .map(
    (plans) =>
      Object.fromEntries(ENTITY_FIELD_NAMES.map((name, i) => [name, plans[i]])) as Record<
        EntityFieldName,
        EntityPlan
      >,
  );

function toProposalSet(plans: Record<EntityFieldName, EntityPlan>): EntityProposalSet {
  const set: EntityProposalSet = {};
  for (const name of ENTITY_FIELD_NAMES) {
    const plan = plans[name];
    if (plan.kind !== "omit") set[name] = plan.entry;
  }
  return set;
}

describe("Property 5 (bidirectional): undetermined entities are marked unknown (Req 2.3)", () => {
  // **Validates: Requirements 2.3**
  it("marks every undeterminable entity unknown/0 and never spuriously marks a determinable one", () => {
    fc.assert(
      fc.property(entityPlansArb, (plans) => {
        const fields = buildEntityExtractionFields(toProposalSet(plans), clock);
        const byName = Object.fromEntries(fields.map((f) => [f.fieldName, f])) as Record<
          EntityFieldName,
          (typeof fields)[number]
        >;

        for (const name of ENTITY_FIELD_NAMES) {
          const plan = plans[name];
          const field = byName[name];

          if (plan.kind === "determinable") {
            // Converse: a determinable entity keeps its real value (never the
            // sentinel) and is NOT forced to confidence 0 by the marking rule.
            expect(field.value).toBe(plan.value.trim());
            expect(field.value).not.toBe(UNKNOWN_VALUE);
          } else {
            // Undeterminable (omitted or blank/null/"unknown") ⇒ unknown / 0.
            expect(field.value).toBe(UNKNOWN_VALUE);
            expect(field.confidence).toBe(UNKNOWN_CONFIDENCE);
          }
        }
      }),
      FC_CONFIG,
    );
  });

  it("holds when EVERY entity is undeterminable (all five marked unknown/0)", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(...ENTITY_FIELD_NAMES),
          fc
            .tuple(undeterminableValueArb, entryFieldsArb)
            .map(([value, rest]) => ({ value, ...rest }) as EntityEntry),
        ),
        (partialSet) => {
          const fields = buildEntityExtractionFields(partialSet as EntityProposalSet, clock);
          expect(fields).toHaveLength(ENTITY_FIELD_NAMES.length);
          for (const field of fields) {
            expect(field.value).toBe(UNKNOWN_VALUE);
            expect(field.confidence).toBe(UNKNOWN_CONFIDENCE);
          }
        },
      ),
      FC_CONFIG,
    );
  });
});
