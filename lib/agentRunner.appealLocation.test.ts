/**
 * lib/agentRunner.appealLocation.test.ts
 *
 * Property test (Task 11.17): the appeal location is stored on the Case.
 *
 * Feature: authpilot, Property 21: Appeal location is stored.
 *
 *   For ANY agent run, the Appeal_Generation stage stores a location reference
 *   on the Case EXACTLY when it generates an Appeal_Packet:
 *     • on the two DRAFTING Resolution_Paths (Auto_Draft /
 *       Draft_And_Request_Evidence) an appeal PDF is generated and the returned
 *       location reference is persisted to `Case.appealPdfUrl` as a NON-EMPTY
 *       string;
 *     • on Escalate_To_Human no appeal is generated and `Case.appealPdfUrl`
 *       remains unset (null).
 *
 * Validates: Requirements 7.4
 *
 * Strategy: drive the real `runAgent` pipeline end to end against an isolated,
 * throwaway PostgreSQL schema (via `createTestDb`), replacing the two
 * network / filesystem seams with deterministic fakes so no live model or disk
 * write is exercised:
 *
 *   • `./qwen`.callQwen is mocked with a STAGE-AWARE fake. For the
 *     Intake_And_Extraction stage it returns a JSON extraction whose five
 *     fields all carry a generated confidence — this is the ONLY lever the
 *     deterministic Decision_Engine uses to pick the Resolution_Path (mean
 *     per-field confidence, with no blocking findings in the pipeline), so the
 *     generated confidence deterministically selects a drafting vs. escalation
 *     path. Every other Qwen-calling stage (Medical_Review, Policy_Review,
 *     Strategy) receives a benign final answer so it completes.
 *   • `./appealPdf`.generateAppealPdf is stubbed to a hermetic fake that records
 *     the caseId it was asked to render and returns a non-empty `/appeals/<id>.pdf`
 *     location reference WITHOUT touching the filesystem.
 *
 * `runAgent` does not expose a deps seam, so both fakes are injected by mocking
 * the modules the pipeline imports. Persistence uses the isolated schema bound
 * as the shared Prisma client BEFORE importing the runner.
 *
 * Uses Vitest + fast-check (numRuns 100), consistent with the rest of the suite.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type { AppealContent, QwenOutcome, ResolutionPath } from "./types";

// ─── Hoisted fake controllers (shared with the module mocks) ──────────────────
//
// `vi.mock` factories are hoisted above imports, so the mutable state they close
// over must be created with `vi.hoisted`. `intakeConfidence` is set per property
// sample (0..1) BEFORE invoking `runAgent`; `appealCalls` records every caseId
// the stubbed generateAppealPdf was asked to render.
const controller = vi.hoisted(() => ({
  intakeConfidence: 0,
  appealCalls: [] as string[],
}));

// STAGE-AWARE fake Qwen: route by the stage's system prompt (messages[0]).
// Intake gets a JSON five-field extraction at the generated confidence; every
// other stage gets a benign final answer (no tool calls) so it completes.
vi.mock("./qwen", async (importActual) => {
  const actual = await importActual<typeof import("./qwen")>();
  const c = controller;
  return {
    ...actual,
    callQwen: async (
      messages: { role: string; content: string | null }[],
    ): Promise<QwenOutcome> => {
      const system = messages[0]?.content ?? "";
      if (system.includes("Intake_And_Extraction")) {
        const conf = c.intakeConfidence;
        const field = (value: string) => ({
          value,
          confidence: conf,
          reasoning: "fake intake extraction",
        });
        const extraction = {
          patient: field("Jane Roe"),
          payer: field("Acme Health"),
          procedureCode: field("70551"),
          diagnosisCode: field("M54.5"),
          denialReason: field("not medically necessary"),
        };
        return { ok: true, toolCalls: [], content: JSON.stringify(extraction) };
      }
      // Medical_Review / Policy_Review / Strategy — a benign completing answer.
      return {
        ok: true,
        toolCalls: [],
        content: "Assessment complete for the purposes of this test.",
      };
    },
  };
});

// Hermetic appeal generator: never writes a PDF. Records the caseId and returns
// a non-empty, servable-looking location reference derived from the caseId.
vi.mock("./appealPdf", async (importActual) => {
  const actual = await importActual<typeof import("./appealPdf")>();
  const c = controller;
  return {
    ...actual,
    generateAppealPdf: async (
      caseId: string,
      _content: AppealContent,
    ): Promise<{ url: string }> => {
      c.appealCalls.push(caseId);
      return { url: `/appeals/${caseId}.pdf` };
    },
  };
});

let testDb: TestDb;
let prisma: PrismaClient;
let runAgent: typeof import("./agentRunner").runAgent;

const DRAFTING_PATHS: ReadonlySet<ResolutionPath> = new Set<ResolutionPath>([
  "Auto_Draft",
  "Draft_And_Request_Evidence",
]);

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

// ─── Generators ───────────────────────────────────────────────────────────────

const intakeTypeArb = fc.constantFrom(
  "denial_letter",
  "new_pa_request",
  "phone_note",
  "whatsapp_patient_note",
);

/**
 * A confidence + expected outcome. Two clearly-separated bands keep the mapping
 * to the Decision_Engine unambiguous (well away from the 60 / 85 thresholds):
 *   • [0, 0.55]   → mean 0..55 (< 60)   → Escalate_To_Human (no appeal)
 *   • [0.65, 1.0] → mean 65..100 (>= 60) → a drafting path (appeal generated)
 */
