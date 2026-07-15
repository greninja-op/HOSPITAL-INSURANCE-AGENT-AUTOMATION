/**
 * lib/agentRunner.appealStorage.test.ts
 *
 * Property test (Task 11.17): appeal location storage.
 *
 * Feature: authpilot, Property 21: Appeal location is stored.
 *
 *   For ANY Appeal_Packet that is generated, the Case afterward has a non-empty
 *   Appeal_Packet location reference. Concretely: for any Case on a drafting
 *   path (Auto_Draft or Draft_And_Request_Evidence) where the Appeal_Generation
 *   stage (`lib/agentRunner.ts`) renders an appeal PDF, after the stage the
 *   Case's `appealPdfUrl` is a non-empty stored reference that MATCHES the
 *   location returned by the generate-appeal-PDF tool.
 *
 * **Validates: Requirements 7.4**
 *
 * Strategy (mirrors lib/agentRunner.appealConditional.test.ts): drive the REAL
 * `runAgent` pipeline end to end against an isolated, throwaway PostgreSQL
 * schema (via `createTestDb`), replacing only the network / side-effecting seams
 * with deterministic fakes so the storage path is exercised without the live
 * Qwen model or real PDF I/O:
 *
 *   • `./qwen`.callQwen is mocked to always COMPLETE a stage — every call
 *     returns `{ ok: true, toolCalls: [], content: "{}" }`, so each
 *     runStage-backed stage finalizes on its first iteration with no network.
 *   • `./decisionEngine`.decide is mocked to FORCE a sampled DRAFTING path (with
 *     its derived Case_Status), so every run reaches Appeal_Generation with a
 *     path that renders and stores a PDF.
 *   • `./appealPdf`.generateAppealPdf is stubbed to return a KNOWN, per-sample
 *     url and record, keyed by caseId, exactly what it returned. The property
 *     then asserts the Case's persisted `appealPdfUrl` equals that returned
 *     location (and is non-empty) — proving the stage stores the generated
 *     reference verbatim (Req 7.4).
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
// `controller.decision` (the FORCED decision) and `controller.nextUrl` (the
// KNOWN location the stubbed generator returns) before invoking `runAgent`, and
// reads back `controller.returnedByCaseId` to learn what the generator actually
// returned for that Case.
const controller = vi.hoisted(() => ({
  /** The decision the mocked `decide` returns for the current sample. */
  decision: null as { path: string; status: string } | null,
  /** The location the stubbed `generateAppealPdf` returns for the current sample. */
  nextUrl: "/appeals/placeholder.pdf",
  /** caseId → the exact url the stubbed generator returned for it. */
  returnedByCaseId: {} as Record<string, string>,
}));

// FAKE Qwen: every stage completes immediately (no tool calls). Content "{}" is
// valid JSON so the JSON-parsing stages degrade cleanly to their empty shapes.
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

// FORCE the Resolution_Path so the pipeline reaches Appeal_Generation with a
// known DRAFTING path. Preserve every other `./decisionEngine` export.
vi.mock("./decisionEngine", async (importActual) => {
  const actual = await importActual<typeof import("./decisionEngine")>();
  return {
    ...actual,
    decide: () => controller.decision,
  };
});

