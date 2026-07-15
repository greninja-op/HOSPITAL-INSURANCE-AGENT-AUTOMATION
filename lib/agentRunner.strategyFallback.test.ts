/**
 * lib/agentRunner.strategyFallback.test.ts
 *
 * Property test (Task 11.12): the Strategy stage falls back to the payer track
 * record only when prior-auth history is unavailable.
 *
 * Feature: authpilot, Property 45: Strategy fallback when history is unavailable.
 *
 *   In the Strategy stage, when `checkPriorAuthHistory` returns an EMPTY history
 *   OR the tool call FAILS, the stage falls back to the payer track record only
 *   and records `usedPriorAuthHistory: false`. When the tool returns a NON-EMPTY
 *   history, the stage records `usedPriorAuthHistory: true`.
 *
 * Validates: Requirements 21.3
 *
 * Strategy: drive the real `runAgent` pipeline end to end against an isolated,
 * throwaway PostgreSQL schema (via `createTestDb`), replacing the two network/
 * side-effecting seams with deterministic fakes so the Strategy stage's fallback
 * decision is exercised without the live Qwen model:
 *
 *   • `./qwen`.callQwen is mocked with a FAKE Qwen that routes by the stage's
 *     system prompt. Intake / Medical / Policy each complete immediately; the
 *     Strategy stage first requests `checkPriorAuthHistory`, then (after the
 *     observation is appended) returns a final options JSON. Any stage AFTER
 *     Strategy degrades so the run halts once `strategyOptions` is persisted.
 *   • `./agentTools`.dispatchTool is mocked to return a CONTROLLED observation
 *     for `checkPriorAuthHistory` — an empty history, a tool failure, or a
 *     non-empty history — per property sample. No DB/network/filesystem is
 *     touched inside the loop.
 *
 * After the run, the persisted `Case.strategyOptions.usedPriorAuthHistory` is
 * asserted against the scenario: false for empty/error, true for available.
 *
 * `runAgent` exposes no deps seam, so both fakes are injected by mocking the
 * modules `runStage` defaults to. Uses Vitest + fast-check (numRuns 100),
 * consistent with the rest of the suite.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type { ChatMessage } from "./qwen";
import type { QwenOutcome } from "./types";
import type { ToolObservation } from "./agentTools";

// ─── Hoisted controller shared with the module mocks ──────────────────────────
//
// `vi.mock` factories are hoisted above imports, so the mutable state they close
// over must be created with `vi.hoisted`. Each property sample sets
// `controller.historyObservation` to the CONTROLLED `checkPriorAuthHistory`
// observation the fake dispatch should return for that run.
const controller = vi.hoisted(() => ({
  historyObservation: null as unknown, // set per sample to a ToolObservation
}));

// FAKE Qwen: route by the stage's system prompt. Preserve every other `./qwen`
// export so unrelated importers are unaffected.
vi.mock("./qwen", async (importActual) => {
  const actual = await importActual<typeof import("./qwen")>();

  const success = (content: string): QwenOutcome => ({
    ok: true as const,
    toolCalls: [],
    content,
  });

  // A structured transient failure to halt the pipeline once Strategy has
  // persisted its Strategy_Options (Req 6.9) — keeps each run lean.
  const degrade = (): QwenOutcome => ({
    ok: false as const,
    kind: "network" as const,
    transient: true,
    attempts: 3,
    detail: "fake degrade to short-circuit the pipeline after the Strategy stage",
  });

  return {
    ...actual,
    callQwen: async (messages: ChatMessage[]): Promise<QwenOutcome> => {
      const sys =
        typeof messages[0]?.content === "string" ? messages[0].content : "";

      // Intake_And_Extraction — return an (all-unknown) extraction and continue.
      if (sys.includes("the Intake_And_Extraction stage")) {
        return success("{}");
      }
      // Medical_Review / Policy_Review — complete immediately.
      if (sys.includes("the Medical_Review stage")) {
        return success("Medical review: chart assessed for clinical necessity.");
      }
      if (sys.includes("the Policy_Review stage")) {
        return success("Policy review: payer criteria assessed.");
      }

      // Strategy — first request prior-auth history, then (after the tool
      // observation is appended) return the final options JSON.
      if (sys.includes("the Strategy stage")) {
        const alreadyObserved = messages.some((m) => m.role === "tool");
        if (!alreadyObserved) {
          return {
            ok: true as const,
            content: null,
            toolCalls: [
              {
                id: "call_hist",
                name: "checkPriorAuthHistory",
                arguments: { patientId: "patient-under-test" },
              },
            ],
          };
        }
        return success(
          JSON.stringify({
            options: [
              {
                approach: "Appeal citing medical necessity",
                winProbability: 70,
                rationale: "Payer track record supports this approach.",
              },
            ],
            payerTrackRecordSummary: "Payer resolves similar cases favorably.",
          }),
        );
      }

      // Any stage after Strategy — degrade to halt the pipeline (Strategy_Options
      // is already persisted).
      return degrade();
    },
  };
});

// Hermetic dispatch: return the CONTROLLED observation for checkPriorAuthHistory;
// any other tool resolves to a benign error observation (never invoked here).
// Preserve every other `./agentTools` export.
vi.mock("./agentTools", async (importActual) => {
  const actual = await importActual<typeof import("./agentTools")>();
  return {
    ...actual,
    dispatchTool: async (name: string): Promise<ToolObservation> => {
      if (name === "checkPriorAuthHistory") {
        return controller.historyObservation as ToolObservation;
      }
      return {
        ok: false as const,
        tool: name,
        error: "mocked dispatch (strategy-fallback test): tool intentionally not run",
      };
    },
  };
});

let testDb: TestDb;
let prisma: PrismaClient;
let runAgent: typeof import("./agentRunner").runAgent;

beforeAll(async () => {
  // Provision an isolated schema and bind the shared Prisma client to it BEFORE
  // importing the runner, so `lib/db.ts` and the runner write to the test schema.
  testDb = await createTestDb();
  process.env.DATABASE_URL = testDb.databaseUrl;

  const runner = await import("./agentRunner");
  runAgent = runner.runAgent;

  const db = await import("./db");
  prisma = db.prisma;
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

// ─── Scenario model + generators ──────────────────────────────────────────────

type HistoryScenario =
  | { kind: "empty" } // tool succeeded but returned an empty history
  | { kind: "error"; message: string } // the tool call failed
  | { kind: "available"; count: number }; // tool returned a non-empty history

/** Build the controlled `checkPriorAuthHistory` observation for a scenario. */
function observationFor(scenario: HistoryScenario): ToolObservation {
  switch (scenario.kind) {
    case "empty":
      return { ok: true, tool: "checkPriorAuthHistory", result: [] };
    case "error":
      return { ok: false, tool: "checkPriorAuthHistory", error: scenario.message };
    case "available":
      return {
        ok: true,
        tool: "checkPriorAuthHistory",
        result: Array.from({ length: scenario.count }, (_, i) => ({
          id: `case_${i}`,
          status: "Resolved",
          resolutionPath: "Auto_Draft",
        })),
      };
  }
}

