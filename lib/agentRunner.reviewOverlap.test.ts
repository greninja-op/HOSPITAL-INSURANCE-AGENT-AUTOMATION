/**
 * lib/agentRunner.reviewOverlap.test.ts
 *
 * Property test (Task 11.8) — Property 37: Medical and Policy reviews overlap.
 *
 * Feature: authpilot.
 *
 *   *For any* agent run that reaches the review phase, the execution windows of
 *   the Medical_Review and Policy_Review stages overlap — each stage begins
 *   before the other stage completes:
 *
 *       medicalStart < policyEnd  AND  policyStart < medicalEnd.
 *
 * **Validates: Requirements 20.2**
 *
 * Strategy: the review concurrency lives in `runAgent` (`lib/agentRunner.ts`),
 * which awaits the two review stages together —
 * `Promise.all([runStage(..., "Medical_Review"), runStage(..., "Policy_Review")])`
 * — but exposes no `deps` seam. So (mirroring lib/agentRunner.stageOrdering.test.ts)
 * this drives the REAL pipeline end to end against an isolated, throwaway
 * PostgreSQL schema (`createTestDb`) and instruments the two reviews at the only
 * network seam `runStage` defaults to: `./qwen`.callQwen.
 *
 * Rather than wall-clock timing (flaky), overlap is proven DETERMINISTICALLY
 * with a two-party BARRIER and a logical clock (design testing strategy:
 * "instrumented per-stage start/end timestamps rather than wall-clock timing"):
 *
 *   • Each review's mocked `callQwen` stamps its START, then `arrive()`s at a
 *     size-2 barrier and BLOCKS until BOTH reviews have started, then stamps its
 *     END and returns. Because both starts are stamped before either end, the
 *     overlap invariant holds for every run.
 *   • This also proves TRUE concurrency (not sequential execution): if `runAgent`
 *     ran the reviews sequentially, the first review's `callQwen` would block at
 *     the barrier forever waiting for the second to start — a deadlock the
 *     barrier's timeout surfaces as a clear failure instead of a hang.
 *   • fast-check varies artificial microtask delays (scheduling jitter) before
 *     each start and before each end; the overlap invariant must hold regardless.
 *
 * Every non-review stage's `callQwen` returns valid-but-empty JSON ("{}") so the
 * whole pipeline runs without the live model. `./appealPdf`.generateAppealPdf is
 * stubbed so no PDF is rendered or written. Uses Vitest + fast-check (numRuns 100).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type { PipelineStage, QwenOutcome } from "./types";

// ─── Instrumentation controller shared with the module mock ───────────────────
//
// `vi.mock` factories are hoisted above imports, so the mutable state the mocked
// `callQwen` closes over must be created with `vi.hoisted`. Each property sample
// installs a fresh `onReview` hook (barrier + timeline) before invoking runAgent.
const controller = vi.hoisted(() => ({
  // Invoked once per review stage with the stage name; resolves when that stage
  // may "complete". Null between samples.
  onReview: null as
    | null
    | ((stage: "Medical_Review" | "Policy_Review") => Promise<void>),
}));

// FAKE Qwen: identify the two review stages by their unique system-prompt
// opening line and route them through the per-sample `onReview` hook (which
// records timestamps + enforces the barrier). Every other stage completes
// immediately with valid-but-empty JSON so the full pipeline runs offline.
vi.mock("./qwen", async (importActual) => {
  const actual = await importActual<typeof import("./qwen")>();
  return {
    ...actual,
    callQwen: async (
      messages: { role: string; content: string | null }[],
    ): Promise<QwenOutcome> => {
      const system = messages?.[0]?.content ?? "";
      let stage: "Medical_Review" | "Policy_Review" | null = null;
      if (system.includes("You are the Medical_Review stage")) {
        stage = "Medical_Review";
      } else if (system.includes("You are the Policy_Review stage")) {
        stage = "Policy_Review";
      }
      if (stage && controller.onReview) {
        await controller.onReview(stage);
      }
      return { ok: true as const, toolCalls: [], content: "{}" };
    },
  };
});

// Stub the generate-appeal-PDF tool: return a fake url — no PDF is rendered or
// written. Preserve every other `./appealPdf` export.
vi.mock("./appealPdf", async (importActual) => {
  const actual = await importActual<typeof import("./appealPdf")>();
  return {
    ...actual,
    generateAppealPdf: async (caseId: string) => ({
      url: `/appeals/${caseId}.pdf`,
    }),
  };
});

let testDb: TestDb;
let prisma: PrismaClient;
let runAgent: typeof import("./agentRunner").runAgent;
let runStage: typeof import("./agentRunner").runStage;

beforeAll(async () => {
  // Provision an isolated schema and bind its client as the shared singleton
  // BEFORE importing the runner, so `runAgent` and `createTraceStep` write to it.
  testDb = await createTestDb();
  prisma = testDb.prisma;
  process.env.DATABASE_URL = testDb.databaseUrl;
  (globalThis as unknown as { prisma?: PrismaClient }).prisma = prisma;

  const runner = await import("./agentRunner");
  runAgent = runner.runAgent;
  runStage = runner.runStage;
}, 120_000);

afterEach(() => {
  controller.onReview = null;
});

afterAll(async () => {
  await testDb?.cleanup();
});

// ─── Deterministic overlap harness (barrier + logical clock) ──────────────────

interface ReviewTimeline {
  Medical_Review?: { start: number; end: number };
  Policy_Review?: { start: number; end: number };
}

/**
 * A two-party rendezvous barrier: `arrive()` blocks until BOTH parties have
 * arrived, then releases them together. A timeout rejects every waiter with a
 * clear message so a regression that runs the reviews SEQUENTIALLY surfaces as a
 * failing assertion rather than an infinite hang.
 */
