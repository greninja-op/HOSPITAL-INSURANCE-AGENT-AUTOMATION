/**
 * Property test — Contradictions are recorded with both sources.
 *
 * // Feature: authpilot, Property 11: Contradictions are recorded with both sources
 * Validates: Requirements 4.1
 *
 * Requirement 4.1: WHEN the Agent_Runner detects that an extracted value
 * conflicts with an investigated source, THE Agent_Runner SHALL record a
 * Trace_Step describing the contradiction and the TWO conflicting sources.
 *
 * `detectContradictions(extractedValues, investigatedFacts)` (lib/detection.ts)
 * is the pure detector the pipeline turns into that Trace_Step. This property
 * asserts that for ANY input containing conflicting data, every recorded
 * `ContradictionResult` references BOTH conflicting sources — the extracted
 * source and the investigated source — with neither dropped, and that each side
 * traces back to an actual input source (never fabricated). It also confirms the
 * two recorded values genuinely conflict (both determined, normalized-distinct).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { SourceType } from "./types";
import {
  detectContradictions,
  type ExtractedValue,
  type InvestigatedFact,
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

/** A source reference with a non-empty label and a valid source type. */
const arbSourceRef: fc.Arbitrary<SourceRef> = fc.record({
  sourceType: fc.constantFrom<SourceType>(...SOURCE_TYPES),
  label: fc.string({ minLength: 1, maxLength: 24 }),
});

/** A "determined" value: non-empty, not the "unknown" sentinel after trimming. */
const arbDeterminedValue: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 16 })
  .filter((v) => {
    const n = v.trim().toLowerCase();
    return n.length > 0 && n !== "unknown";
  });

/**
 * A guaranteed conflict: one field name, two determined values whose normalized
 * (trimmed, lower-cased) forms differ, and a distinct source for each side.
 */
const arbConflict = fc
  .record({
    fieldName: fc.string({ minLength: 1, maxLength: 12 }),
    extractedValue: arbDeterminedValue,
    sourceValue: arbDeterminedValue,
    extractedSource: arbSourceRef,
    investigatedSource: arbSourceRef,
  })
  .filter(
    (c) =>
      c.extractedValue.trim().toLowerCase() !==
      c.sourceValue.trim().toLowerCase(),
  );

describe("Contradictions are recorded with both sources (Property 11)", () => {
  it("every recorded contradiction references BOTH conflicting sources", () => {
    fc.assert(
      fc.property(
        fc.array(arbConflict, { minLength: 1, maxLength: 8 }),
        (conflicts) => {
          // Build inputs from guaranteed-conflicting pairs. Distinct field names
          // per pair keep each conflict independent so we can count precisely.
          const extractedValues: ExtractedValue[] = conflicts.map((c, i) => ({
            fieldName: `${c.fieldName}#${i}`,
            value: c.extractedValue,
            source: c.extractedSource,
          }));
          const investigatedFacts: InvestigatedFact[] = conflicts.map(
            (c, i) => ({
              fieldName: `${c.fieldName}#${i}`,
              value: c.sourceValue,
              source: c.investigatedSource,
            }),
          );

          const results = detectContradictions(
            extractedValues,
            investigatedFacts,
          );

          // Each guaranteed conflict is detected exactly once.
          expect(results).toHaveLength(conflicts.length);

          const inputSources = [
            ...extractedValues.map((e) => e.source),
            ...investigatedFacts.map((f) => f.source),
          ];
          const sourceKey = (s: SourceRef) => `${s.sourceType}::${s.label}`;
          const inputSourceKeys = new Set(inputSources.map(sourceKey));

          for (const r of results) {
            // BOTH sources are present — neither is dropped (Req 4.1).
            expect(r.extractedSource).toBeDefined();
            expect(r.investigatedSource).toBeDefined();
            expect(r.extractedSource.label.length).toBeGreaterThan(0);
            expect(r.investigatedSource.label.length).toBeGreaterThan(0);

            // Each recorded source traces back to an actual input source.
            expect(inputSourceKeys.has(sourceKey(r.extractedSource))).toBe(true);
            expect(inputSourceKeys.has(sourceKey(r.investigatedSource))).toBe(
              true,
            );

            // The two recorded values genuinely conflict and are both determined.
            expect(r.extractedValue.trim().toLowerCase()).not.toBe(
              r.sourceValue.trim().toLowerCase(),
            );
            expect(r.extractedValue.trim().toLowerCase()).not.toBe("unknown");
            expect(r.sourceValue.trim().toLowerCase()).not.toBe("unknown");

            // Both source labels appear in the technical message describing the
            // contradiction, so the recorded Trace_Step names each side.
            expect(r.technicalMessage).toContain(r.extractedSource.label);
            expect(r.technicalMessage).toContain(r.investigatedSource.label);
          }
        },
      ),
      FC_CONFIG,
    );
  });
});
