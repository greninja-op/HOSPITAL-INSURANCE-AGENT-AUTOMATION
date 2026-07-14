/**
 * lib/agentRunner.loopCap.test.ts
 *
 * Property test (Task 11.2): the loop cap forces escalation.
 *
 * Feature: authpilot, Property 17: Loop cap forces escalation.
 *
 *   For ANY agent run in which Qwen never returns a final decision, the
 *   plan → tool_call → observe loop runs AT MOST 8 iterations
 *   (`MAX_STAGE_ITERATIONS`) and then STOPS by forcing Resolution_Path
 *   `Escalate_To_Human` (Case_Status `NeedsHumanInput`) and recording a
 *   Trace_Step whose reasoning is exactly "needs manual review" — the pipeline
 *   never loops unbounded.
 *
 * Validates: Requirements 6.4
 *
 * Strategy: drive the real `runAgent` pipeline end to end against an isolated,
 * throwaway PostgreSQL schema (via `createTestDb`), but replace the two network/
 * side-effecting seams with deterministic fakes so the loop cap is exercised
 * without the live model:
 *
 *   • `./qwen`.callQwen is mocked with a FAKE Qwen that NEVER yields a terminal
 *     decision — every call returns `{ ok: true, toolCalls: [>=1], content }`,
 *     so `runStage` can never "complete" and is driven to loop-cap exhaustion.
 *     The fake also counts its invocations so the test can assert the ≤ 8 bound.
 *   • `./agentTools`.dispatchTool is mocked to a hermetic no-op that returns an
 *     error observation (no DB/network/filesystem), since the tool a
 *     never-terminal model "requests" is irrelevant to the loop-cap property.
 *
 * `runAgent` does not expose a deps seam, so both fakes are injected by mocking
 * the modules `runStage` defaults to. Only the Intake_And_Extraction stage runs
 * (it exhausts first and halts the pipeline), so no later stage is reached.
 *
 * Uses Vitest + fast-check (numRuns 100), consistent with the rest of the suite.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type { QwenOutcome } from "./types";

// ─── Hoisted fake-Qwen controller (shared with the module mock) ───────────────
//
// `vi.mock` factories are hoisted above imports, so the mutable controller they
// close over must be created with `vi.hoisted`. Each property sample sets
// `controller.response` to a generated NEVER-TERMINAL Qwen outcome and resets
// `controller.callCount` before invoking `runAgent`.
const controller = vi.hoisted(() => ({
  response: null as unknown, // set per sample to a non-terminal QwenOutcome
  callCount: 0,
}));

// FAKE Qwen: never returns a final decision. Preserve every other `./qwen`
// export so unrelated importers are unaffected.
vi.mock("./qwen", async (importActual) => {
  const actual = await importActual<typeof import("./qwen")>();
  return {
    ...actual,
    callQwen: async () => {
      controller.callCount += 1;
      return controller.response as QwenOutcome;
    },
  };
});

// Hermetic dispatch: the never-terminal model may "request" any tool; short-
// circuit every dispatch to an error observation so no DB/network/filesystem is
// touched inside the bounded loop. Preserve every other `./agentTools` export.
vi.mock("./agentTools", async (importActual) => {
  const actual = await importActual<typeof import("./agentTools")>();
  return {
    ...actual,
    dispatchTool: async (name: string) => ({
      ok: false as const,
      tool: name,
      error: "mocked dispatch (loop-cap test): tool intentionally not run",
    }),
  };
});

let testDb: TestDb;
let prisma: PrismaClient;
let runAgent: typeof import("./agentRunner").runAgent;
let MAX_STAGE_ITERATIONS: number;

beforeAll(async () => {
  // Provision an isolated schema and bind the shared Prisma client to it BEFORE
  // importing the runner, so `lib/db.ts` and the runner write to the test schema.
  testDb = await createTestDb();
  process.env.DATABASE_URL = testDb.databaseUrl;

  const runner = await import("./agentRunner");
  runAgent = runner.runAgent;
  MAX_STAGE_ITERATIONS = runner.MAX_STAGE_ITERATIONS;

  const db = await import("./db");
  prisma = db.prisma;
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

// ─── Generators ───────────────────────────────────────────────────────────────

/** A single tool call the fake model "requests" (dispatch is mocked, so shape only). */
const toolCallArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }).map((s) => `call_${s}`),
  // Includes real allow-listed names and arbitrary/unknown names — irrelevant to
  // the property because dispatch is mocked, but keeps the input space broad.
  name: fc.constantFrom(
    "lookupDiagnosisCode",
    "fetchPatientRecord",
    "fetchPayerPolicy",
    "checkPriorAuthHistory",
    "generateAppealPdf",
    "someUnknownTool",
  ),
  arguments: fc.dictionary(
    fc.string({ maxLength: 6 }),
    fc.oneof(fc.string({ maxLength: 10 }), fc.integer(), fc.boolean()),
    { maxKeys: 3 },
  ),
});

