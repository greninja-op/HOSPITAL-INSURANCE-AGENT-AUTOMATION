// =============================================================================
// lib/audit.test.ts
//
// Property-based tests for the pure Audit_Trail merge in `lib/audit.ts`.
//
// Feature: authpilot, Property 27: Audit trail is chronological and lossless —
// For any set of Extracted_Field and Trace_Step records for a Case, the merged
// audit view (`mergeAuditTrail`) is ordered non-decreasing by timestamp and
// contains every record exactly once (no record dropped or duplicated).
// **Validates: Requirements 9.3**
//
// `mergeAuditTrail` is pure (no I/O, no DB) and carries each source record
// through unchanged by reference, so the cleanest seam is to exercise it
// directly with generated field/step records rather than round-tripping through
// Prisma. Reference identity lets us verify losslessness exactly (every input
// object appears in the output exactly once, with no extras).
// =============================================================================

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  mergeAuditTrail,
  type ExtractedFieldRecord,
  type TraceStepRecord,
} from "@/lib/audit";
import { FC_CONFIG } from "@/lib/testConfig";

// A deliberately narrow timestamp range (spanning only a few whole seconds)
// so generated records frequently share identical timestamps. This exercises
// the tie-handling path of the merge, where chronological ordering must hold
// with equal keys and losslessness must not drop or duplicate colliding records.
const timestampArb: fc.Arbitrary<Date> = fc
  .integer({ min: 1_700_000_000_000, max: 1_700_000_005_000 })
  .map((ms) => new Date(ms));

const extractedFieldArb: fc.Arbitrary<ExtractedFieldRecord> = fc.record({
  fieldName: fc.string(),
  value: fc.string(),
  confidence: fc.integer({ min: 0, max: 100 }),
  sourceType: fc.constantFrom("document", "human", "system"),
  reasoning: fc.string(),
  timestamp: timestampArb,
});

const traceStepArb: fc.Arbitrary<TraceStepRecord> = fc.record({
  stepType: fc.string(),
  toolName: fc.option(fc.string(), { nil: null }),
  input: fc.option(fc.jsonValue(), { nil: undefined }),
  output: fc.option(fc.jsonValue(), { nil: undefined }),
  reasoning: fc.string(),
  timestamp: timestampArb,
});

describe("mergeAuditTrail (Property 27: audit trail is chronological and lossless)", () => {
  it("produces a trail sorted non-decreasing by timestamp", () => {
    fc.assert(
      fc.property(
        fc.array(extractedFieldArb, { maxLength: 40 }),
        fc.array(traceStepArb, { maxLength: 40 }),
        (fields, steps) => {
          const merged = mergeAuditTrail(fields, steps);

          for (let i = 1; i < merged.length; i++) {
            expect(merged[i].timestamp.getTime()).toBeGreaterThanOrEqual(
              merged[i - 1].timestamp.getTime(),
            );
          }
        },
      ),
      FC_CONFIG,
    );
  });

  it("is lossless: every source record appears exactly once, with no extras", () => {
    fc.assert(
      fc.property(
        fc.array(extractedFieldArb, { maxLength: 40 }),
        fc.array(traceStepArb, { maxLength: 40 }),
        (fields, steps) => {
          const merged = mergeAuditTrail(fields, steps);

          // Counts line up: no records added or dropped in aggregate.
          expect(merged.length).toBe(fields.length + steps.length);

          const mergedFieldRefs = merged
            .filter((e) => e.kind === "extracted_field")
            .map((e) => (e as { field: ExtractedFieldRecord }).field);
          const mergedStepRefs = merged
            .filter((e) => e.kind === "trace_step")
            .map((e) => (e as { step: TraceStepRecord }).step);

          expect(mergedFieldRefs).toHaveLength(fields.length);
          expect(mergedStepRefs).toHaveLength(steps.length);

          // Each source object appears exactly once (reference identity), so
          // nothing is duplicated and nothing is dropped or mutated.
          for (const field of fields) {
            expect(mergedFieldRefs.filter((r) => r === field)).toHaveLength(1);
          }
          for (const step of steps) {
            expect(mergedStepRefs.filter((r) => r === step)).toHaveLength(1);
          }

          // The top-level ordering key matches the carried record's timestamp.
          for (const entry of merged) {
            const source =
              entry.kind === "extracted_field" ? entry.field : entry.step;
            expect(entry.timestamp).toBe(source.timestamp);
          }
        },
      ),
      FC_CONFIG,
    );
  });

  it("preserves relative order of equal-timestamp records (fields before steps)", () => {
    // A single shared timestamp forces every record onto the tie path; the
    // stable merge must keep all fields (in order) ahead of all steps (in order).
    const shared = new Date(1_700_000_000_000);
    const withShared = (
      fields: ExtractedFieldRecord[],
      steps: TraceStepRecord[],
    ): [ExtractedFieldRecord[], TraceStepRecord[]] => [
      fields.map((f) => ({ ...f, timestamp: shared })),
      steps.map((s) => ({ ...s, timestamp: shared })),
    ];

    fc.assert(
      fc.property(
        fc.array(extractedFieldArb, { maxLength: 20 }),
        fc.array(traceStepArb, { maxLength: 20 }),
        (rawFields, rawSteps) => {
          const [fields, steps] = withShared(rawFields, rawSteps);
          const merged = mergeAuditTrail(fields, steps);

          const kinds = merged.map((e) => e.kind);
          const firstStep = kinds.indexOf("trace_step");
          const lastField = kinds.lastIndexOf("extracted_field");
          if (firstStep !== -1 && lastField !== -1) {
            expect(lastField).toBeLessThan(firstStep);
          }
        },
      ),
      FC_CONFIG,
    );
  });
});