// Stub the generate-appeal-PDF tool: return the sample's KNOWN url and record it
// by caseId — no PDF is rendered or written. Preserve other `./appealPdf` exports.
vi.mock("./appealPdf", async (importActual) => {
  const actual = await importActual<typeof import("./appealPdf")>();
  return {
    ...actual,
    generateAppealPdf: async (caseId: string) => {
      const url = controller.nextUrl;
      controller.returnedByCaseId[caseId] = url;
      return { url };
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

/** ONLY the two drafting paths generate an appeal (Req 7.1) → storage applies. */
const draftingPathArb: fc.Arbitrary<ResolutionPath> = fc.constantFrom(
  "Auto_Draft",
  "Draft_And_Request_Evidence",
);

const intakeTypeArb = fc.constantFrom(
  "denial_letter",
  "new_pa_request",
  "phone_note",
  "whatsapp_patient_note",
);
const rawIntakeArb = fc.string({ minLength: 1, maxLength: 120 });

// A per-sample known location token so the stored value can only match if the
// stage persisted THIS run's generated reference (not a stale/fixed one).
const urlTokenArb = fc
  .string({ minLength: 1, maxLength: 24 })
  .map((s) => s.replace(/[^A-Za-z0-9._-]/g, "_"))
  .filter((s) => s.length > 0);

// ─── Property 21 ───────────────────────────────────────────────────────────────

describe("runAgent — appeal location is stored (Task 11.17, Property 21)", () => {
  it(
    "persists a non-empty Case.appealPdfUrl matching the generated location on drafting paths",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          draftingPathArb,
          intakeTypeArb,
          rawIntakeArb,
          fc.boolean(),
          urlTokenArb,
          async (path, intakeType, rawIntakeText, urgent, token) => {
            // Arrange: a fresh Case, a forced drafting decision, and the KNOWN
            // location the stubbed generator will return for this sample.
            const caseId = await seedCase(intakeType, rawIntakeText, urgent);
            controller.decision = { path, status: statusForPath(path) };
            controller.nextUrl = `/appeals/${token}.pdf`;
            controller.returnedByCaseId = {};

            // Act: run the real pipeline end to end (drafting path → an appeal
            // is generated → its location is stored on the Case).
            const result = await runAgent(caseId);

            // Sanity: the forced drafting path drove the run.
            expect(result.resolutionPath).toBe(path);

            // The generator was actually invoked and returned a known location.
            const generatedUrl = controller.returnedByCaseId[caseId];
            expect(generatedUrl).toBeDefined();

            // Req 7.4 — the Case afterward has a NON-EMPTY location reference
            // that MATCHES the location the generate-appeal-PDF tool returned.
            const kase = await prisma.case.findUnique({
              where: { id: caseId },
              select: { appealPdfUrl: true },
            });
            expect(kase?.appealPdfUrl).toBeTruthy();
            expect((kase?.appealPdfUrl ?? "").length).toBeGreaterThan(0);
            expect(kase?.appealPdfUrl).toBe(generatedUrl);
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});

// ─── Focused examples (deterministic, illustrative) ───────────────────────────

describe("runAgent — appeal location storage (representative examples)", () => {
  it("Auto_Draft stores the exact generated location on the Case", async () => {
    const caseId = await seedCase("denial_letter", "high-confidence denial", false);
    controller.decision = { path: "Auto_Draft", status: "AwaitingApproval" };
    controller.nextUrl = "/appeals/example-auto-draft.pdf";
    controller.returnedByCaseId = {};

    await runAgent(caseId);

    const kase = await prisma.case.findUnique({
      where: { id: caseId },
      select: { appealPdfUrl: true },
    });
    expect(kase?.appealPdfUrl).toBe(controller.returnedByCaseId[caseId]);
    expect(kase?.appealPdfUrl).toBe("/appeals/example-auto-draft.pdf");
  });

  it("Draft_And_Request_Evidence stores a non-empty generated location", async () => {
    const caseId = await seedCase("new_pa_request", "medium-confidence request", true);
    controller.decision = {
      path: "Draft_And_Request_Evidence",
      status: "AwaitingApproval",
    };
    controller.nextUrl = "/appeals/example-medium.pdf";
    controller.returnedByCaseId = {};

    await runAgent(caseId);

    const kase = await prisma.case.findUnique({
      where: { id: caseId },
      select: { appealPdfUrl: true },
    });
    expect(kase?.appealPdfUrl).toBeTruthy();
    expect(kase?.appealPdfUrl).toBe("/appeals/example-medium.pdf");
  });
});
