/**
 * lib/agentRunner.verificationPassFail.test.ts
 *
 * Property test (Task 11.20): the verification pass/fail definition.
 *
 * Feature: authpilot, Property 47: Verification pass/fail definition.
 *
 *   For ANY flagged-issues list, the stored Verification_Result has status
 *   "pass" if and only if the list is empty, and "fail" otherwise, and it
 *   carries the complete flagged-issues list unchanged. The Verification_QA
 *   stage (`lib/agentRunner.ts`) derives `verificationResult.status` as `pass`
 *   iff the flagged-issues list is empty, else `fail`.
 *
 * **Validates: Requirements 22.4**
 *
 * Strategy: the pass/fail derivation is inline in the Verification_QA stage body
 * (no exported pure helper), so this drives the REAL `runAgent` pipeline end to
 * end against an isolated, throwaway PostgreSQL schema (via `createTestDb`) and
 * observes the persisted `Case.verificationResult`. Only the network /
 * side-effecting seams are replaced with deterministic fakes so verification is
 * exercised without the live Qwen model or real PDF I/O:
 *
 *   • `./qwen`.callQwen is a STAGE-AWARE fake: for Intake_And_Extraction it
 *     returns a JSON five-field extraction whose values are set per property
 *     sample (this is the only lever that steers entity resolution, and thus
 *     whether the drafted appeal's citations/references resolve); every other
 *     Qwen-calling stage receives a benign completing answer.
 *   • `./decisionEngine`.decide is forced to `Auto_Draft` so the pipeline always
 *     reaches Appeal_Generation + Verification_QA with an Appeal_Packet to
 *     verify (verification only runs on a drafting path). Every other
 *     decisionEngine export (e.g. `computeOverallConfidence`) is preserved.
 *   • `./appealPdf`.generateAppealPdf is stubbed to a hermetic fake returning a
 *     non-empty location reference WITHOUT touching the filesystem.
 *
 * Shared reference data (one Payer + PayerPolicy, one Patient + ChartNote) is
 * seeded once; each property sample only creates a fresh Case and picks the
 * intake extraction values, steering verification into one of four scenarios:
 * a fully-consistent CLEAN pass (0 issues) and three defect variants that each
 * force one or more flagged issues (a fail). For every sample the biconditional
 * `status === "pass" ⟺ flaggedIssues.length === 0` is asserted on the persisted
 * Verification_Result, exercising both branches of the definition.
 *
 * Uses Vitest + fast-check (numRuns 100), consistent with the rest of the suite.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type { AppealContent, QwenOutcome, VerificationResult } from "./types";

// ─── Canonical consistent values (the CLEAN pass scenario resolves to these) ──
const PATIENT_NAME = "Jane Roe";
const PAYER_NAME = "Acme Health";
const PROCEDURE_CODE = "70551";
const DIAGNOSIS_CODE = "M54.5";
const DENIAL_REASON = "not medically necessary";

// ─── Hoisted controller shared with the module mocks ──────────────────────────
//
// `vi.mock` factories are hoisted above imports, so the mutable state they close
// over must be created with `vi.hoisted`. Each property sample sets
// `controller.intake` to the extraction values for that run BEFORE invoking
// `runAgent`; `controller.appealCalls` records the caseIds the stubbed
// generateAppealPdf was asked to render.
const controller = vi.hoisted(() => ({
  intake: {
    patient: "Jane Roe",
    payer: "Acme Health",
    procedureCode: "70551",
    diagnosisCode: "M54.5",
    denialReason: "not medically necessary",
  },
  appealCalls: [] as string[],
}));

// STAGE-AWARE fake Qwen: route by the stage's system prompt (messages[0]).
// Intake gets a JSON five-field extraction at the sampled values; every other
// stage gets a benign final answer (no tool calls) so it completes on iter 1.
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
        const field = (value: string) => ({
          value,
          confidence: 0.9,
          reasoning: "fake intake extraction for the pass/fail definition test",
        });
        const extraction = {
          patient: field(c.intake.patient),
          payer: field(c.intake.payer),
          procedureCode: field(c.intake.procedureCode),
          diagnosisCode: field(c.intake.diagnosisCode),
          denialReason: field(c.intake.denialReason),
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

// FORCE a drafting path so the pipeline always reaches Verification_QA with an
// Appeal_Packet to verify. Preserve every other `./decisionEngine` export.
vi.mock("./decisionEngine", async (importActual) => {
  const actual = await importActual<typeof import("./decisionEngine")>();
  return {
    ...actual,
    decide: () => ({ path: "Auto_Draft", status: "AwaitingApproval" }),
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

beforeAll(async () => {
  // Provision an isolated schema and bind the shared Prisma client to it BEFORE
  // importing the runner, so `lib/db.ts` and the runner write to the test schema.
  testDb = await createTestDb();
  process.env.DATABASE_URL = testDb.databaseUrl;

  const runner = await import("./agentRunner");
  runAgent = runner.runAgent;

  const db = await import("./db");
  prisma = db.prisma;

  // Seed the ONE canonical Payer + PayerPolicy and Patient + ChartNote the
  // CLEAN pass scenario resolves against. Entity resolution in the Intake stage
  // links a Case to these by (case-insensitive) NAME match, so the sampled
  // intake values decide whether each citation/reference resolves.
  const payer = await prisma.payer.create({ data: { name: PAYER_NAME } });
  await prisma.payerPolicy.create({
    data: {
      payerId: payer.id,
      policyCode: "LCD L34567",
      procedureCode: PROCEDURE_CODE,
      criteriaText:
        "Documented conservative therapy for at least six weeks is required before the procedure is considered medically necessary.",
    },
  });
  const patient = await prisma.patient.create({
    data: { name: PATIENT_NAME, dob: new Date("1980-01-01T00:00:00.000Z"), payerId: payer.id },
  });
  await prisma.chartNote.create({
    data: {
      patientId: patient.id,
      noteDate: new Date("2024-01-15T00:00:00.000Z"),
      content: "Patient reports persistent low-back pain unresponsive to conservative therapy.",
      diagnosisCode: DIAGNOSIS_CODE,
    },
  });
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

// ─── Scenario generators ──────────────────────────────────────────────────────
//
// Each scenario fixes the five intake extraction values and the expected
// pass/fail outcome. The CLEAN scenario resolves every citation/reference and
// matches every Extracted_Field, yielding 0 flagged issues (pass). Each defect
// variant perturbs exactly one lever so verification flags one or more issues
// (fail), covering distinct flagged-issue shapes.

interface Scenario {
  label: string;
  expectPass: boolean;
  intake: {
    patient: string;
    payer: string;
    procedureCode: string;
    diagnosisCode: string;
    denialReason: string;
  };
}

const cleanIntake = {
  patient: PATIENT_NAME,
  payer: PAYER_NAME,
  procedureCode: PROCEDURE_CODE,
  diagnosisCode: DIAGNOSIS_CODE,
  denialReason: DENIAL_REASON,
};

const scenarioArb: fc.Arbitrary<Scenario> = fc.constantFrom<Scenario>(
  // CLEAN — everything resolves and matches → 0 issues → pass.
  { label: "clean", expectPass: true, intake: { ...cleanIntake } },
  // Payer does not resolve → the payer-policy citation is unresolved → fail.
  {
    label: "unlinked-payer",
    expectPass: false,
    intake: { ...cleanIntake, payer: "Nonexistent Payer LLC" },
  },
  // Patient does not resolve → the patient reference is unresolved → fail.
  {
    label: "unlinked-patient",
    expectPass: false,
    intake: { ...cleanIntake, patient: "Ghost Patient" },
  },
  // Diagnosis code does not match any chart note → reference mismatch → fail.
  {
    label: "diagnosis-mismatch",
    expectPass: false,
    intake: { ...cleanIntake, diagnosisCode: "Z88.8" },
  },
);

const intakeTypeArb = fc.constantFrom(
  "denial_letter",
  "new_pa_request",
  "phone_note",
  "whatsapp_patient_note",
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

/** Read the persisted Verification_Result off the Case (Req 23.2). */
async function readVerificationResult(
  caseId: string,
): Promise<VerificationResult | null> {
  const kase = await prisma.case.findUnique({
    where: { id: caseId },
    select: { verificationResult: true },
  });
  return (kase?.verificationResult as unknown as VerificationResult | null) ?? null;
}