function makeBarrier(parties: number, timeoutMs = 5_000) {
  let arrived = 0;
  let release!: () => void;
  let fail!: (err: Error) => void;
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const timer = setTimeout(
    () =>
      fail(
        new Error(
          "review barrier timed out: Medical_Review and Policy_Review did not overlap (ran sequentially?)",
        ),
      ),
    timeoutMs,
  );
  return {
    async arrive() {
      arrived += 1;
      if (arrived >= parties) {
        clearTimeout(timer);
        release();
      }
      await gate;
    },
  };
}

/** Yield `n` microtasks — deterministic scheduling jitter, no wall-clock. */
async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

/**
 * Install a fresh barrier-backed `onReview` hook and return the timeline it
 * fills. `before`/`after` are per-stage microtask delays (fast-check varies them)
 * that jitter the scheduling around the START stamp and the END stamp.
 */
function installOverlapHarness(delays: {
  medical: { before: number; after: number };
  policy: { before: number; after: number };
}): ReviewTimeline {
  const timeline: ReviewTimeline = {};
  const barrier = makeBarrier(2);
  let clock = 0;
  const stamp = () => (clock += 1);

  controller.onReview = async (stage) => {
    const d = stage === "Medical_Review" ? delays.medical : delays.policy;
    await ticks(d.before);
    const start = stamp(); // the stage's Qwen call has BEGUN
    await barrier.arrive(); // block until BOTH reviews have begun
    await ticks(d.after);
    const end = stamp(); // the stage's Qwen call COMPLETES
    timeline[stage] = { start, end };
  };

  return timeline;
}

/** Assert the two review windows overlap (design Property 37 / Req 20.2). */
function assertOverlap(timeline: ReviewTimeline): void {
  const medical = timeline.Medical_Review;
  const policy = timeline.Policy_Review;

  // Both reviews must have executed (the review phase was reached).
  expect(medical).toBeDefined();
  expect(policy).toBeDefined();
  const m = medical!;
  const p = policy!;

  // A stage's own window is well-formed.
  expect(m.start).toBeLessThan(m.end);
  expect(p.start).toBeLessThan(p.end);

  // The overlap invariant: each begins before the other completes.
  expect(m.start).toBeLessThan(p.end); // medicalStart < policyEnd
  expect(p.start).toBeLessThan(m.end); // policyStart < medicalEnd
}

// ─── Seeding / generators ─────────────────────────────────────────────────────

