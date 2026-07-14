/**
 * lib/agentRunner.appealConditional.test.ts
 *
 * Property test (Task 11.16): conditional appeal generation.
 *
 * Feature: authpilot, Property 19: Appeal PDF generated only on drafting paths.
 *
 *   For ANY completed agent run, the generate-appeal-PDF tool is invoked IF AND
 *   ONLY IF the Resolution_Path is Auto_Draft or Draft_And_Request_Evidence
 *   (never on Escalate_To_Human). The Appeal_Generation stage
 *   (`lib/agentRunner.ts`) drafts the appeal PDF on the two drafting paths and
 *   skips generation on escalation.
 *
 * **Validates: Requirements 7.1**
 *
 * Strategy: drive the real `runAgent` pipeline end to end against an isolated,
 * throwaway PostgreSQL schema (via `createTestDb`), replacing only the network /
 * side-effecting seams with deterministic fakes so the conditional is exercised
 * without the live Qwen model or real PDF I/O:
 *
 *   • `./qwen`.callQwen is mocked to a FAKE that always COMPLETES a stage —
 *     every call returns `{ ok: true, toolCalls: [], content: "{}" }`, so each
 *     runStage-backed stage (Intake, Medical/Policy review, Strategy,
 *     Verification) finalizes on its first iteration with no network.
 *   • `./decisionEngine`.decide is mocked to FORCE the sampled Resolution_Path
 *     (with its derived Case_Status), so the pipeline reaches Appeal_Generation
 *     with a known path — every other decisionEngine export (e.g.
 *     `computeOverallConfidence`) is preserved via `importActual`.
 *   • `./appealPdf`.generateAppealPdf is stubbed to a spy that records the
 *     caseId it was invoked with (and returns a fake url) — no PDF is rendered
 *     or written to disk. This is the "generate-appeal-PDF tool" whose
 *     invocation the property observes.
 *
 * `runAgent` exposes no deps seam, so all three fakes are injected by mocking
 * the modules the runner imports. Uses Vitest + fast-check (numRuns 100),
 * consistent with the rest of the suite.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type { CaseStatus, QwenOutcome, ResolutionPath } from "./types";

// ─── Hoisted controller shared with the module mocks ──────────────────────────
//
// `vi.mock` factories are hoisted above imports, so the mutable state they close
// over must be created with `vi.hoisted`. Each property sample sets
// `controller.decision` to the FORCED decision for that run and resets
// `controller.generatedCaseIds` before invoking `runAgent`.
const controller = vi.hoisted(() => ({
  /** The decision the mocked `decide` returns for the current sample. */
  decision: null as { path: string; status: string } | null,
  /** caseIds that the stubbed `generateAppealPdf` was invoked with. */
  generatedCaseIds: [] as string[],
}));

// FAKE Qwen: every stage completes immediately (no tool calls). Content "{}" is
// valid JSON so the JSON-parsing stages (intake, strategy) degrade cleanly to
// their empty/fallback shapes; the prose stages (medical/policy) simply use it
// as their assessment text. Preserve every other `./qwen` export.
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

// FORCE the Resolution_Path: the pure Decision_Engine `decide` returns the
// sampled decision so the pipeline reaches Appeal_Generation with a known path.
// Preserve `computeOverallConfidence` and everything else via importActual.
vi.mock("./decisionEngine", async (importActual) => {
  const actual = await importActual<typeof import("./decisionEngine")>();
  return {
    ...actual,
    decide: () => controller.decision,
  };
});

// Stub the generate-appeal-PDF tool: record the caseId and return a fake url —
// no PDF is rendered or written. Preserve every other `./appealPdf` export.
vi.mock("./appealPdf", async (importActual) => {
  const actual = await importActual<typeof import("./appealPdf")>();
  return {
    ...actual,
    generateAppealPdf: async (caseId: string) => {
      controller.generatedCaseIds.push(caseId);
      return { url: `/appeals/${caseId}.pdf` };
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** The two Resolution_Paths that DRAFT an appeal (Req 7.1). */
const DRAFTING_PATHS: ReadonlySet<ResolutionPath> = new Set<ResolutionPath>([
  "Auto_Draft",
  "Draft_And_Request_Evidence",
]);

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

// ─── Property 19 ───────────────────────────────────────────────────────────────

describe("runAgent — appeal PDF generated only on drafting paths (Task 11.16, Property 19)", () => {
  it(
    "invokes generate-appeal-PDF iff the Resolution_Path is Auto_Draft or Draft_And_Request_Evidence",
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
            controller.generatedCaseIds = [];

            // Act: run the real pipeline end to end.
            const result = await runAgent(caseId);

            const isDrafting = DRAFTING_PATHS.has(path);

            // The forced path drove the run (sanity: the decision seam took effect).
            expect(result.resolutionPath).toBe(path);

            // (1) generate-appeal-PDF invoked IFF the path is a drafting path.
            const invoked = controller.generatedCaseIds.includes(caseId);
            expect(invoked).toBe(isDrafting);

            // (2) The Appeal_Packet location reference is stored IFF drafting.
            const kase = await prisma.case.findUnique({
              where: { id: caseId },
              select: { appealPdfUrl: true },
            });
            if (isDrafting) {
              expect(kase?.appealPdfUrl).toBeTruthy();
            } else {
              expect(kase?.appealPdfUrl ?? null).toBeNull();
            }
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});

// ─── Focused examples (deterministic, illustrative) ───────────────────────────

describe("runAgent — conditional appeal generation (representative examples)", () => {
  it("Auto_Draft generates and stores the appeal PDF", async () => {
    const caseId = await seedCase("denial_letter", "high-confidence denial", false);
    controller.decision = { path: "Auto_Draft", status: "AwaitingApproval" };
    controller.generatedCaseIds = [];

    await runAgent(caseId);

    expect(controller.generatedCaseIds).toContain(caseId);
    const kase = await prisma.case.findUnique({
      where: { id: caseId },
      select: { appealPdfUrl: true },
    });
    expect(kase?.appealPdfUrl).toBeTruthy();
  });

  it("Draft_And_Request_Evidence generates the appeal PDF", async () => {
    const caseId = await seedCase("new_pa_request", "medium-confidence request", true);
    controller.decision = {
      path: "Draft_And_Request_Evidence",
      status: "AwaitingApproval",
    };
    controller.generatedCaseIds = [];

    await runAgent(caseId);

    expect(controller.generatedCaseIds).toContain(caseId);
  });

  it("Escalate_To_Human skips appeal PDF generation", async () => {
    const caseId = await seedCase("phone_note", "low-confidence escalation", false);
    controller.decision = { path: "Escalate_To_Human", status: "NeedsHumanInput" };
    controller.generatedCaseIds = [];

    await runAgent(caseId);

    expect(controller.generatedCaseIds).not.toContain(caseId);
    const kase = await prisma.case.findUnique({
      where: { id: caseId },
      select: { appealPdfUrl: true },
    });
    expect(kase?.appealPdfUrl ?? null).toBeNull();
  });
});