/**
 * A NEVER-TERMINAL Qwen outcome: `ok: true` with AT LEAST ONE tool call, so
 * `runStage` always dispatches + iterates and can never reach a final answer.
 * `content` may be null or arbitrary text — either way, a non-empty toolCalls
 * array keeps the loop going.
 */
const nonTerminalOutcomeArb: fc.Arbitrary<QwenOutcome> = fc
  .record({
    content: fc.option(fc.string({ maxLength: 40 }), { nil: null }),
    toolCalls: fc.array(toolCallArb, { minLength: 1, maxLength: 3 }),
  })
  .map(({ content, toolCalls }) => ({ ok: true as const, content, toolCalls }));

/** Case intake context varied across samples (does not affect the loop cap). */
const intakeTypeArb = fc.constantFrom(
  "denial_letter",
  "new_pa_request",
  "phone_note",
  "whatsapp_patient_note",
);
const rawIntakeArb = fc.string({ minLength: 1, maxLength: 120 });

/** Seed a fresh, independent Case (status New) for one property sample. */
async function seedCase(intakeType: string, rawIntakeText: string, urgent: boolean) {
  const kase = await prisma.case.create({
    data: {
      intakeType,
      // Guarantee a non-empty raw intake even if the generator yields whitespace.
      rawIntakeText: rawIntakeText.trim() === "" ? "intake" : rawIntakeText,
      status: "New",
      isUrgent: urgent,
      slaDeadline: new Date("2099-01-01T00:00:00.000Z"),
    },
    select: { id: true },
  });
  return kase.id;
}

// ─── Property 17 ───────────────────────────────────────────────────────────────

describe("runAgent — loop cap forces escalation (Task 11.2, Property 17)", () => {
  it(
    "for any run where Qwen never decides, bounds the loop at <= 8 and forces Escalate_To_Human with a 'needs manual review' Trace_Step",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          nonTerminalOutcomeArb,
          intakeTypeArb,
          rawIntakeArb,
          fc.boolean(),
          async (response, intakeType, rawIntakeText, urgent) => {
            // Arrange: a fresh Case and a fake Qwen that never returns a decision.
            const caseId = await seedCase(intakeType, rawIntakeText, urgent);
            controller.response = response;
            controller.callCount = 0;

            // Act: run the real pipeline.
            const result = await runAgent(caseId);

            // (1) The bounded loop ran AT MOST the cap and never unbounded. Since
            //     the model never decides, it must reach the cap exactly.
            expect(controller.callCount).toBeLessThanOrEqual(MAX_STAGE_ITERATIONS);
            expect(controller.callCount).toBe(MAX_STAGE_ITERATIONS);

            // (2) The run terminated by forcing escalation (Req 6.4).
            expect(result.resolutionPath).toBe("Escalate_To_Human");
            expect(result.status).toBe("NeedsHumanInput");

            // (3) The forced escalation is persisted on the Case.
            const kase = await prisma.case.findUnique({
              where: { id: caseId },
              select: { resolutionPath: true, status: true },
            });
            expect(kase?.resolutionPath).toBe("Escalate_To_Human");
            expect(kase?.status).toBe("NeedsHumanInput");

            // (4) A "decision" Trace_Step recorded the mandated reasoning verbatim.
            const manualReview = await prisma.traceStep.findFirst({
              where: {
                caseId,
                stepType: "decision",
                reasoning: "needs manual review",
              },
            });
            expect(manualReview).not.toBeNull();
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});

// ─── Focused examples (deterministic, illustrative) ───────────────────────────

describe("runAgent — loop cap (representative examples)", () => {
  it("stops after exactly 8 Qwen calls when the model always requests a tool", async () => {
    const caseId = await seedCase("new_pa_request", "denied: needs manual review", false);
    controller.callCount = 0;
    controller.response = {
      ok: true,
      content: null,
      toolCalls: [{ id: "call_1", name: "lookupDiagnosisCode", arguments: {} }],
    } as QwenOutcome;

    const result = await runAgent(caseId);

    expect(controller.callCount).toBe(8);
    expect(result.resolutionPath).toBe("Escalate_To_Human");
    expect(result.status).toBe("NeedsHumanInput");
  });

  it("records the 'needs manual review' decision Trace_Step on exhaustion", async () => {
    const caseId = await seedCase("denial_letter", "opaque intake", true);
    controller.callCount = 0;
    controller.response = {
      ok: true,
      content: "still thinking...",
      toolCalls: [
        { id: "call_a", name: "fetchPatientRecord", arguments: { patientId: "x" } },
        { id: "call_b", name: "someUnknownTool", arguments: {} },
      ],
    } as QwenOutcome;

    await runAgent(caseId);

    const step = await prisma.traceStep.findFirst({
      where: { caseId, stepType: "decision", reasoning: "needs manual review" },
    });
    expect(step).not.toBeNull();
  });
});
