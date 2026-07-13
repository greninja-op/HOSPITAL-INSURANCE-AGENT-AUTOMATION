// =============================================================================
// lib/eval.test.ts
//
// Property 65: Gold-case evaluation passes iff path AND triggering findings match
// (Task 24.2 — validates the gold-case evaluation runner built in Task 24.1).
//
// The runner under test lives in `scripts/eval.ts`. Its pure seams are:
//   • `evaluateGoldCase(goldCase)` — deterministically evaluates ONE Gold_Case
//     against the deterministic fake pipeline + the real decision logic, and
//     reports { pass, producedResolutionPath, producedTriggeringFindingIds, ... }.
//   • `runGoldCases(cases)`        — evaluates every case (order-preserving).
//   • `loadGoldCases()`            — loads the real `eval/gold/*.json` fixtures.
//
// These paths are fully deterministic — no live Qwen model, no DB — so they are
// safe to drive with fast-check across many generated inputs.
//
// This test is placed under `lib/` (not `scripts/`) because the Vitest config
// only includes `lib/**` and `app/**`; it imports the runner from `@/scripts/eval`.
// =============================================================================

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { FC_CONFIG } from "@/lib/testConfig";
import type { ResolutionPath } from "@/lib/types";
import {
  evaluateGoldCase,
  loadGoldCases,
  runGoldCases,
  type GoldCase,
  type GoldCaseIntake,
} from "@/scripts/eval";

// The three Resolution_Paths the runner can produce (mirrors scripts/eval.ts).
const RESOLUTION_PATHS: readonly ResolutionPath[] = [
  "Auto_Draft",
  "Draft_And_Request_Evidence",
  "Escalate_To_Human",
];

/**
 * Order-insensitive (multiset) equality for two id lists — an independent
 * re-implementation of the runner's private `sameIdSet`, so the assertions
 * check the iff against a definition NOT taken from the code under test.
 */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

// ─── Generators ───────────────────────────────────────────────────────────────

// Natural-language cues the deterministic fake pipeline (analyzeIntake) keys on.
// Toggling these on/off produces every combination of Findings + confidence band.
const CONTRADICTION_CUE = "the documented diagnosis mismatch is present";
const POLICY_EXCLUSION_CUE = "the service is excluded under the plan per policy exclusion 4.2";
const EVIDENCE_GAP_CUE = "please provide the missing physical therapy records";
const LOW_CONFIDENCE_CUE = "the scanned fax is largely illegible and the reason is unclear";

/** Build a fixed intake whose text deterministically drives the fake pipeline. */
function buildIntake(cues: {
  contradiction: boolean;
  policy: boolean;
  gap: boolean;
  lowConfidence: boolean;
  filler: string;
}): GoldCaseIntake {
  const parts = ["Denial letter for procedure 29881."];
  if (cues.contradiction) parts.push(CONTRADICTION_CUE);
  if (cues.policy) parts.push(POLICY_EXCLUSION_CUE);
  if (cues.gap) parts.push(EVIDENCE_GAP_CUE);
  if (cues.lowConfidence) parts.push(LOW_CONFIDENCE_CUE);
  // Arbitrary benign filler must never change the classification.
  parts.push(cues.filler);
  return { text: parts.join(" "), intakeType: "denial_letter", urgent: false };
}

// A generated (caseId + intake) that exercises the full outcome space.
const caseSeedArb = fc.record({
  caseId: fc.uuid(),
  contradiction: fc.boolean(),
  policy: fc.boolean(),
  gap: fc.boolean(),
  lowConfidence: fc.boolean(),
  // Filler restricted to benign words so it can't match any pipeline cue.
  filler: fc.stringMatching(/^[a-z ]{0,40}$/),
});

