// =============================================================================
// lib/agentRunner.reviewOverlap.test.ts
//
// Property 37: Medical and Policy reviews overlap.
//
// **Validates: Requirements 20.2**
//
// Requirement 20.2 mandates that when the Agent_Runner reaches the review phase,
// the Medical_Review and Policy_Review stages run with OVERLAPPING execution
// windows — each of the two stages begins before the other stage completes
// (medicalStart < policyEnd AND policyStart < medicalEnd). In `lib/agentRunner.ts`
// this is realized by awaiting the two stages together:
//
//     const [medical, policy] = await Promise.all([
//       settleStage(() => medicalReviewStage(ctx)),
//       settleStage(() => policyReviewStage(ctx)),
//     ]);
//
// so each stage BEGINS before the other COMPLETES (true concurrency, not a
// sequential `await medical; await policy`).
//
// Strategy of this test:
//   • The only controllable timing seam inside `runAgent` is the Qwen_Client:
//     `runStage` calls the module-level `callQwen` imported from `./qwen`. We
//     replace `callQwen` with a fake (via `vi.mock`) that routes by the stage's
//     system prompt and drives a per-run timing BARRIER.
//   • The fake records, for the Medical_Review and Policy_Review model calls,
//     the timestamp when each begins and ends. Each stage, upon entry, announces
//     its start (resolving a shared "started" deferred) and then — before it is
//     allowed to resolve — waits for the OTHER stage to announce its start
//     (bounded by a generous safety timeout).
//       - Under the real concurrent `Promise.all`, both starts fire, so both
//         windows straddle the barrier and provably overlap.
//       - If the code regressed to sequential `await medical; await policy`, the
//         first stage would never see the second's start, its bounded wait would
//         elapse, it would COMPLETE before the second even BEGINS, and the
//         interval-overlap assertion would fail (no infinite hang).
//   • After the two reviews complete, the fake degrades the Strategy stage's
//     Qwen call so `runAgent` escalates and halts — keeping each run lean by not
//     exercising the downstream Decision/Appeal/Verification stages.
//
// Persistence uses an isolated, throwaway PostgreSQL schema (`createTestDb`),
// bound as the shared `globalThis.prisma` BEFORE importing the runner so both
// `runAgent` and its `createTraceStep` writes land in the disposable schema.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";

// ─── Per-run timing coordinator, shared with the hoisted mock ─────────────────

interface RunState {
  medicalStarted: Deferred;
  policyStarted: Deferred;
  medicalStart: number | null;
  medicalEnd: number | null;
  policyStart: number | null;
  policyEnd: number | null;
  preMedical: number;
  postMedical: number;
  prePolicy: number;
  postPolicy: number;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

// The mock factory is hoisted above imports; give it a stable handle it can read
// the CURRENT run's coordinator from. The test body swaps `current` each run.
const hoisted = vi.hoisted(() => ({
  current: null as RunState | null,
}));

// A generous safety net so a hypothetical SEQUENTIAL regression cannot hang the
// suite forever — it will instead complete non-overlapping and fail the assert.
const BARRIER_TIMEOUT_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve when `p` settles OR after `ms` — whichever comes first. */
function raceTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    void p.then(finish);
  });
}

// ─── Mock the Qwen_Client: route by stage prompt and drive the barrier ────────

vi.mock("@/lib/qwen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/qwen")>();

  const success = (content: string) =>
    ({ ok: true as const, toolCalls: [], content });

  // A structured transient failure so the Strategy stage degrades and `runAgent`
  // halts right after the reviews (Req 6.9) — keeping each run lean.
  const degrade = () =>
    ({
      ok: false as const,
      kind: "network" as const,
      transient: true,
      attempts: 3,
      detail: "fake degrade to short-circuit the pipeline after the review phase",
    });

  return {
    ...actual,
    callQwen: async (
      messages: import("@/lib/qwen").ChatMessage[],
    ): Promise<import("@/lib/types").QwenOutcome> => {
      const sys =
        typeof messages[0]?.content === "string" ? messages[0].content : "";
      const st = hoisted.current;

      // Intake_And_Extraction — return an (all-unknown) extraction and continue.
      if (sys.includes("the Intake_And_Extraction stage")) {
        return success("{}");
      }

      if (st && sys.includes("the Medical_Review stage")) {
        st.medicalStart = performance.now();
        st.medicalStarted.resolve();
        if (st.preMedical > 0) await delay(st.preMedical);
        // May not COMPLETE until Policy_Review has BEGUN (Req 20.2).
        await raceTimeout(st.policyStarted.promise, BARRIER_TIMEOUT_MS);
        if (st.postMedical > 0) await delay(st.postMedical);
        st.medicalEnd = performance.now();
        return success("Medical review: chart assessed for clinical necessity.");
      }

      if (st && sys.includes("the Policy_Review stage")) {
        st.policyStart = performance.now();
        st.policyStarted.resolve();
        if (st.prePolicy > 0) await delay(st.prePolicy);
        // May not COMPLETE until Medical_Review has BEGUN (Req 20.2).
        await raceTimeout(st.medicalStarted.promise, BARRIER_TIMEOUT_MS);
        if (st.postPolicy > 0) await delay(st.postPolicy);
        st.policyEnd = performance.now();
        return success("Policy review: payer medical-necessity criteria assessed.");
      }

      // Strategy (or anything else) — degrade to halt the pipeline post-review.
      return degrade();
    },
  };
});

// ─── Test-DB wiring (bound before importing the runner) ───────────────────────

type GlobalWithPrisma = { prisma?: PrismaClient };
type RunnerModule = typeof import("@/lib/agentRunner");

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

  runner = await import("@/lib/agentRunner");
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Seed a fresh `New` Case the pipeline can run against. */
async function seedCase(): Promise<string> {
  const kase = await prisma.case.create({
    data: {
      intakeType: "denial_letter",
      rawIntakeText: "seed intake for review-overlap property test",
      status: "New",
      slaDeadline: new Date("2026-01-15T12:00:00.000Z"),
    },
  });
  return kase.id;
}

describe("Property 37: Medical_Review and Policy_Review overlap in time (Req 20.2)", () => {
  it("each review stage begins before the other completes, across timings", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          preMedical: fc.integer({ min: 0, max: 4 }),
          postMedical: fc.integer({ min: 0, max: 4 }),
          prePolicy: fc.integer({ min: 0, max: 4 }),
          postPolicy: fc.integer({ min: 0, max: 4 }),
        }),
        async (timings) => {
          const state: RunState = {
            medicalStarted: deferred(),
            policyStarted: deferred(),
            medicalStart: null,
            medicalEnd: null,
            policyStart: null,
            policyEnd: null,
            ...timings,
          };
          hoisted.current = state;

          const caseId = await seedCase();
          await runner.runAgent(caseId);

          // Both stages must have actually run (all four timestamps captured).
          expect(state.medicalStart).not.toBeNull();
          expect(state.medicalEnd).not.toBeNull();
          expect(state.policyStart).not.toBeNull();
          expect(state.policyEnd).not.toBeNull();

          const mStart = state.medicalStart as number;
          const mEnd = state.medicalEnd as number;
          const pStart = state.policyStart as number;
          const pEnd = state.policyEnd as number;

          // Req 20.2 / Property 37 — the two execution windows overlap:
          //   medicalStart < policyEnd  AND  policyStart < medicalEnd.
          expect(mStart).toBeLessThan(pEnd);
          expect(pStart).toBeLessThan(mEnd);
        },
      ),
      FC_CONFIG,
    );
  }, 300_000);
});
