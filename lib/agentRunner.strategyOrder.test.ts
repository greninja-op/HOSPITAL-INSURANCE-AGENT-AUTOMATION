// =============================================================================
// lib/agentRunner.strategyOrder.test.ts
//
// Property 44: Strategy options ordered by descending win-probability.
//
// **Validates: Requirements 21.4**
//
// Requirement 21.4 mandates that when the Strategy stage computes candidate
// appeal approaches, THE AuthPilot stores each candidate + its win-probability
// as `Strategy_Options` on the Case, ORDERED BY DESCENDING win-probability.
// In `lib/agentRunner.ts` this is realized inside `strategyStage`:
//
//     const ranked = (options.length > 0 ? options : [FALLBACK_STRATEGY_OPTION])
//       .slice()
//       .sort((a, b) => b.winProbability - a.winProbability)
//       .slice(0, STRATEGY_MAX_OPTIONS);
//     ...
//     await prisma.case.update({ ..., data: { strategyOptions } });
//
// so the persisted `Case.strategyOptions.options` array is non-increasing by
// `winProbability` (and clamped to at most five entries, Req 21.2).
//
// Strategy of this test:
//   • The sort is an internal (non-exported) seam of `strategyStage`, and
//     `runAgent` exposes no `deps` seam, so we drive the REAL pipeline end to
//     end against an isolated, throwaway PostgreSQL schema (`createTestDb`) and
//     replace the ONLY network seam — `./qwen`.callQwen — with a fake (via
//     `vi.mock`) that routes by the stage's system prompt:
//       - Intake / Medical_Review / Policy_Review return terminal successes so
//         the pipeline reaches the Strategy stage.
//       - The Strategy call returns a generated set of candidate options (in an
//         ARBITRARY, deliberately-unsorted order) as the stage's JSON output.
//       - The Decision_Intelligence call (and anything after) degrades, so
//         `runAgent` escalates and halts right after Strategy — keeping each run
//         lean while `Case.strategyOptions` has already been persisted.
//   • After the run we read back `Case.strategyOptions` and assert the persisted
//     `options` are non-increasing by win-probability, and that they are exactly
//     the top-5 of the generated win-probabilities sorted descending.
//
// The test uses NO live model and NO real network. Persistence uses an isolated,
// throwaway PostgreSQL schema bound as the shared `globalThis.prisma` BEFORE
// importing the runner, so `runAgent` and its writes land in the disposable
// schema.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";

// ─── Per-run controller shared with the hoisted Qwen mock ─────────────────────
//
// `vi.mock` factories are hoisted above imports, so the mutable handle they close
// over must be created with `vi.hoisted`. Each property sample sets
// `hoisted.strategyContent` to the generated Strategy JSON payload before
// invoking `runAgent`.

const hoisted = vi.hoisted(() => ({
  strategyContent: "{}" as string,
}));

// FAKE Qwen: route by the stage's system prompt. Preserve every other `./qwen`
// export so unrelated importers are unaffected.
vi.mock("./qwen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./qwen")>();

  const success = (content: string) =>
    ({ ok: true as const, toolCalls: [], content });

  // A structured transient failure so Decision_Intelligence degrades and
  // `runAgent` escalates + halts right after Strategy (Req 6.9) — lean runs.
  const degrade = () =>
    ({
      ok: false as const,
      kind: "network" as const,
      transient: true,
      attempts: 3,
      detail: "fake degrade to short-circuit the pipeline after the Strategy stage",
    });

  return {
    ...actual,
    callQwen: async (
      messages: import("./qwen").ChatMessage[],
    ): Promise<import("./types").QwenOutcome> => {
      const sys =
        typeof messages[0]?.content === "string" ? messages[0].content : "";

      // Intake_And_Extraction — return an (all-unknown) extraction and continue.
      if (sys.includes("the Intake_And_Extraction stage")) {
        return success("{}");
      }
      if (sys.includes("the Medical_Review stage")) {
        return success("Medical review: chart assessed for clinical necessity.");
      }
      if (sys.includes("the Policy_Review stage")) {
        return success("Policy review: payer medical-necessity criteria assessed.");
      }
      // Strategy — return the generated (deliberately unsorted) candidate set.
      if (sys.includes("the Strategy stage")) {
        return success(hoisted.strategyContent);
      }
      // Decision_Intelligence and beyond — degrade to halt the pipeline.
      return degrade();
    },
  };
});

