/**
 * lib/agentRunner.verificationGating.test.ts
 *
 * Property test (Task 11.21) — Property 48: Verification gates human approval.
 *
 * Feature: authpilot.
 *
 * COMPLEMENTARY ANGLE to lib/agentRunner.verificationGate.test.ts.
 *
 *   The sibling file (`agentRunner.verificationGate.test.ts`) proves the gate by
 *   instrumenting `prisma.case.update` to inspect WRITE ORDERING, and its
 *   property loop only ever exercises the verification-FAIL branch (unseeded
 *   grounding), covering the PASS branch in a single focused example.
 *
 *   This file verifies the SAME requirement (22.5) from a DISTINCT, complementary
 *   angle that adds coverage the sibling does not:
 *
 *     (a) It observes the gate through the persisted AUDIT TRAIL — the single
 *         stage-labeled `verification` Trace_Step (Req 20.10) that the
 *         Verification_QA stage writes only when it has completed its checks —
 *         rather than by instrumenting `prisma.case.update`.
 *
 *     (b) It exercises BOTH the verification-PASS and verification-FAIL branches
 *         *inside the property itself* (a boolean generator toggles whether the
 *         Case's citations are grounded in freshly-seeded, matching in-scope
 *         records). This demonstrates the crucial nuance of Requirement 22.5:
 *         the approval gate is keyed on the Verification_Result having been
 *         COMPLETED and STORED — NOT on it having *passed*. A drafting Case
 *         reaches the approval-ready state whether verification passes or fails,
 *         and in BOTH cases it does so only with a stored result and a completed
 *         verification trace step. A failing verification is stored as `fail`
 *         (carrying its flagged issues, Req 22.6) so the appeal is never
 *         surfaced as *verified*.
 *
 * **Validates: Requirements 22.5**
 *
 * Interpretation (faithful to Requirement 22.5 / design Property 48): "THE
 * AuthPilot SHALL NOT present a Case for Human_Approval until the Verification_QA
 * stage has completed and its Verification_Result has been stored on the Case."
 * A Case is "presented for Human_Approval" once `runAgent` completes and the
 * dashboard surfaces it in the AwaitingApproval column. So the observable gate is
 * asserted at run completion: whenever a drafting-path Case is approval-ready
 * (AwaitingApproval) there MUST exist both (1) a stored Verification_Result and
 * (2) a completed `verification` Trace_Step whose recorded status equals the
 * stored result's status. The escalation path drafts no appeal, so
 * Verification_QA is skipped and the Case is routed to NeedsHumanInput — never
 * presented as a verified, approval-ready appeal.
 *
 * Strategy (mirrors the sibling file's deterministic seams): drive the REAL
 * `runAgent` pipeline end to end against an isolated, throwaway PostgreSQL schema
 * (`createTestDb`), replacing only the network / side-effecting seams with
 * deterministic fakes — `./qwen`.callQwen (completes every stage in one
 * iteration; emits a controlled intake extraction for the grounded/PASS branch),
 * `./decisionEngine`.decide (forces the sampled Resolution_Path), and
 * `./appealPdf`.generateAppealPdf (returns a fake url). Uses Vitest + fast-check
 * (numRuns 100), consistent with the suite.
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
// (the FORCED decision) and, for the grounded/PASS branch, `intakeExtraction`.
const controller = vi.hoisted(() => ({
  /** The decision the mocked `decide` returns for the current sample. */
  decision: null as { path: string; status: string } | null,
  /** Controlled intake extraction (grounded/PASS branch); else the fake returns "{}". */
  intakeExtraction: null as Record<string, unknown> | null,
}));

// FAKE Qwen: every stage completes immediately (no tool calls). "{}" is valid
// JSON so JSON-parsing stages degrade to their empty/fallback shapes and prose
// stages use it as assessment text. When a sample supplies
// `controller.intakeExtraction`, the Intake stage receives that exact five-field
// extraction (routed by the stage's system prompt).
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