/** true only when a non-empty history is available (Req 21.3). */
function expectedUsedHistory(scenario: HistoryScenario): boolean {
  return scenario.kind === "available";
}

const scenarioArb: fc.Arbitrary<HistoryScenario> = fc.oneof(
  fc.constant<HistoryScenario>({ kind: "empty" }),
  fc
    .string({ minLength: 1, maxLength: 40 })
    .map<HistoryScenario>((message) => ({ kind: "error", message })),
  fc
    .integer({ min: 1, max: 5 })
    .map<HistoryScenario>((count) => ({ kind: "available", count })),
);

const intakeTypeArb = fc.constantFrom(
  "denial_letter",
  "new_pa_request",
  "phone_note",
  "whatsapp_patient_note",
);
const rawIntakeArb = fc.string({ minLength: 1, maxLength: 120 });

/** Seed a fresh, independent Case (status New) for one property sample. */
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

/** Read the persisted `usedPriorAuthHistory` flag off Case.strategyOptions. */
async function readUsedHistory(caseId: string): Promise<boolean | undefined> {
  const kase = await prisma.case.findUnique({
    where: { id: caseId },
    select: { strategyOptions: true },
  });
  const so = kase?.strategyOptions as { usedPriorAuthHistory?: unknown } | null;
  return typeof so?.usedPriorAuthHistory === "boolean"
    ? so.usedPriorAuthHistory
    : undefined;
}

/** Read the number of persisted Strategy_Options off Case.strategyOptions. */
async function readOptionCount(caseId: string): Promise<number> {
  const kase = await prisma.case.findUnique({
    where: { id: caseId },
    select: { strategyOptions: true },
  });
  const so = kase?.strategyOptions as { options?: unknown } | null;
  return Array.isArray(so?.options) ? so!.options.length : 0;
}

// ─── Property 45 ───────────────────────────────────────────────────────────────

describe("runAgent — Strategy fallback when history is unavailable (Task 11.12, Property 45)", () => {
  it(
    "sets usedPriorAuthHistory=false for empty/failed history and true for a non-empty history",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          scenarioArb,
          intakeTypeArb,
          rawIntakeArb,
          fc.boolean(),
          async (scenario, intakeType, rawIntakeText, urgent) => {
            // Arrange: a fresh Case and the controlled history observation.
            const caseId = await seedCase(intakeType, rawIntakeText, urgent);
            controller.historyObservation = observationFor(scenario);

            // Act: run the real pipeline through the Strategy stage.
            await runAgent(caseId);

            // Assert: the persisted fallback flag matches the scenario (Req 21.3).
            const used = await readUsedHistory(caseId);
            expect(used).toBe(expectedUsedHistory(scenario));

            // And options are still produced (1..5) regardless of scenario —
            // the fallback case must not drop the candidate approaches (Req 21.2/21.3).
            const optionCount = await readOptionCount(caseId);
            expect(optionCount).toBeGreaterThanOrEqual(1);
            expect(optionCount).toBeLessThanOrEqual(5);
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});

// ─── Focused examples (deterministic, illustrative) ───────────────────────────

describe("runAgent — Strategy fallback (representative examples)", () => {
  it("falls back (usedPriorAuthHistory=false) when history is EMPTY", async () => {
    const caseId = await seedCase("new_pa_request", "denied: not medically necessary", false);
    controller.historyObservation = observationFor({ kind: "empty" });

    await runAgent(caseId);

    expect(await readUsedHistory(caseId)).toBe(false);
  });

  it("falls back (usedPriorAuthHistory=false) when the history tool FAILS", async () => {
    const caseId = await seedCase("denial_letter", "opaque intake", true);
    controller.historyObservation = observationFor({
      kind: "error",
      message: "checkPriorAuthHistory failed",
    });

    await runAgent(caseId);

    expect(await readUsedHistory(caseId)).toBe(false);
  });

  it("uses history (usedPriorAuthHistory=true) when a NON-EMPTY history is returned", async () => {
    const caseId = await seedCase("phone_note", "prior denial on file", false);
    controller.historyObservation = observationFor({ kind: "available", count: 3 });

    await runAgent(caseId);

    expect(await readUsedHistory(caseId)).toBe(true);
  });
});