// How to derive the *expected* triggering ids from the produced ids, so both
// the matching (pass) and non-matching (fail) branches of the iff are covered.
const idMutationArb = fc.oneof(
  fc.constant<{ kind: "same" }>({ kind: "same" }),
  fc.constant<{ kind: "empty" }>({ kind: "empty" }),
  fc.constant<{ kind: "dropOne" }>({ kind: "dropOne" }),
  fc.record({ kind: fc.constant<"addExtra">("addExtra"), extra: fc.string({ minLength: 1 }) }),
);

/** Apply a mutation to the produced ids to build the expected ids. */
function applyIdMutation(
  produced: readonly string[],
  mutation: { kind: string; extra?: string },
): string[] {
  switch (mutation.kind) {
    case "empty":
      return [];
    case "dropOne":
      return produced.slice(1);
    case "addExtra":
      return [...produced, `${mutation.extra}::synthetic`];
    case "same":
    default:
      // A reversed copy: an equal multiset in a different order (exercises the
      // order-insensitivity of the comparison while keeping pass === true).
      return [...produced].reverse();
  }
}

// ─── Property 65 ────────────────────────────────────────────────────────────

describe("Property 65: Gold-case evaluation passes iff path and triggering findings match", () => {
  // **Validates: Requirements 30.2, 30.3, 30.4**
  //
  // For any Gold_Case, evaluateGoldCase reports pass === true if and only if the
  // produced Resolution_Path equals the expected Resolution_Path AND the produced
  // triggering Finding id(s) equal the expected triggering Finding id(s) (as a
  // multiset). Any difference in either dimension is reported as a fail.
  it("reports pass iff BOTH the path and the triggering finding ids match the expected values", () => {
    fc.assert(
      fc.property(
        caseSeedArb,
        fc.constantFrom(...RESOLUTION_PATHS),
        idMutationArb,
        (seed, expectedPath, mutation) => {
          const intake = buildIntake(seed);

          // First evaluate with placeholder expectations purely to learn what the
          // runner *produces* for this intake (produced fields are independent of
          // the expected fields, so this probe is safe and deterministic).
          const probe = evaluateGoldCase({
            id: seed.caseId,
            intake,
            expectedResolutionPath: "Auto_Draft",
            expectedTriggeringFindingIds: [],
          });

          const expectedIds = applyIdMutation(probe.producedTriggeringFindingIds, mutation);

          const goldCase: GoldCase = {
            id: seed.caseId,
            intake,
            expectedResolutionPath: expectedPath,
            expectedTriggeringFindingIds: expectedIds,
          };

          const result = evaluateGoldCase(goldCase);

          // Produced facts must be stable regardless of the expectations supplied.
          expect(result.producedResolutionPath).toBe(probe.producedResolutionPath);
          expect(result.producedTriggeringFindingIds).toEqual(
            probe.producedTriggeringFindingIds,
          );

          // The iff, checked against an independent definition of "match".
          const pathMatches = result.producedResolutionPath === expectedPath;
          const idsMatch = sameIdSet(result.producedTriggeringFindingIds, expectedIds);
          expect(result.pass).toBe(pathMatches && idsMatch);
        },
      ),
      FC_CONFIG,
    );
  });

  // A mismatch in EITHER dimension alone is always a fail (targeted coverage of
  // the "any difference is reported as a fail" clause, Req 30.4).
  it("fails when only the path differs, and fails when only the finding ids differ", () => {
    fc.assert(
      fc.property(caseSeedArb, (seed) => {
        const intake = buildIntake(seed);
        const truth = evaluateGoldCase({
          id: seed.caseId,
          intake,
          expectedResolutionPath: "Auto_Draft",
          expectedTriggeringFindingIds: [],
        });

        // Correct ids, wrong path → fail.
        const wrongPath = RESOLUTION_PATHS.find((p) => p !== truth.producedResolutionPath)!;
        const pathOnlyWrong = evaluateGoldCase({
          id: seed.caseId,
          intake,
          expectedResolutionPath: wrongPath,
          expectedTriggeringFindingIds: [...truth.producedTriggeringFindingIds],
        });
        expect(pathOnlyWrong.pass).toBe(false);

        // Correct path, wrong ids → fail.
        const idsOnlyWrong = evaluateGoldCase({
          id: seed.caseId,
          intake,
          expectedResolutionPath: truth.producedResolutionPath,
          expectedTriggeringFindingIds: [
            ...truth.producedTriggeringFindingIds,
            "definitely-not-a-real-finding-id",
          ],
        });
        expect(idsOnlyWrong.pass).toBe(false);

        // Correct path AND correct ids → pass (sanity anchor for the iff).
        const bothRight = evaluateGoldCase({
          id: seed.caseId,
          intake,
          expectedResolutionPath: truth.producedResolutionPath,
          expectedTriggeringFindingIds: [...truth.producedTriggeringFindingIds],
        });
        expect(bothRight.pass).toBe(true);
      }),
      FC_CONFIG,
    );
  });

  // Determinism: the same Gold_Case evaluated repeatedly yields an identical
  // result (Req 30.2 — the evaluation is stable across repeated runs).
  it("is deterministic — repeated evaluation of the same case yields identical results", () => {
    fc.assert(
      fc.property(
        caseSeedArb,
        fc.constantFrom(...RESOLUTION_PATHS),
        idMutationArb,
        (seed, expectedPath, mutation) => {
          const intake = buildIntake(seed);
          const probe = evaluateGoldCase({
            id: seed.caseId,
            intake,
            expectedResolutionPath: "Auto_Draft",
            expectedTriggeringFindingIds: [],
          });
          const goldCase: GoldCase = {
            id: seed.caseId,
            intake,
            expectedResolutionPath: expectedPath,
            expectedTriggeringFindingIds: applyIdMutation(
              probe.producedTriggeringFindingIds,
              mutation,
            ),
          };
          expect(evaluateGoldCase(goldCase)).toEqual(evaluateGoldCase(goldCase));
        },
      ),
      FC_CONFIG,
    );
  });
});