/**
 * Seed matching in-scope records (Payer + Patient + Chart_Note + Payer_Policy)
 * and return the controlled five-field intake extraction that cites them, so the
 * generated Appeal_Packet's citations/references all resolve and match →
 * Verification_QA PASSES (Req 22.4, 22.8). Names carry a unique token so intake
 * entity-resolution links to THESE freshly-seeded rows on every iteration.
 */
async function seedGrounded(token: string): Promise<Record<string, unknown>> {
  const payerName = `Acme Health Plan ${token}`;
  const patientName = `Jane Q Grounded ${token}`;
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
    reasoning: "seeded verification-pass grounding",
  });
  return {
    patient: draft(patientName),
    payer: draft(payerName),
    procedureCode: draft("27447"),
    diagnosisCode: draft("M17.11"),
    denialReason: draft("not medically necessary"),
  };
}

/** Read the gating-relevant Case state after a run. */
async function readCase(caseId: string) {
  return prisma.case.findUnique({
    where: { id: caseId },
    select: { status: true, verificationResult: true, appealPdfUrl: true },
  });
}

/**
 * The single stage-labeled `verification` Trace_Step (Req 20.10), if any — the
 * audit-trail witness that the Verification_QA stage COMPLETED. Returns its
 * recorded status ("pass" | "fail" | undefined for a skip) or `null` if absent.
 */
async function verificationTrace(
  caseId: string,
): Promise<{ present: boolean; status?: string; skipped?: boolean }> {
  const step = await prisma.traceStep.findFirst({
    where: { caseId, stepType: "verification" },
    orderBy: { timestamp: "desc" },
    select: { output: true },
  });
  if (!step) return { present: false };
  const output = (step.output ?? {}) as {
    status?: string;
    skipped?: boolean;
  };
  return { present: true, status: output.status, skipped: output.skipped };
}

// ─── Generators ───────────────────────────────────────────────────────────────

