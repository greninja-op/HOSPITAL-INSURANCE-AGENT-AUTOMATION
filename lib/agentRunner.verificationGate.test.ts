/**
 * lib/agentRunner.verificationGate.test.ts
 *
 * Property test (Task 11.21) — Property 48: Verification gates human approval.
 *
 * Feature: authpilot.
 *
 *   *For any* agent run, the Case is not presented for Human_Approval (does not
 *   enter the verified `AwaitingApproval` state) unless a Verification_Result
 *   has been stored on the Case. The Verification_QA stage (`lib/agentRunner.ts`)
 *   stores the Verification_Result on the Case BEFORE the run returns (the point
 *   at which the Case becomes eligible for Human_Approval), and a `fail` result
 *   is stored as `fail` so the appeal is never presented as verified.
 *
 * **Validates: Requirements 22.5**
 *
 * Interpretation (faithful to Requirement 22.5 / design Property 48): a Case is
 * "presented for Human_Approval" only after `runAgent` completes and the
 * dashboard surfaces the Case. Requirement 22.5 forbids that presentation until
 * a Verification_Result has been stored. So the observable gate is asserted at
 * run completion: on the drafting paths the Case reaches the approval-ready
 * `AwaitingApproval` state IFF a Verification_Result has been persisted on it,
 * and that persistence happens during the run (before it is presented). On the
 * escalation path there is no appeal, so Verification_QA is skipped, no result
 * is stored, and the Case is routed to `NeedsHumanInput` — never presented as a
 * verified, approval-ready appeal.
 *
 * Strategy (mirrors lib/agentRunner.appealConditional.test.ts): drive the REAL
 * `runAgent` pipeline end to end against an isolated, throwaway PostgreSQL schema
 * (`createTestDb`), replacing only the network / side-effecting seams with
 * deterministic fakes so the gate is exercised without the live Qwen model or
 * real PDF I/O:
 *
 *   • `./qwen`.callQwen — a FAKE that completes every stage on its first
 *     iteration (no network). It returns a controlled intake extraction when a
 *     sample provides one (used by the verification-PASS example), otherwise a
 *     benign `"{}"`.
 *   • `./decisionEngine`.decide — mocked to FORCE the sampled Resolution_Path
 *     (and its derived Case_Status), so the pipeline reaches Verification_QA on a
 *     known path. Every other export is preserved via `importActual`.
 *   • `./appealPdf`.generateAppealPdf — stubbed to return a fake url (no PDF is
 *     rendered or written).
 *
 * `prisma.case.update` is additionally instrumented per run to record the
 * ordering of writes, so the test can assert the Verification_Result write
 * occurs during the run and that no later write revokes the approval-ready
 * status. Uses Vitest + fast-check (numRuns 100), consistent with the suite.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type {
  CaseStatus,
  QwenOutcome,
  ResolutionPath,
  VerificationResult,
} from "./types";

// ─── Hoisted controller shared with the module mocks ──────────────────────────
//
// `vi.mock` factories are hoisted above imports, so the mutable state they close
// over must be created with `vi.hoisted`. Each sample sets `controller.decision`
// (the FORCED decision) and, for the PASS example, `controller.intakeExtraction`.
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

// FORCE the Resolution_Path so the pipeline reaches Verification_QA on a known
// path. Preserve `computeOverallConfidence` and everything else via importActual.
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

/** Ordered record of `Case.update` writes for the CURRENT run (gating/ordering). */
let updateLog: Array<{ hasVerificationResult: boolean; status?: string }> = [];