// ─── Aggregate stability over the real gold fixtures ──────────────────────────

describe("Gold-case runner: aggregate result is order-invariant and stable (Req 30.2)", () => {
  const goldCases = loadGoldCases();

  it("loads at least the five committed gold fixtures", () => {
    expect(goldCases.length).toBeGreaterThanOrEqual(5);
  });

  it("every committed Gold_Case meets its expected outcome (all pass)", async () => {
    const results = await runGoldCases(goldCases);
    for (const r of results) {
      expect(
        r.pass,
        `Gold_Case ${r.id}: expected ${r.expectedResolutionPath} [${r.expectedTriggeringFindingIds.join(", ")}], ` +
          `got ${r.producedResolutionPath} [${r.producedTriggeringFindingIds.join(", ")}]`,
      ).toBe(true);
    }
  });

  // **Validates: Requirements 30.2, 30.3, 30.4**
  //
  // Driving runGoldCases with generated permutations of the fixtures: the
  // per-case pass/fail (keyed by id) is invariant to input ordering, and the
  // overall "all passed" verdict is stable across repeated runs.
  it("produces per-case results invariant to input ordering and stable across runs", async () => {
    // Reference result keyed by id from the canonical order.
    const reference = new Map(
      (await runGoldCases(goldCases)).map((r) => [r.id, r] as const),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(goldCases, {
          minLength: goldCases.length,
          maxLength: goldCases.length,
        }),
        async (permuted) => {
          const results = await runGoldCases(permuted);

          // Same set of cases, same per-case outcome regardless of order.
          expect(results.length).toBe(goldCases.length);
          for (const r of results) {
            const ref = reference.get(r.id)!;
            expect(r).toEqual(ref);
          }

          // Aggregate verdict is invariant to ordering.
          const allPass = results.every((r) => r.pass);
          const refAllPass = [...reference.values()].every((r) => r.pass);
          expect(allPass).toBe(refAllPass);
        },
      ),
      FC_CONFIG,
    );
  });
});