// ─── Property 47 ────────────────────────────────────────────────────────────────

describe("runAgent — verification pass/fail definition (Task 11.20, Property 47)", () => {
  // **Validates: Requirements 22.4**
  it(
    "stores a Verification_Result whose status is pass iff the flagged-issues list is empty, else fail, carrying the complete list",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          scenarioArb,
          intakeTypeArb,
          async (scenario, intakeType) => {
            // Arrange: a fresh Case; the sampled intake values steer resolution.
            const caseId = await seedCase(intakeType);
            controller.intake = { ...scenario.intake };
            controller.appealCalls = [];

            // Act: run the real pipeline end to end (Auto_Draft → an appeal is
            // drafted → Verification_QA verifies it and stores the result).
            await runAgent(caseId);

            // An Appeal_Packet was generated, so Verification_QA ran and MUST
            // have stored a Verification_Result on the Case (Req 22.5, 23.2).
            expect(controller.appealCalls).toContain(caseId);
            const result = await readVerificationResult(caseId);
            expect(result).not.toBeNull();

            const flagged = result!.flaggedIssues;
            expect(Array.isArray(flagged)).toBe(true);

            // (1) THE definition (Req 22.4): status is "pass" iff the list is
            //     empty, "fail" otherwise — the exact biconditional, both ways.
            expect(result!.status === "pass").toBe(flagged.length === 0);
            expect(result!.status === "fail").toBe(flagged.length > 0);
            expect(result!.status).toBe(flagged.length === 0 ? "pass" : "fail");

            // (2) Both branches are genuinely exercised: the sampled scenario
            //     steered the run into the expected pass/fail outcome.
            expect(result!.status).toBe(scenario.expectPass ? "pass" : "fail");
            if (scenario.expectPass) {
              expect(flagged.length).toBe(0);
            } else {
              expect(flagged.length).toBeGreaterThan(0);
            }

            // (3) The stored list is a complete, well-formed flagged-issues list
            //     (each issue carries its type/reference/detail/severity).
            for (const issue of flagged) {
              expect(typeof issue.type).toBe("string");
              expect(typeof issue.reference).toBe("string");
              expect(typeof issue.detail).toBe("string");
              expect(["warning", "blocking"]).toContain(issue.severity);
            }
          },
        ),
        FC_CONFIG,
      );
    },
    600_000,
  );
});