beforeAll(async () => {
  // Provision an isolated schema and bind its client as the shared singleton
  // BEFORE importing the runner, so `runAgent` and `createTraceStep` write to it.
  testDb = await createTestDb();
  prisma = testDb.prisma;
  process.env.DATABASE_URL = testDb.databaseUrl;
  (globalThis as unknown as { prisma?: PrismaClient }).prisma = prisma;

  // Instrument `Case.update` to record, in order, whether each update persisted
  // a Verification_Result and/or set a status. This lets the property observe
  // that the Verification_Result is stored during the run (before the Case is
  // presented for Human_Approval) and that no later write revokes approval-ready.
  const origUpdate = prisma.case.update.bind(prisma.case);
  (prisma.case as unknown as { update: unknown }).update = (
    args: { data?: Record<string, unknown> },
  ) => {
    const data = args?.data ?? {};
    updateLog.push({
      hasVerificationResult: Object.prototype.hasOwnProperty.call(
        data,
        "verificationResult",
      ),
      status: typeof data.status === "string" ? data.status : undefined,
    });
    return origUpdate(args as never);
  };

  const runner = await import("./agentRunner");
  runAgent = runner.runAgent;
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** The two Resolution_Paths that DRAFT an appeal → Verification_QA runs (Req 7.1, 22). */
const DRAFTING_PATHS: ReadonlySet<ResolutionPath> = new Set<ResolutionPath>([
  "Auto_Draft",
  "Draft_And_Request_Evidence",
]);

/** The Case_Status the Decision_Engine derives for a path (mirrors decisionEngine). */
function statusForPath(path: ResolutionPath): CaseStatus {
  return path === "Escalate_To_Human" ? "NeedsHumanInput" : "AwaitingApproval";
}

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

/** Read the gating-relevant Case state after a run. */
async function readCase(caseId: string) {
  return prisma.case.findUnique({
    where: { id: caseId },
    select: { status: true, verificationResult: true, appealPdfUrl: true },
  });
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

// ─── Property 48 ────────────────────────────────────────────────────────────────

describe("runAgent — verification gates human approval (Task 11.21, Property 48)", () => {
  it(
    "reaches the approval-ready state only with a stored Verification_Result (Req 22.5)",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          resolutionPathArb,
          intakeTypeArb,
          rawIntakeArb,
          fc.boolean(),
          async (path, intakeType, rawIntakeText, urgent) => {
            // Arrange: a fresh Case, the Decision_Engine forced to `path`, the
            // default (unseeded) intake so verification has nothing to ground to.
            const caseId = await seedCase(intakeType, rawIntakeText, urgent);
            controller.decision = { path, status: statusForPath(path) };
            controller.intakeExtraction = null;
            updateLog = [];

            // Act: run the real pipeline end to end.
            const result = await runAgent(caseId);
            expect(result.resolutionPath).toBe(path);

            const kase = await readCase(caseId);
            const isDrafting = DRAFTING_PATHS.has(path);

            if (isDrafting) {
              // (1) Verification_QA ran → a Verification_Result is stored (Req 22.4).
              expect(kase?.verificationResult).not.toBeNull();

              // (2) The Case reached the approval-ready state (Req 22.5): it is
              //     only now eligible for Human_Approval, WITH a stored result.
              expect(kase?.status).toBe("AwaitingApproval");

              // (3) The stored result is a valid pass/fail (Req 22.4); an
              //     unseeded run cannot ground its citations → fail, and a fail
              //     result carries its flagged issues so it is not presented as
              //     verified.
              const vr = kase!.verificationResult as unknown as VerificationResult;
              expect(["pass", "fail"]).toContain(vr.status);
              if (vr.status === "fail") {
                expect(vr.flaggedIssues.length).toBeGreaterThan(0);
              }

              // (4) Ordering/gate: the Verification_Result was persisted DURING
              //     the run (before the Case is presented for approval), and no
              //     later write revoked the approval-ready status.
              const vrIndex = updateLog.findIndex(
                (u) => u.hasVerificationResult,
              );
              expect(vrIndex).toBeGreaterThanOrEqual(0);
              for (const u of updateLog.slice(vrIndex + 1)) {
                if (u.status !== undefined) {
                  expect(u.status).toBe("AwaitingApproval");
                }
              }
            } else {
              // Escalate_To_Human: no appeal, so Verification_QA is skipped, no
              // result is stored, and the Case is routed to NeedsHumanInput —
              // never presented as a verified, approval-ready appeal (Req 22.5).
              expect(kase?.status).toBe("NeedsHumanInput");
              expect(kase?.verificationResult ?? null).toBeNull();
            }

            // Gating invariant (Property 48): whenever the Case is in the
            // verified approval-ready state, a Verification_Result exists.
            if (kase?.status === "AwaitingApproval") {
              expect(kase?.verificationResult).not.toBeNull();
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

describe("runAgent — verification gating (representative examples)", () => {
  it("a drafting run stores the Verification_Result before reaching AwaitingApproval", async () => {
    const caseId = await seedCase("denial_letter", "high-confidence denial", false);
    controller.decision = { path: "Auto_Draft", status: "AwaitingApproval" };
    controller.intakeExtraction = null;
    updateLog = [];

    await runAgent(caseId);

    const kase = await readCase(caseId);
    expect(kase?.verificationResult).not.toBeNull();
    expect(kase?.status).toBe("AwaitingApproval");
    // The Verification_Result write occurred (during the run, before presentation).
    expect(updateLog.some((u) => u.hasVerificationResult)).toBe(true);
  });

  it("an unseeded appeal fails verification and is stored as fail (not presented as verified)", async () => {
    const caseId = await seedCase("new_pa_request", "ungrounded appeal", true);
    controller.decision = {
      path: "Draft_And_Request_Evidence",
      status: "AwaitingApproval",
    };
    controller.intakeExtraction = null;
    updateLog = [];

    await runAgent(caseId);

    const kase = await readCase(caseId);
    expect(kase?.verificationResult).not.toBeNull();
    const vr = kase!.verificationResult as unknown as VerificationResult;
    expect(vr.status).toBe("fail");
    expect(vr.flaggedIssues.length).toBeGreaterThan(0);
    // The gate still holds: the fail result is stored before the Case is
    // presented for Human_Approval (with its flagged issues), so it is never
    // presented as a verified appeal.
    expect(kase?.status).toBe("AwaitingApproval");
  });

  it("a fully grounded appeal passes verification, with the result stored before approval", async () => {
    // Seed matching in-scope records so every Appeal_Packet citation/reference
    // resolves and matches → Verification_QA passes (Req 22.4, 22.8).
    const payer = await prisma.payer.create({ data: { name: "Acme Health Plan" } });
    const patient = await prisma.patient.create({
      data: {
        name: "Jane Q Grounded",
        dob: new Date("1980-01-01T00:00:00.000Z"),
        payerId: payer.id,
      },
    });
    await prisma.chartNote.create({
      data: {
        patientId: patient.id,
        noteDate: new Date("2025-01-01T00:00:00.000Z"),
        content: "Knee osteoarthritis; conservative therapy failed.",
        diagnosisCode: "M17.11",
      },
    });
    await prisma.payerPolicy.create({
      data: {
        payerId: payer.id,
        policyCode: "LCD L34567",
        procedureCode: "27447",
        criteriaText:
          "Total knee arthroplasty is covered when conservative therapy has failed.",
      },
    });

    const draft = (value: string) => ({
      value,
      confidence: 0.95,
      reasoning: "seeded verification-pass example",
    });
    controller.intakeExtraction = {
      patient: draft("Jane Q Grounded"),
      payer: draft("Acme Health Plan"),
      procedureCode: draft("27447"),
      diagnosisCode: draft("M17.11"),
      denialReason: draft("not medically necessary"),
    };

    const caseId = await seedCase(
      "denial_letter",
      "grounded appeal for Jane Q Grounded",
      false,
    );
    controller.decision = { path: "Auto_Draft", status: "AwaitingApproval" };
    updateLog = [];

    await runAgent(caseId);
    controller.intakeExtraction = null;

    const kase = await readCase(caseId);
    expect(kase?.verificationResult).not.toBeNull();
    const vr = kase!.verificationResult as unknown as VerificationResult;
    expect(vr.status).toBe("pass");
    expect(vr.flaggedIssues).toHaveLength(0);

    // Gate: the (passing) Verification_Result was persisted before the Case
    // reached the verified approval-ready state.
    expect(kase?.status).toBe("AwaitingApproval");
    const vrIndex = updateLog.findIndex((u) => u.hasVerificationResult);
    expect(vrIndex).toBeGreaterThanOrEqual(0);
    for (const u of updateLog.slice(vrIndex + 1)) {
      if (u.status !== undefined) expect(u.status).toBe("AwaitingApproval");
    }
  });

  it("escalation skips verification and never presents a verified appeal", async () => {
    const caseId = await seedCase("phone_note", "low-confidence escalation", false);
    controller.decision = { path: "Escalate_To_Human", status: "NeedsHumanInput" };
    controller.intakeExtraction = null;
    updateLog = [];

    await runAgent(caseId);

    const kase = await readCase(caseId);
    expect(kase?.status).toBe("NeedsHumanInput");
    expect(kase?.verificationResult ?? null).toBeNull();
    expect(kase?.appealPdfUrl ?? null).toBeNull();
  });
});
