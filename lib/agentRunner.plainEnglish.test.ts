/**
 * lib/agentRunner.plainEnglish.test.ts
 *
 * Property test (Task 11.24): plain-English explanation is always produced.
 *
 * Feature: authpilot, Property 33: Plain-English explanation is always produced.
 *
 *   For ANY completed agent run (across every Resolution_Path — Auto_Draft,
 *   Draft_And_Request_Evidence, and Escalate_To_Human), the Decision_Intelligence
 *   stage (`lib/agentRunner.ts`, Task 11.23) produces a NON-EMPTY, jargon-free
 *   plain-English explanation of the denial reason + next steps and persists it
 *   on `Case.plainEnglishExplanation` for front-office staff to share with the
 *   patient.
 *
 * **Validates: Requirements 15.1**
 *
 * Strategy: drive the real `runAgent` pipeline end to end against an isolated,
 * throwaway PostgreSQL schema (via `createTestDb`), replacing only the network /
 * side-effecting seams with deterministic fakes so the property is exercised
 * without the live Qwen model or real PDF I/O (mirrors
 * `lib/agentRunner.appealConditional.test.ts`):
 *
 *   • `./qwen`.callQwen is mocked to a FAKE that always COMPLETES a stage —
 *     every call returns `{ ok: true, toolCalls: [], content: "{}" }`, so each
 *     runStage-backed stage finalizes on its first iteration with no network.
 *   • `./decisionEngine`.decide is mocked to FORCE the sampled Resolution_Path
 *     (with its derived Case_Status) so the pipeline reaches / completes the
 *     Decision_Intelligence stage on every path — `computeOverallConfidence`
 *     and everything else is preserved via `importActual`.
 *   • `./appealPdf`.generateAppealPdf is stubbed to return a fake url — no PDF
 *     is rendered or written to disk.
 *
 * Uses Vitest + fast-check (numRuns 100), consistent with the rest of the suite.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type { CaseStatus, QwenOutcome, ResolutionPath } from "./types";

// ─── Hoisted controller shared with the module mocks ──────────────────────────
const controller = vi.hoisted(() => ({
  /** The decision the mocked `decide` returns for the current sample. */
  decision: null as { path: string; status: string } | null,
}));

// FAKE Qwen: every stage completes immediately (no tool calls). Content "{}" is
// valid JSON so the JSON-parsing stages degrade cleanly to their fallback shapes
// and the prose stages use it as their assessment text. Preserve other exports.
vi.mock("./qwen", async (importActual) => {
  const actual = await importActual<typeof import("./qwen")>();
  return {
    ...actual,
    callQwen: async (): Promise<QwenOutcome> => ({
      ok: true as const,
      toolCalls: [],
      content: "{}",
    }),
  };
});

// FORCE the Resolution_Path so the pipeline completes Decision_Intelligence with
// a known path on every sample. Preserve everything else via importActual.
vi.mock("./decisionEngine", async (importActual) => {
  const actual = await importActual<typeof import("./decisionEngine")>();
  return {
    ...actual,
    decide: () => controller.decision,
  };
});

// Stub the generate-appeal-PDF tool: return a fake url — no PDF is rendered.
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** The Case_Status the Decision_Engine derives for a path (mirrors decisionEngine). */
function statusForPath(path: ResolutionPath): CaseStatus {
  return path === "Escalate_To_Human" ? "NeedsHumanInput" : "AwaitingApproval";
}

/** Seed a fresh, independent Case (status New) for one property sample. */
async function seedCase(
  intakeType: string,
  rawIntakeText: string,
  urgent: boolean,
): Promise<string> {
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

// ─── Generators ───────────────────────────────────────────────────────────────

const resolutionPathArb: fc.Arbitrary<ResolutionPath> = fc.constantFrom(
  "Auto_Draft",
  "Draft_And_Request_Evidence",
  "Escalate_To_Human",
);

const intakeTypeArb = fc.constantFrom(
  "denial_letter",
  "new_pa_request",
  "phone_note",
  "whatsapp_patient_note",
);
const rawIntakeArb = fc.string({ minLength: 1, maxLength: 120 });

// ─── Property 33 ───────────────────────────────────────────────────────────────

describe("runAgent — plain-English explanation is always produced (Task 11.24, Property 33)", () => {
  it(
    "persists a NON-EMPTY Case.plainEnglishExplanation for every completed run across all Resolution_Paths",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          resolutionPathArb,
          intakeTypeArb,
          rawIntakeArb,
          fc.boolean(),
          async (path, intakeType, rawIntakeText, urgent) => {
            // Arrange: a fresh Case and a Decision_Engine forced to `path`.
            const caseId = await seedCase(intakeType, rawIntakeText, urgent);
            controller.decision = { path, status: statusForPath(path) };

            // Act: run the real pipeline end to end.
            const result = await runAgent(caseId);

            // Sanity: the forced path drove the run to completion.
            expect(result.resolutionPath).toBe(path);

            // Property: the plain-English explanation is a non-empty string.
            const kase = await prisma.case.findUnique({
              where: { id: caseId },
              select: { plainEnglishExplanation: true },
            });
            expect(typeof kase?.plainEnglishExplanation).toBe("string");
            expect((kase?.plainEnglishExplanation ?? "").trim().length).toBeGreaterThan(0);
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});

// ─── Focused examples (deterministic, illustrative) ───────────────────────────

describe("runAgent — plain-English explanation (representative examples)", () => {
  it("Auto_Draft produces a non-empty explanation", async () => {
    const caseId = await seedCase("denial_letter", "high-confidence denial", false);
    controller.decision = { path: "Auto_Draft", status: "AwaitingApproval" };

    await runAgent(caseId);

    const kase = await prisma.case.findUnique({
      where: { id: caseId },
      select: { plainEnglishExplanation: true },
    });
    expect((kase?.plainEnglishExplanation ?? "").trim().length).toBeGreaterThan(0);
  });

  it("Draft_And_Request_Evidence produces a non-empty explanation", async () => {
    const caseId = await seedCase("new_pa_request", "medium-confidence request", true);
    controller.decision = {
      path: "Draft_And_Request_Evidence",
      status: "AwaitingApproval",
    };

    await runAgent(caseId);

    const kase = await prisma.case.findUnique({
      where: { id: caseId },
      select: { plainEnglishExplanation: true },
    });
    expect((kase?.plainEnglishExplanation ?? "").trim().length).toBeGreaterThan(0);
  });

  it("Escalate_To_Human still produces a non-empty explanation", async () => {
    const caseId = await seedCase("phone_note", "low-confidence escalation", false);
    controller.decision = { path: "Escalate_To_Human", status: "NeedsHumanInput" };

    await runAgent(caseId);

    const kase = await prisma.case.findUnique({
      where: { id: caseId },
      select: { plainEnglishExplanation: true },
    });
    expect((kase?.plainEnglishExplanation ?? "").trim().length).toBeGreaterThan(0);
  });
});