// ─── Focused examples (deterministic, illustrative) ───────────────────────────

describe("runAgent — verification pass/fail definition (representative examples)", () => {
  it("a fully-consistent appeal verifies with status pass and an empty flagged-issues list", async () => {
    const caseId = await seedCase("denial_letter");
    controller.intake = { ...cleanIntake };
    controller.appealCalls = [];

    await runAgent(caseId);

    const result = await readVerificationResult(caseId);
    expect(result?.status).toBe("pass");
    expect(result?.flaggedIssues).toEqual([]);
  });

  it("an appeal citing an unresolved payer policy verifies with status fail and at least one flagged issue", async () => {
    const caseId = await seedCase("new_pa_request");
    controller.intake = { ...cleanIntake, payer: "Nonexistent Payer LLC" };
    controller.appealCalls = [];

    await runAgent(caseId);

    const result = await readVerificationResult(caseId);
    expect(result?.status).toBe("fail");
    expect((result?.flaggedIssues.length ?? 0)).toBeGreaterThan(0);
  });

  it("an appeal referencing an unlinked patient verifies with status fail", async () => {
    const caseId = await seedCase("phone_note");
    controller.intake = { ...cleanIntake, patient: "Ghost Patient" };
    controller.appealCalls = [];

    await runAgent(caseId);

    const result = await readVerificationResult(caseId);
    expect(result?.status).toBe("fail");
    expect((result?.flaggedIssues.length ?? 0)).toBeGreaterThan(0);
  });
});
