/**
 * lib/agentRunner.verificationPassFail.test.ts
 *
 * Property test (Task 11.20) — Property 47: Verification pass/fail definition.
 *
 * Feature: authpilot.
 *
 *   *For any* Appeal_Packet the Verification_QA stage checks, the stored
 *   `Verification_Result.status` is derived from the flagged-issues list by a
 *   strict biconditional: status === "pass" ⟺ the flagged-issues list is empty,
 *   and any non-empty flagged-issues list ⟹ status === "fail". Equivalently,
 *   there is never a `pass` carrying issues and never a `fail` with zero issues.
 *
 * **Validates: Requirements 22.4**
 *
 * There is no exported pure helper that maps flagged issues → status: the
 * derivation lives inline in the (non-exported) Verification_QA stage body of
 * `lib/agentRunner.ts` as `status: flaggedIssues.length === 0 ? "pass" : "fail"`.
 * So — as the task directs — this property drives the REAL `runAgent` pipeline
 * end to end against an isolated, throwaway PostgreSQL schema (`createTestDb`),
 * replacing only the network / side-effecting seams with deterministic fakes,
 * and asserts the biconditional on the ACTUAL persisted `Verification_Result`.
 *
 * Strategy (mirrors lib/agentRunner.verificationGate.test.ts):
 *
 *   • `./qwen`.callQwen — a FAKE that completes every stage on its first
 *     iteration (no network). It returns a controlled intake extraction when a
 *     sample supplies one (used to produce a fully-grounded, passing appeal),
 *     otherwise a benign `"{}"` (an ungrounded appeal whose citations cannot
 *     resolve → flagged issues → fail).
 *   • `./decisionEngine`.decide — mocked to FORCE a DRAFTING Resolution_Path so
 *     the pipeline actually reaches Verification_QA (the only paths that draft
 *     an appeal to verify). Every other export is preserved via `importActual`.
 *   • `./appealPdf`.generateAppealPdf — stubbed to return a fake url (no PDF is
 *     rendered or written).
 *
 * To exercise BOTH branches of the derivation, each sample chooses whether the
 * appeal is grounded: a grounded sample seeds matching Payer / Patient /
 * Chart_Note / Payer_Policy records and feeds a matching intake extraction, so
 * every citation resolves and the flagged-issues list is empty (→ pass); an
 * ungrounded sample seeds nothing, so citations cannot resolve and the list is
 * non-empty (→ fail). The property itself does NOT assume which branch a sample
 * lands in — it only asserts the pass/fail derivation holds for whatever list
 * results. Uses Vitest + fast-check (numRuns 100), consistent with the suite.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type { QwenOutcome, ResolutionPath, VerificationResult } from "./types";

// ─── Hoisted controller shared with the module mocks ──────────────────────────
//
// `vi.mock` factories are hoisted above imports, so the mutable state they close
// over must be created with `vi.hoisted`. Each sample sets `controller.decision`
// (the FORCED drafting decision) and, for a grounded sample,
// `controller.intakeExtraction` (the five-field extraction that resolves).
const controller = vi.hoisted(() => ({
  /** The decision the mocked `decide` returns for the current sample. */
  decision: null as { path: string; status: string } | null,
  /** Optional controlled intake extraction (else the intake fake returns "{}"). */
  intakeExtraction: null as Record<string, unknown> | null,
}));

// FAKE Qwen: every stage completes immediately (no tool calls). Content "{}" is
// valid JSON so the JSON-parsing stages degrade cleanly to their empty/fallback
// shapes and the prose stages use it as their assessment text. When a sample
// supplies `controller.intakeExtraction`, the Intake stage receives that exact
// five-field extraction (routed by the stage's system prompt).
vi.mock("./qwen", async (importActual) => {
  const actual = await importActual<typeof import("./qwen")>();
  return {
    ...actual,
    callQwen: async (
      messages: import("./qwen").ChatMessage[],
    ): Promise<QwenOutcome> => {
      const sys =
        typeof messages[0]?.content === "string" ? messages[0].content : "";
      if (
        sys.includes("the Intake_And_Extraction stage") &&
        controller.intakeExtraction
      ) {
        return {
          ok: true as const,
          toolCalls: [],
          content: JSON.stringify(controller.intakeExtraction),
        };
      }
      return { ok: true as const, toolCalls: [], content: "{}" };
    },
  };
});