// ─── Test-DB wiring (bound before importing the runner) ───────────────────────

type GlobalWithPrisma = { prisma?: PrismaClient };
type RunnerModule = typeof import("./agentRunner");

let testDb: TestDb;
let prisma: PrismaClient;
let runner: RunnerModule;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  // Bind the isolated schema's client as the shared singleton BEFORE importing
  // the runner, so `runAgent` and its `createTraceStep` persistence hit it.
  process.env.DATABASE_URL = testDb.databaseUrl;
  (globalThis as unknown as GlobalWithPrisma).prisma = prisma;

  runner = await import("./agentRunner");
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

// The Strategy stage keeps at most five options (Req 21.2).
const STRATEGY_MAX_OPTIONS = 5;

/** Seed a fresh `New` Case the pipeline can run against. */
async function seedCase(): Promise<string> {
  const kase = await prisma.case.create({
    data: {
      intakeType: "denial_letter",
      rawIntakeText: "seed intake for strategy-order property test",
      status: "New",
      slaDeadline: new Date("2026-01-15T12:00:00.000Z"),
    },
  });
  return kase.id;
}

/** The persisted Strategy_Options shape we read back from the Case. */
interface StoredStrategyOptions {
  options: { approach: string; winProbability: number; rationale: string }[];
}

describe("Property 44: Strategy options ordered by descending win-probability (Req 21.4)", () => {
  it(
    "for any candidate set, the persisted Case.strategyOptions are non-increasing by win-probability",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // A non-empty set of candidate win-probabilities (integers 0..100), in
          // arbitrary order. 1..8 entries exercises the 5-option clamp too.
          fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 8 }),
          async (winProbabilities) => {
            // Build the model's Strategy JSON payload from the generated
            // win-probabilities, in the (unsorted) order they were generated.
            const candidates = winProbabilities.map((wp, i) => ({
              approach: `Approach ${i + 1}`,
              winProbability: wp,
              rationale: `Rationale ${i + 1}`,
            }));
            hoisted.strategyContent = JSON.stringify({
              options: candidates,
              payerTrackRecordSummary: "Generated payer track record for the test.",
            });

            const caseId = await seedCase();
            await runner.runAgent(caseId);

            // Read back what the Strategy stage persisted (Req 23.1).
            const kase = await prisma.case.findUnique({
              where: { id: caseId },
              select: { strategyOptions: true },
            });
            const stored = kase?.strategyOptions as unknown as StoredStrategyOptions | null;

            // The Strategy stage must have persisted structured options.
            expect(stored).not.toBeNull();
            expect(Array.isArray(stored?.options)).toBe(true);

            const storedProbs = (stored as StoredStrategyOptions).options.map(
              (o) => o.winProbability,
            );

            // Req 21.2 — at most five options are kept.
            expect(storedProbs.length).toBeGreaterThanOrEqual(1);
            expect(storedProbs.length).toBeLessThanOrEqual(STRATEGY_MAX_OPTIONS);

            // Property 44 / Req 21.4 — non-increasing by win-probability.
            for (let i = 0; i < storedProbs.length - 1; i += 1) {
              expect(storedProbs[i]).toBeGreaterThanOrEqual(storedProbs[i + 1]);
            }

            // Stronger check: the stored probabilities are exactly the top-5 of
            // the generated set, sorted descending — proving BOTH the ordering
            // and the selection are correct.
            const expected = [...winProbabilities]
              .sort((a, b) => b - a)
              .slice(0, STRATEGY_MAX_OPTIONS);
            expect(storedProbs).toEqual(expected);
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});