const scenarioArb = fc.oneof(
  fc
    .double({ min: 0, max: 0.55, noNaN: true })
    .map((confidence) => ({ confidence, expectDrafting: false })),
  fc
    .double({ min: 0.65, max: 1, noNaN: true })
    .map((confidence) => ({ confidence, expectDrafting: true })),
);

/** Seed a fresh, independent Case (status New) for one property sample. */
async function seedCase(intakeType: string): Promise<string> {
  const kase = await prisma.case.create({
    data: {
      intakeType,
      rawIntakeText:
        "Patient Jane Roe, payer Acme Health, procedure 70551, dx M54.5, denied as not medically necessary.",
      status: "New",
      isUrgent: false,
      slaDeadline: new Date("2099-01-01T00:00:00.000Z"),
    },
    select: { id: true },
  });
  return kase.id;
}

// ─── Property 21 ────────────────────────────────────────────────────────────────

describe("runAgent — appeal location is stored (Task 11.17, Property 21)", () => {
  // **Validates: Requirements 7.4**
  it(
    "stores a non-empty Case.appealPdfUrl exactly when an Appeal_Packet is generated (drafting paths), and leaves it unset on Escalate_To_Human",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          scenarioArb,
          intakeTypeArb,
          async ({ confidence, expectDrafting }, intakeType) => {
            // Arrange: a fresh Case; the intake confidence steers the path.
            const caseId = await seedCase(intakeType);
            controller.intakeConfidence = confidence;

            // Act: run the real pipeline end to end.
            const result = await runAgent(caseId);

            const kase = await prisma.case.findUnique({
              where: { id: caseId },
              select: { resolutionPath: true, appealPdfUrl: true },
            });
            const path = kase?.resolutionPath as ResolutionPath | null;
            const generated = controller.appealCalls.includes(caseId);

            // The RunResult mirrors the persisted Resolution_Path.
            expect(result.resolutionPath).toBe(path);

            if (DRAFTING_PATHS.has(path as ResolutionPath)) {
              // An Appeal_Packet was generated → a NON-EMPTY location reference
              // is stored on the Case, and it is the generator's returned url.
              expect(generated).toBe(true);
              expect(kase?.appealPdfUrl).toBe(`/appeals/${caseId}.pdf`);
              expect((kase?.appealPdfUrl ?? "").length).toBeGreaterThan(0);
            } else {
              // Escalate_To_Human → no appeal generated, location stays unset.
              expect(path).toBe("Escalate_To_Human");
              expect(generated).toBe(false);
              expect(kase?.appealPdfUrl).toBeNull();
            }

            // The generated flag is exactly the drafting-path predicate.
            expect(generated).toBe(DRAFTING_PATHS.has(path as ResolutionPath));

            // The generated flag agrees with the band we steered the run into.
            expect(generated).toBe(expectDrafting);
          },
        ),
        FC_CONFIG,
      );
    },
    600_000,
  );
});

// ─── Focused examples (deterministic, illustrative) ───────────────────────────

describe("runAgent — appeal location (representative examples)", () => {
  it("stores appealPdfUrl on the high-confidence Auto_Draft path", async () => {
    const caseId = await seedCase("new_pa_request");
    controller.intakeConfidence = 0.95; // mean 95 > 85 → Auto_Draft

    const result = await runAgent(caseId);

    expect(result.resolutionPath).toBe("Auto_Draft");
    const kase = await prisma.case.findUnique({
      where: { id: caseId },
      select: { appealPdfUrl: true },
    });
    expect(kase?.appealPdfUrl).toBe(`/appeals/${caseId}.pdf`);
    expect(controller.appealCalls).toContain(caseId);
  });

  it("stores appealPdfUrl on the medium-confidence Draft_And_Request_Evidence path", async () => {
    const caseId = await seedCase("denial_letter");
    controller.intakeConfidence = 0.75; // mean 75 in [60, 85]

    const result = await runAgent(caseId);

    expect(result.resolutionPath).toBe("Draft_And_Request_Evidence");
    const kase = await prisma.case.findUnique({
      where: { id: caseId },
      select: { appealPdfUrl: true },
    });
    expect(kase?.appealPdfUrl).toBe(`/appeals/${caseId}.pdf`);
    expect(controller.appealCalls).toContain(caseId);
  });

  it("leaves appealPdfUrl unset on the low-confidence Escalate_To_Human path", async () => {
    const caseId = await seedCase("phone_note");
    controller.intakeConfidence = 0.3; // mean 30 < 60 → Escalate_To_Human

    const result = await runAgent(caseId);

    expect(result.resolutionPath).toBe("Escalate_To_Human");
    const kase = await prisma.case.findUnique({
      where: { id: caseId },
      select: { appealPdfUrl: true },
    });
    expect(kase?.appealPdfUrl).toBeNull();
    expect(controller.appealCalls).not.toContain(caseId);
  });
});