// FORCE the (drafting) Resolution_Path so the pipeline reaches Verification_QA.
// Preserve `computeOverallConfidence` and everything else via importActual.
vi.mock("./decisionEngine", async (importActual) => {
  const actual = await importActual<typeof import("./decisionEngine")>();
  return {
    ...actual,
    decide: () => controller.decision,
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

beforeAll(async () => {
  // Provision an isolated schema and bind its client as the shared singleton
  // BEFORE importing the runner, so `runAgent` and `createTraceStep` write to it.
  testDb = await createTestDb();
  prisma = testDb.prisma;
  process.env.DATABASE_URL = testDb.databaseUrl;
  (globalThis as unknown as { prisma?: PrismaClient }).prisma = prisma;

  const runner = await import("./agentRunner");
  runAgent = runner.runAgent;
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Seed a fully in-scope Payer / Patient / Chart_Note / Payer_Policy set with
 * UNIQUE names (so 100 runs never collide) and return the matching five-field
 * intake extraction. Feeding this extraction makes every Appeal_Packet
 * citation/reference resolve and match → the flagged-issues list is empty.
 */
async function seedGroundedRecords(): Promise<Record<string, unknown>> {
  const suffix = randomBytes(5).toString("hex");
  const payerName = `Grounded Health Plan ${suffix}`;
  const patientName = `Grounded Patient ${suffix}`;
  const procedureCode = "27447";
  const diagnosisCode = "M17.11";
  const denialReason = "not medically necessary";

  const payer = await prisma.payer.create({ data: { name: payerName } });
  const patient = await prisma.patient.create({
    data: {
      name: patientName,
      dob: new Date("1980-01-01T00:00:00.000Z"),
      payerId: payer.id,
    },
  });
  await prisma.chartNote.create({
    data: {
      patientId: patient.id,
      noteDate: new Date("2025-01-01T00:00:00.000Z"),
      content: "Knee osteoarthritis; conservative therapy failed.",
      diagnosisCode,
    },
  });
  await prisma.payerPolicy.create({
    data: {
      payerId: payer.id,
      policyCode: `LCD ${suffix}`,
      procedureCode,
      criteriaText:
        "Total knee arthroplasty is covered when conservative therapy has failed.",
    },
  });

  const draft = (value: string) => ({
    value,
    confidence: 0.95,
    reasoning: "seeded verification-pass example",
  });
  return {
    patient: draft(patientName),
    payer: draft(payerName),
    procedureCode: draft(procedureCode),
    diagnosisCode: draft(diagnosisCode),
    denialReason: draft(denialReason),
  };
}

/** Read the stored Verification_Result after a run. */
async function readVerificationResult(
  caseId: string,
): Promise<VerificationResult | null> {
  const kase = await prisma.case.findUnique({
    where: { id: caseId },
    select: { verificationResult: true },
  });
  return (kase?.verificationResult as unknown as VerificationResult) ?? null;
}

/** Assert the pass/fail derivation biconditional on a stored result (Req 22.4). */
function assertPassFailDefinition(vr: VerificationResult): void {
  expect(["pass", "fail"]).toContain(vr.status);
  // status === "pass" ⟺ the flagged-issues list is empty.
  expect(vr.status === "pass").toBe(vr.flaggedIssues.length === 0);
  // Restated both directions for clarity / stronger failure messages:
  if (vr.flaggedIssues.length === 0) {
    expect(vr.status).toBe("pass");
  } else {
    // any non-empty flagged-issues list ⟹ "fail".
    expect(vr.status).toBe("fail");
  }
}

// ─── Generators ───────────────────────────────────────────────────────────────

/** Only the DRAFTING paths draft an appeal, so only they reach Verification_QA. */
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

// ─── Property 47 ────────────────────────────────────────────────────────────────

describe("runAgent — verification pass/fail definition (Task 11.20, Property 47)", () => {
  it(
    "stores status pass IFF the flagged-issues list is empty, else fail (Req 22.4)",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          draftingPathArb,
          intakeTypeArb,
          rawIntakeArb,
          fc.boolean(),
          fc.boolean(),
          async (path, intakeType, rawIntakeText, urgent, grounded) => {
            // Arrange: force a drafting decision; optionally ground the appeal so
            // the flagged-issues list comes out empty rather than non-empty.
            controller.intakeExtraction = grounded
              ? await seedGroundedRecords()
              : null;
            const caseId = await seedCase(intakeType, rawIntakeText, urgent);
            controller.decision = { path, status: "AwaitingApproval" };

            // Act: run the real pipeline end to end so Verification_QA derives and
            // persists the Verification_Result.
            const result = await runAgent(caseId);
            expect(result.resolutionPath).toBe(path);

            // Assert: a result was stored (Verification_QA ran on a drafting path),
            // and its status is the strict function of the flagged-issues list.
            const vr = await readVerificationResult(caseId);
            expect(vr).not.toBeNull();
            assertPassFailDefinition(vr!);
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});

// ─── Focused examples (deterministic, illustrative) ───────────────────────────

describe("verification pass/fail definition — representative examples", () => {
  it("an empty flagged-issues list yields status pass (grounded appeal)", async () => {
    controller.intakeExtraction = await seedGroundedRecords();
    const caseId = await seedCase("denial_letter", "grounded appeal", false);
    controller.decision = { path: "Auto_Draft", status: "AwaitingApproval" };

    await runAgent(caseId);
    controller.intakeExtraction = null;

    const vr = await readVerificationResult(caseId);
    expect(vr).not.toBeNull();
    expect(vr!.flaggedIssues).toHaveLength(0);
    expect(vr!.status).toBe("pass");
    assertPassFailDefinition(vr!);
  });

  it("a non-empty flagged-issues list yields status fail (ungrounded appeal)", async () => {
    controller.intakeExtraction = null;
    const caseId = await seedCase("new_pa_request", "ungrounded appeal", true);
    controller.decision = {
      path: "Draft_And_Request_Evidence",
      status: "AwaitingApproval",
    };

    await runAgent(caseId);

    const vr = await readVerificationResult(caseId);
    expect(vr).not.toBeNull();
    expect(vr!.flaggedIssues.length).toBeGreaterThan(0);
    expect(vr!.status).toBe("fail");
    assertPassFailDefinition(vr!);
  });
});