/** Both drafting paths reach Verification_QA; escalation skips it (negative case). */
const pathArb: fc.Arbitrary<ResolutionPath> = fc.constantFrom(
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

// ─── Property 48 (complementary: audit-trail gate across PASS and FAIL) ─────────

describe("runAgent — verification gate holds across pass AND fail (Task 11.21, Property 48)", () => {
  it(
    "approval-readiness requires a stored result and a completed verification trace step, regardless of pass/fail (Req 22.5)",
    async () => {
      let counter = 0;
      await fc.assert(
        fc.asyncProperty(
          pathArb,
          fc.boolean(),
          intakeTypeArb,
          rawIntakeArb,
          fc.boolean(),
          async (path, grounded, intakeType, rawIntakeText, urgent) => {
            const isDrafting = DRAFTING_PATHS.has(path);
            // Ground the citations (→ verification PASS) only on drafting paths
            // when the sample asks for it; otherwise leave unseeded (→ FAIL).
            const wantGrounded = isDrafting && grounded;
            controller.intakeExtraction = wantGrounded
              ? await seedGrounded(`t${counter++}_${Date.now().toString(36)}`)
              : null;

            const caseId = await seedCase(intakeType, rawIntakeText, urgent);
            controller.decision = { path, status: statusForPath(path) };

            // Act: run the real pipeline end to end.
            const result = await runAgent(caseId);
            expect(result.resolutionPath).toBe(path);

            const kase = await readCase(caseId);
            const trace = await verificationTrace(caseId);

            if (isDrafting) {
              // The Case is approval-ready ONLY WITH a stored Verification_Result
              // AND a completed verification stage (its trace step) — Req 22.5.
              expect(kase?.status).toBe("AwaitingApproval");
              expect(kase?.verificationResult).not.toBeNull();
              expect(trace.present).toBe(true);
              expect(trace.skipped ?? false).toBe(false);

              const vr =
                kase!.verificationResult as unknown as VerificationResult;
              expect(["pass", "fail"]).toContain(vr.status);

              // The gate is COMPLETION/STORAGE, not the pass verdict: the stored
              // result's status equals the audit-trail status, and BOTH branches
              // reach approval-readiness. Grounded → pass; ungrounded → fail.
              expect(trace.status).toBe(vr.status);
              expect(vr.status).toBe(wantGrounded ? "pass" : "fail");

              // A failing verification is stored WITH its flagged issues so the
              // appeal is never surfaced as *verified* (Req 22.6, 22.9).
              if (vr.status === "fail") {
                expect(vr.flaggedIssues.length).toBeGreaterThan(0);
              } else {
                expect(vr.flaggedIssues).toHaveLength(0);
              }
            } else {
              // Escalation: no appeal, so Verification_QA is skipped, no result
              // is stored, and the Case is routed to NeedsHumanInput — never
              // presented as a verified, approval-ready appeal (Req 22.5).
              expect(kase?.status).toBe("NeedsHumanInput");
              expect(kase?.verificationResult ?? null).toBeNull();
              // No completed (non-skip) verification trace step exists.
              expect(trace.status ?? undefined).toBeUndefined();
            }

            // Contrapositive gate (Property 48): whenever a Case is in the
            // verified approval-ready state, a stored Verification_Result AND a
            // completed verification trace step both exist.
            if (kase?.status === "AwaitingApproval") {
              expect(kase?.verificationResult).not.toBeNull();
              expect(trace.present && trace.skipped !== true).toBe(true);
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

describe("runAgent — verification gating across outcomes (representative examples)", () => {
  it("a grounded drafting run PASSES verification and is approval-ready with a stored pass result + trace", async () => {
    const extraction = await seedGrounded(`pass_${Date.now().toString(36)}`);
    controller.intakeExtraction = extraction;
    const caseId = await seedCase("denial_letter", "grounded appeal", false);
    controller.decision = { path: "Auto_Draft", status: "AwaitingApproval" };

    await runAgent(caseId);
    controller.intakeExtraction = null;

    const kase = await readCase(caseId);
    const trace = await verificationTrace(caseId);
    const vr = kase!.verificationResult as unknown as VerificationResult;

    expect(kase?.status).toBe("AwaitingApproval");
    expect(vr.status).toBe("pass");
    expect(vr.flaggedIssues).toHaveLength(0);
    expect(trace.present).toBe(true);
    expect(trace.status).toBe("pass");
  });

  it("an ungrounded drafting run FAILS verification yet is still gated: stored fail result + completed trace before approval", async () => {
    controller.intakeExtraction = null;
    const caseId = await seedCase("new_pa_request", "ungrounded appeal", true);
    controller.decision = {
      path: "Draft_And_Request_Evidence",
      status: "AwaitingApproval",
    };

    await runAgent(caseId);

    const kase = await readCase(caseId);
    const trace = await verificationTrace(caseId);
    const vr = kase!.verificationResult as unknown as VerificationResult;

    // The gate is keyed on completion+storage, not the pass verdict: a FAIL
    // still reaches AwaitingApproval, but only with a stored result carrying its
    // flagged issues (so it is not presented as verified) + a completed trace.
    expect(kase?.status).toBe("AwaitingApproval");
    expect(vr.status).toBe("fail");
    expect(vr.flaggedIssues.length).toBeGreaterThan(0);
    expect(trace.present).toBe(true);
    expect(trace.status).toBe("fail");
  });

  it("escalation skips verification: no stored result, no completed verification trace, never approval-ready", async () => {
    controller.intakeExtraction = null;
    const caseId = await seedCase("phone_note", "low-confidence escalation", false);
    controller.decision = {
      path: "Escalate_To_Human",
      status: "NeedsHumanInput",
    };

    await runAgent(caseId);

    const kase = await readCase(caseId);
    const trace = await verificationTrace(caseId);

    expect(kase?.status).toBe("NeedsHumanInput");
    expect(kase?.verificationResult ?? null).toBeNull();
    expect(kase?.appealPdfUrl ?? null).toBeNull();
    // Either no verification trace at all, or a skip trace — never a completed one.
    expect(trace.status ?? undefined).toBeUndefined();
  });
});
