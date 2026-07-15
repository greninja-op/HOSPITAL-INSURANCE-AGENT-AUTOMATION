/**
 * lib/agentRunner.explanation.test.ts
 *
 * Property test (Task 11.24) — Property 33: Plain-English explanation is always
 * produced.
 *
 * Feature: authpilot.
 *
 *   For ANY completed agent run — across EVERY Resolution_Path (Auto_Draft,
 *   Draft_And_Request_Evidence, Escalate_To_Human) — the pipeline
 *   (`runAgent` in `lib/agentRunner.ts`, Decision_Intelligence stage, Task 11.23)
 *   assembles and persists a NON-EMPTY, jargon-free plain-English explanation of
 *   the denial reason and the next steps on `Case.plainEnglishExplanation` for
 *   front-office staff to share with the patient.
 *
 * **Validates: Requirements 15.1**
 *
 * Strategy (mirrors the sibling `lib/agentRunner.*.test.ts` pattern —
 * `vi.mock("./qwen")` + `createTestDb`): drive the REAL `runAgent` pipeline end
 * to end against an isolated, throwaway PostgreSQL schema, replacing only the
 * network / side-effecting seams with DETERMINISTIC fakes so the property is
 * exercised without the live Qwen model or real PDF I/O:
 *
 *   • `./qwen`.callQwen — a deterministic FAKE that always COMPLETES a stage on
 *     its first iteration with no tool calls (content "{}" is valid JSON, so the
 *     JSON-parsing stages fall back cleanly and the prose stages use it as their
 *     assessment text). No network is touched.
 *   • `./decisionEngine`.decide — mocked to FORCE the sampled Resolution_Path so
 *     the pipeline reaches / completes Decision_Intelligence on every path; the
 *     rest of the module (e.g. `computeOverallConfidence`) is preserved.
 *   • `./appealPdf`.generateAppealPdf — stubbed to return a fake url; no PDF is
 *     rendered or written to disk.
 *
 * Vitest + fast-check, shared FC_CONFIG (numRuns 100).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type { CaseStatus, QwenOutcome, ResolutionPath } from "./types";

// ─── Hoisted controller shared with the module mocks ──────────────────────────
// Carries the Resolution_Path the mocked `decide` must return for the current
// property sample, so a single mock definition serves every generated case.
const controller = vi.hoisted(() => ({
  decision: null as { path: string; status: string } | null,
}));

// FAKE Qwen: every stage completes immediately with no tool calls. "{}" parses
// as valid-but-empty JSON so extraction/JSON stages degrade to their documented
// fallbacks while prose stages use it verbatim — the whole pipeline runs with no
// network. Other exports (types, helpers) are preserved.
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

// FORCE the Resolution_Path for the current sample so Decision_Intelligence
// completes with a known path on every run. Everything else is preserved.
vi.mock("./decisionEngine", async (importActual) => {
  const actual = await importActual<typeof import("./decisionEngine")>();
  return {
    ...actual,
    decide: () => controller.decision,
  };
});

// Stub the appeal-PDF tool so the drafting paths never touch disk.
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
  // importing the runner, so `lib/db.ts` and the runner both target it.
  testDb = await createTestDb();
  process.env.DATABASE_URL = testDb.databaseUrl;

  runAgent = (await import("./agentRunner")).runAgent;
  prisma = (await import("./db")).prisma;
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** The Case_Status the Decision_Engine derives for a path (mirrors decisionEngine). */
function statusForPath(path: ResolutionPath): CaseStatus {
  return path === "Escalate_To_Human" ? "NeedsHumanInput" : "AwaitingApproval";
}

/** Read back the persisted explanation for a Case. */
async function readExplanation(caseId: string): Promise<string | null> {
  const kase = await prisma.case.findUnique({
    where: { id: caseId },
    select: { plainEnglishExplanation: true },
  });
  return kase?.plainEnglishExplanation ?? null;
}

/** Seed a fresh, independent Case (status New) for one sample and return its id. */
async function seedCase(
  intakeType: string,
  rawIntakeText: string,
  urgent: boolean,
): Promise<string> {
  const kase = await prisma.case.create({
    data: {
      intakeType,
      // Guarantee a non-empty raw intake even when the generator yields blanks.
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
// Constrained to the input space that actually reaches Decision_Intelligence:
// the three Resolution_Paths, the supported intake types, and arbitrary (but
// non-empty) raw intake text with an urgency flag.

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

describe("runAgent — Property 33: plain-English explanation is always produced (Task 11.24)", () => {
  it(
    "persists a NON-EMPTY Case.plainEnglishExplanation for every completed run on every Resolution_Path",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          resolutionPathArb,
          intakeTypeArb,
          rawIntakeArb,
          fc.boolean(),
          async (path, intakeType, rawIntakeText, urgent) => {
            // Arrange: a fresh Case + a Decision_Engine forced onto `path`.
            const caseId = await seedCase(intakeType, rawIntakeText, urgent);
            controller.decision = { path, status: statusForPath(path) };

            // Act: run the real pipeline end to end.
            const result = await runAgent(caseId);

            // The forced path drove the run to completion on the expected path.
            expect(result.resolutionPath).toBe(path);

            // Property: the stored explanation is present and non-empty.
            const explanation = await readExplanation(caseId);
            expect(typeof explanation).toBe("string");
            expect((explanation ?? "").trim().length).toBeGreaterThan(0);
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});

// ─── Representative examples (deterministic, one per Resolution_Path) ─────────

describe("runAgent — plain-English explanation (per-path examples)", () => {
  const cases: ReadonlyArray<[ResolutionPath, string, string]> = [
    ["Auto_Draft", "denial_letter", "high-confidence denial"],
    ["Draft_And_Request_Evidence", "new_pa_request", "medium-confidence request"],
    ["Escalate_To_Human", "phone_note", "low-confidence escalation"],
  ];

  for (const [path, intakeType, note] of cases) {
    it(`${path} produces a non-empty explanation`, async () => {
      const caseId = await seedCase(intakeType, note, false);
      controller.decision = { path, status: statusForPath(path) };

      await runAgent(caseId);

      const explanation = await readExplanation(caseId);
      expect((explanation ?? "").trim().length).toBeGreaterThan(0);
    });
  }
});
