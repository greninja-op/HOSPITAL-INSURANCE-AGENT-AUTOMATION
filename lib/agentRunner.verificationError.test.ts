/**
 * lib/agentRunner.verificationError.test.ts
 *
 * Property test (Task 11.22): verification processing error yields a fail result.
 *
 * Feature: authpilot, Property 49: Verification processing error yields a fail
 * result.
 *
 *   Whenever the Verification_QA stage (`lib/agentRunner.ts`) hits a PROCESSING
 *   ERROR while checking the drafted Appeal_Packet (e.g. a re-read tool dispatch
 *   throws mid-verification), the stored `Case.verificationResult.status` is
 *   `"fail"` and a single blocking `verification_error` FlaggedIssue is present;
 *   the appeal is never presented as verified.
 *
 * **Validates: Requirements 22.7**
 *
 * Strategy: drive the real `runAgent` pipeline end to end against an isolated,
 * throwaway PostgreSQL schema (via `createTestDb`), replacing only the network /
 * side-effecting seams with deterministic fakes so the error path is exercised
 * without the live Qwen model or real PDF I/O:
 *
 *   • `./qwen`.callQwen is mocked to a FAKE that always COMPLETES a stage —
 *     every call returns `{ ok: true, toolCalls: [], content: "{}" }`, so each
 *     runStage-backed stage finalizes on its first iteration with no network and
 *     never requests a tool call.
 *   • `./decisionEngine`.decide is mocked to FORCE a DRAFTING Resolution_Path so
 *     the pipeline actually generates an Appeal_Packet and reaches
 *     Verification_QA (escalation has no appeal to verify). Every other
 *     decisionEngine export is preserved via importActual.
 *   • `./appealPdf`.generateAppealPdf is stubbed so no PDF is rendered; it stores
 *     a fake url so Verification_QA sees an Appeal_Packet to verify.
 *   • `./agentTools`.dispatchTool is wrapped so that DURING the Verification_QA
 *     stage (and only then) the re-read tool dispatch THROWS a sampled error —
 *     this is the injected "verification processing error". Every earlier stage
 *     (which, under the fake Qwen, never dispatches a tool) is unaffected, and
 *     every other agentTools export is preserved via importActual.
 *
 * Because each seeded Case is linked to a real Patient (patientId set), the
 * Verification_QA stage always performs a `fetchPatientRecord` re-read, so the
 * injected throw reliably lands inside the stage's guarded checks (Req 22.7).
 *
 * Uses Vitest + fast-check (numRuns 100), consistent with the rest of the suite.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type {
  CaseStatus,
  FlaggedIssue,
  QwenOutcome,
  ResolutionPath,
  VerificationResult,
} from "./types";

// ─── Hoisted controller shared with the module mocks ──────────────────────────
//
// `vi.mock` factories are hoisted above imports, so the mutable state they close
// over must be created with `vi.hoisted`. Each property sample sets the FORCED
// decision and the error to inject during Verification_QA before invoking
// `runAgent`.
const controller = vi.hoisted(() => ({
  /** The decision the mocked `decide` returns for the current sample. */
  decision: null as { path: string; status: string } | null,
  /** The error thrown by the wrapped dispatchTool during Verification_QA. */
  error: null as unknown,
}));

// FAKE Qwen: every stage completes immediately with no tool calls. Content "{}"
// is valid JSON so the JSON-parsing stages degrade cleanly to their fallback
// shapes. Preserve every other `./qwen` export.
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

// FORCE the Resolution_Path so the pipeline drafts an appeal and reaches
// Verification_QA. Preserve `computeOverallConfidence` and everything else.
vi.mock("./decisionEngine", async (importActual) => {
  const actual = await importActual<typeof import("./decisionEngine")>();
  return {
    ...actual,
    decide: () => controller.decision,
  };
});

// Stub the generate-appeal-PDF tool: store a fake url (so Verification_QA has an
// Appeal_Packet to verify) without rendering a PDF. Preserve other exports.
vi.mock("./appealPdf", async (importActual) => {
  const actual = await importActual<typeof import("./appealPdf")>();
  return {
    ...actual,
    generateAppealPdf: async (caseId: string) => ({
      url: `/appeals/${caseId}.pdf`,
    }),
  };
});

