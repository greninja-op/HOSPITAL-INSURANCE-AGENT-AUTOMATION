// =============================================================================
// lib/agentRunner.winProbability.test.ts
//
// Property 43: Win-probability count and range.
//
// **Validates: Requirements 21.2**
//
// Requirement 21.2 mandates that when the Strategy stage runs for a Case it
// SHALL identify AT LEAST ONE and AT MOST FIVE candidate appeal approaches and
// compute for each a win-probability estimate expressed as an INTEGER from 0 to
// 100 (percent). In `lib/agentRunner.ts` this is realized inside `strategyStage`:
//
//     const ranked = (options.length > 0 ? options : [FALLBACK_STRATEGY_OPTION])
//       .slice()
//       .sort((a, b) => b.winProbability - a.winProbability)
//       .slice(0, STRATEGY_MAX_OPTIONS);            // <= 5 (Req 21.2)
//     ...
//     await prisma.case.update({ ..., data: { strategyOptions } });
//
// where each candidate's win-probability first passes through
// `normalizeWinProbability` (rounds to an integer and clamps into [0, 100]), and
// an empty candidate set substitutes a single `FALLBACK_STRATEGY_OPTION` so the
// min-1 floor holds. Thus the persisted `Case.strategyOptions.options` array has
// between 1 and 5 entries and every win-probability is an integer in [0, 100],
// regardless of what the model emitted (out-of-range, fractional, or too many).
//
// Strategy of this test (mirrors lib/agentRunner.strategyOrder.test.ts):
//   • The normalization + clamp are internal (non-exported) seams of
//     `strategyStage`, and `runAgent` exposes no `deps` seam, so we drive the
//     REAL pipeline end to end against an isolated, throwaway PostgreSQL schema
//     (`createTestDb`) and replace the ONLY network seam — `./qwen`.callQwen —
//     with a fake (via `vi.mock`) that routes by the stage's system prompt:
//       - Intake / Medical_Review / Policy_Review return terminal successes so
//         the pipeline reaches the Strategy stage.
//       - The Strategy call returns a generated set of candidate options —
//         DELIBERATELY including out-of-range, fractional, and too-many entries
//         (to prove the count clamp and range coercion) — as the stage's JSON.
//       - The Decision_Intelligence call (and anything after) degrades, so
//         `runAgent` escalates and halts right after Strategy — keeping each run
//         lean while `Case.strategyOptions` has already been persisted. The run
//         never reaches Appeal_Generation, so `generateAppealPdf` is not hit.
//   • After the run we read back `Case.strategyOptions` and assert the persisted
//     `options` number between 1 and 5, and every win-probability is an integer
//     in [0, 100].
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
      // Strategy — return the generated candidate set (possibly out-of-range).
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

// The Strategy stage keeps between 1 and 5 options (Req 21.2).
const STRATEGY_MIN_OPTIONS = 1;
const STRATEGY_MAX_OPTIONS = 5;

/** Seed a fresh `New` Case the pipeline can run against. */
async function seedCase(): Promise<string> {
  const kase = await prisma.case.create({
    data: {
      intakeType: "denial_letter",
      rawIntakeText: "seed intake for win-probability count/range property test",
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

// A single RAW win-probability the model might emit, spanning the space that
// exercises the integer-coercion + [0,100] clamp: in-range integers, negatives,
// values above 100, non-integer floats, and 0..1 fractions (accepted as
// percents). Whatever comes out MUST be persisted as an integer in [0, 100].
const rawWinProbability = fc.oneof(
  fc.integer({ min: -250, max: 350 }),
  fc.double({ min: -50, max: 200, noNaN: true, noDefaultInfinity: true }),
  fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
);

describe("Property 43: Win-probability count and range (Req 21.2)", () => {
  it(
    "for any candidate set, the persisted Case.strategyOptions have 1..5 entries and every win-probability is an integer in [0, 100]",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // 0..8 raw candidate win-probabilities: length 0 exercises the min-1
          // fallback, length > 5 exercises the 5-option clamp, and the raw
          // values exercise integer-coercion + [0,100] range clamping.
          fc.array(rawWinProbability, { minLength: 0, maxLength: 8 }),
          async (rawProbs) => {
            // Build the model's Strategy JSON payload from the generated raw
            // win-probabilities (each with a non-empty approach so options are
            // not dropped as unusable).
            const candidates = rawProbs.map((wp, i) => ({
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

            // Req 21.2 — between 1 and 5 candidate approaches.
            expect(storedProbs.length).toBeGreaterThanOrEqual(STRATEGY_MIN_OPTIONS);
            expect(storedProbs.length).toBeLessThanOrEqual(STRATEGY_MAX_OPTIONS);

            // Req 21.2 — every win-probability is an INTEGER within [0, 100].
            for (const wp of storedProbs) {
              expect(typeof wp).toBe("number");
              expect(Number.isInteger(wp)).toBe(true);
              expect(wp).toBeGreaterThanOrEqual(0);
              expect(wp).toBeLessThanOrEqual(100);
            }
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});