/** Seed a fresh, independent Case (status New) for one sample. */
async function seedCase(
  intakeType: string,
  rawIntakeText: string,
  urgent: boolean,
): Promise<string> {
  const kase = await prisma.case.create({
    data: {
      intakeType,
      rawIntakeText: rawIntakeText.trim() === "" ? "intake" : rawIntakeText,
      status: "New",
      isUrgent: urgent,
      slaDeadline: new Date("2099-01-01T00:00:00.000Z"),
    },
    select: { id: true },
  });
  return kase.id;
}

const intakeTypeArb = fc.constantFrom(
  "denial_letter",
  "new_pa_request",
  "phone_note",
  "whatsapp_patient_note",
);
const rawIntakeArb = fc.string({ minLength: 1, maxLength: 120 });
/** Per-stage microtask delays around the START and END stamps. */
const delayArb = fc.record({
  before: fc.nat({ max: 5 }),
  after: fc.nat({ max: 5 }),
});

// ─── Property 37 ──────────────────────────────────────────────────────────────

describe("runAgent — Medical/Policy review overlap (Task 11.8, Property 37)", () => {
  it(
    "for any run reaching the review phase, medicalStart < policyEnd AND policyStart < medicalEnd",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          intakeTypeArb,
          rawIntakeArb,
          fc.boolean(),
          delayArb,
          delayArb,
          async (intakeType, rawIntakeText, urgent, medical, policy) => {
            const caseId = await seedCase(intakeType, rawIntakeText, urgent);
            const timeline = installOverlapHarness({ medical, policy });

            await runAgent(caseId);

            assertOverlap(timeline);
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});

// ─── Direct-seam examples: Promise.all([runStage(Medical), runStage(Policy)]) ──
//
// These mirror the design's exact review wiring against the EXPORTED `runStage`
// engine (no DB, fully deterministic), documenting the overlap seam in isolation.

describe("runStage — concurrent reviews overlap (representative examples)", () => {
  function reviewPlan(
    stage: "Medical_Review" | "Policy_Review",
    onCall: (stage: "Medical_Review" | "Policy_Review") => Promise<void>,
  ) {
    return {
      stage: stage as PipelineStage,
      systemPrompt: `plan:${stage}`,
      userPrompt: "ctx",
      finalize: () => ({ stage }),
      // Injected fake Qwen: run the barrier hook, then complete immediately.
      deps: {
        callQwen: async (): Promise<QwenOutcome> => {
          await onCall(stage);
          return { ok: true as const, toolCalls: [], content: "done" };
        },
      },
    };
  }

  it("both stages begin before either completes when awaited together", async () => {
    const timeline: ReviewTimeline = {};
    const barrier = makeBarrier(2);
    let clock = 0;
    const stamp = () => (clock += 1);

    const onCall = async (stage: "Medical_Review" | "Policy_Review") => {
      const start = stamp();
      await barrier.arrive();
      const end = stamp();
      timeline[stage] = { start, end };
    };

    const medical = reviewPlan("Medical_Review", onCall);
    const policy = reviewPlan("Policy_Review", onCall);

    // Exactly the shape runAgent uses: the two reviews awaited together.
    await Promise.all([
      runStage("case-x", medical, medical.deps),
      runStage("case-x", policy, policy.deps),
    ]);

    assertOverlap(timeline);
  });

  it("overlap holds regardless of which review's work is scheduled first", async () => {
    const timeline: ReviewTimeline = {};
    const barrier = makeBarrier(2);
    let clock = 0;
    const stamp = () => (clock += 1);

    // Policy jitters more before starting; Medical jitters more before ending —
    // the barrier still forces both starts ahead of both ends.
    const jitter: Record<string, { before: number; after: number }> = {
      Medical_Review: { before: 0, after: 3 },
      Policy_Review: { before: 3, after: 0 },
    };
    const onCall = async (stage: "Medical_Review" | "Policy_Review") => {
      await ticks(jitter[stage].before);
      const start = stamp();
      await barrier.arrive();
      await ticks(jitter[stage].after);
      const end = stamp();
      timeline[stage] = { start, end };
    };

    const medical = reviewPlan("Medical_Review", onCall);
    const policy = reviewPlan("Policy_Review", onCall);

    await Promise.all([
      runStage("case-y", medical, medical.deps),
      runStage("case-y", policy, policy.deps),
    ]);

    assertOverlap(timeline);
  });
});