// Wrap dispatchTool: during Verification_QA (only) throw the sampled error to
// simulate a mid-verification processing failure; otherwise defer to the real
// implementation. Preserve every other `./agentTools` export.
vi.mock("./agentTools", async (importActual) => {
  const actual = await importActual<typeof import("./agentTools")>();
  return {
    ...actual,
    dispatchTool: async (
      name: string,
      args: Record<string, unknown>,
      caseId: string,
      stage: import("./types").PipelineStage,
    ) => {
      if (stage === "Verification_QA") {
        throw controller.error;
      }
      return actual.dispatchTool(name, args, caseId, stage);
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

/** The Case_Status the Decision_Engine derives for a drafting path. */
function statusForPath(path: ResolutionPath): CaseStatus {
  return path === "Escalate_To_Human" ? "NeedsHumanInput" : "AwaitingApproval";
}

/**
 * Seed a fresh, independent Case (status New) LINKED to a real Patient, so the
 * Verification_QA stage always performs a `fetchPatientRecord` re-read (the seam
 * the injected error is thrown from).
 */
async function seedLinkedCase(
  intakeType: string,
  rawIntakeText: string,
  urgent: boolean,
): Promise<string> {
  const payer = await prisma.payer.create({
    data: { name: `Payer ${Math.random().toString(36).slice(2, 8)}` },
    select: { id: true },
  });
  const patient = await prisma.patient.create({
    data: {
      name: `Patient ${Math.random().toString(36).slice(2, 8)}`,
      dob: new Date("1980-01-01T00:00:00.000Z"),
      payerId: payer.id,
    },
    select: { id: true },
  });
  const kase = await prisma.case.create({
    data: {
      intakeType,
      // Guarantee a non-empty raw intake even if the generator yields whitespace.
      rawIntakeText: rawIntakeText.trim() === "" ? "intake" : rawIntakeText,
      status: "New",
      isUrgent: urgent,
      patientId: patient.id,
      slaDeadline: new Date("2099-01-01T00:00:00.000Z"),
    },
    select: { id: true },
  });
  return kase.id;
}

// ─── Generators ───────────────────────────────────────────────────────────────

/** Only the two DRAFTING paths draft an appeal that Verification_QA verifies. */
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

// The injected verification failure: an `Error` (handled via `.message`) or a
// non-Error throw (handled via `String(err)`) — both must yield a fail result.
const injectedErrorArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ maxLength: 80 }).map((m) => new Error(m)),
  fc.string({ maxLength: 80 }),
);

// ─── Property 49 ───────────────────────────────────────────────────────────────

describe("runAgent — verification processing error yields a fail result (Task 11.22, Property 49)", () => {
  it(
    "stores status 'fail' with a verification_error flagged issue whenever verification processing errors",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          draftingPathArb,
          intakeTypeArb,
          rawIntakeArb,
          fc.boolean(),
          injectedErrorArb,
          async (path, intakeType, rawIntakeText, urgent, injectedError) => {
            // Arrange: a fresh linked Case, a forced drafting decision, and the
            // error to throw mid-verification.
            const caseId = await seedLinkedCase(intakeType, rawIntakeText, urgent);
            controller.decision = { path, status: statusForPath(path) };
            controller.error = injectedError;

            // Act: run the real pipeline end to end (Verification_QA errors).
            await runAgent(caseId);

            // Assert: the stored Verification_Result is a fail carrying a
            // verification_error flagged issue (Req 22.7).
            const kase = await prisma.case.findUnique({
              where: { id: caseId },
              select: { verificationResult: true },
            });
            expect(kase?.verificationResult).toBeTruthy();

            const result = kase!.verificationResult as unknown as VerificationResult;
            expect(result.status).toBe("fail");

            const issues: FlaggedIssue[] = Array.isArray(result.flaggedIssues)
              ? result.flaggedIssues
              : [];
            const verificationErrors = issues.filter(
              (i) => i.type === "verification_error",
            );
            expect(verificationErrors.length).toBeGreaterThanOrEqual(1);
            // The processing-error path records a single blocking issue.
            expect(verificationErrors[0]?.severity).toBe("blocking");
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});

// ─── Focused examples (deterministic, illustrative) ───────────────────────────

describe("runAgent — verification processing error (representative examples)", () => {
  it("Auto_Draft: a thrown Error during verification stores a fail result", async () => {
    const caseId = await seedLinkedCase("denial_letter", "denial appeal", false);
    controller.decision = { path: "Auto_Draft", status: "AwaitingApproval" };
    controller.error = new Error("re-read failed");

    await runAgent(caseId);

    const kase = await prisma.case.findUnique({
      where: { id: caseId },
      select: { verificationResult: true },
    });
    const result = kase!.verificationResult as unknown as VerificationResult;
    expect(result.status).toBe("fail");
    expect(
      result.flaggedIssues.some((i) => i.type === "verification_error"),
    ).toBe(true);
  });

  it("Draft_And_Request_Evidence: a non-Error throw still stores a fail result", async () => {
    const caseId = await seedLinkedCase("new_pa_request", "pa request", true);
    controller.decision = {
      path: "Draft_And_Request_Evidence",
      status: "AwaitingApproval",
    };
    controller.error = "string failure";

    await runAgent(caseId);

    const kase = await prisma.case.findUnique({
      where: { id: caseId },
      select: { verificationResult: true },
    });
    const result = kase!.verificationResult as unknown as VerificationResult;
    expect(result.status).toBe("fail");
    expect(
      result.flaggedIssues.some((i) => i.type === "verification_error"),
    ).toBe(true);
  });
});
