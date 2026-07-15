// =============================================================================
// lib/agentRunner.grounding.test.ts
//
// Property 58: Unresolved citations force a blocking verification fail.
//
// **Validates: Requirements 22.8, 22.9**
//
// The Verification_QA grounding check (`lib/agentRunner.ts`) requires that EVERY
// citation / reference in the drafted Appeal_Packet — the payer-policy clause,
// the chart-note / diagnosis-code evidence, and the patient — resolve to an
// actual stored record IN SCOPE for the Case (Req 22.8). For each citation that
// does NOT resolve, the stage adds a blocking `unresolved_citation` flagged
// issue and forces the Verification_Result status to "fail" (Req 22.9).
//
// Property: after running the real pipeline, the set of `unresolved_citation`
// blocking issues is EXACTLY the set of citations that fail to resolve to an
// in-scope stored record (and none is added for those that DO resolve), and any
// unresolved reference forces status "fail". A fully-grounded packet flags
// nothing and passes.
//
// Strategy of this test (mirrors lib/agentRunner.verificationDiscrepancies.test.ts):
//   • Drive the REAL `runAgent` pipeline end to end against an isolated,
//     throwaway PostgreSQL schema (`createTestDb`), replacing only the two
//     non-deterministic seams — the Qwen_Client (`./qwen`.callQwen, routed by
//     the stage's system prompt to fixed deterministic outputs) and the PDF
//     renderer (`./appealPdf`.generateAppealPdf, stubbed to a bare URL). The
//     Decision / Verification stages make no model call, so routing and the
//     independent grounding checks run for real.
//   • The intake mock resolves all five fields at high confidence and produces
//     NO blocking findings, so the deterministic Decision_Engine routes to
//     Auto_Draft (95 > 85) — a drafting path — and the appeal is generated, so
//     Verification_QA actually runs (Req 22.5). Entity linkage does NOT change
//     the field confidences, so we can independently withhold in-scope records
//     to force unresolved citations while still reaching Verification_QA.
//   • We control three INDEPENDENT grounding dimensions, each governing one
//     `unresolved_citation` source in the grounding check:
//       - patientInScope : seed a Patient whose name matches the extracted
//         patient (so Case.patientId links and the patient citation resolves),
//         or withhold it (→ patient `unresolved_citation`, Req 22.9).
//       - policyInScope  : seed a Payer matching the extracted payer name plus a
//         PayerPolicy for the procedure code (so the payer-policy citation
//         resolves), or withhold it (→ payer-policy `unresolved_citation`).
//       - chartInScope   : when the patient IS in scope, seed a chart note whose
//         diagnosis code matches the extracted code (so the diagnosis citation
//         resolves), or withhold all chart notes (→ diagnosis `unresolved_citation`).
//   • After each run we read back the persisted `Case.verificationResult`
//     (Req 23.2) and assert the `unresolved_citation` set is EXACTLY the set of
//     withheld records, each is "blocking", any unresolved reference forces
//     status "fail", and a fully-grounded packet flags nothing and passes.
//
// The test uses NO live model and NO real network. Persistence uses an isolated,
// throwaway PostgreSQL schema bound as the shared `globalThis.prisma` BEFORE
// importing the runner, so `runAgent` and its writes land in the disposable
// schema.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type { FlaggedIssue, VerificationResult } from "./types";

// ─── Fixed, deterministic intake facts (the values the intake mock resolves) ──
//
// The patient + payer NAMES carry a per-run unique token so each run links to
// (or withholds) its OWN seeded records (Intake links by exact, case-insensitive
// name). Codes / denial are fixed.

const PROCEDURE_CODE = "27447";
const DIAGNOSIS_CODE = "M17.11";
const DENIAL_REASON = "Not medically necessary per policy criteria.";

// Fixed, single-line stage assessments so the reconstructed Appeal_Packet
// content is deterministic across runs.
const MEDICAL_SUMMARY =
  "Chart supports medical necessity: documented failed conservative therapy over three months.";
const POLICY_SUMMARY =
  "Payer criteria require documented conservative therapy before approving the procedure.";
const STRATEGY_JSON = JSON.stringify({
  options: [
    {
      approach: "Peer-to-peer review citing documented conservative therapy",
      winProbability: 80,
      rationale: "The chart evidence directly satisfies the cited payer criteria.",
    },
  ],
  payerTrackRecordSummary:
    "This payer has historically overturned similar denials on peer-to-peer review.",
});

// ─── Per-run controller shared with the hoisted Qwen mock ─────────────────────
//
// `vi.mock` factories are hoisted above imports, so the mutable handle they
// close over must be created with `vi.hoisted`. Each property sample sets the
// per-run patient/payer names before invoking `runAgent`.

const hoisted = vi.hoisted(() => ({
  patientName: "Jane Doe",
  payerName: "Acme Health Plan",
}));

// FAKE Qwen: route by the stage's system prompt to fixed, deterministic outputs.
// Every other `./qwen` export is preserved so unrelated importers are unaffected.
vi.mock("./qwen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./qwen")>();

  const success = (content: string) =>
    ({ ok: true as const, toolCalls: [], content });

  return {
    ...actual,
    callQwen: async (
      messages: import("./qwen").ChatMessage[],
    ): Promise<import("./types").QwenOutcome> => {
      const sys =
        typeof messages[0]?.content === "string" ? messages[0].content : "";

      // Intake_And_Extraction — resolve all five fields with high confidence so
      // the Decision_Engine routes to a drafting path (Auto_Draft).
      if (sys.includes("the Intake_And_Extraction stage")) {
        return success(
          JSON.stringify({
            patient: { value: hoisted.patientName, confidence: 0.95, reasoning: "seed" },
            payer: { value: hoisted.payerName, confidence: 0.95, reasoning: "seed" },
            procedureCode: { value: PROCEDURE_CODE, confidence: 0.95, reasoning: "seed" },
            diagnosisCode: { value: DIAGNOSIS_CODE, confidence: 0.95, reasoning: "seed" },
            denialReason: { value: DENIAL_REASON, confidence: 0.95, reasoning: "seed" },
          }),
        );
      }
      if (sys.includes("the Medical_Review stage")) {
        return success(MEDICAL_SUMMARY);
      }
      if (sys.includes("the Policy_Review stage")) {
        return success(POLICY_SUMMARY);
      }
      if (sys.includes("the Strategy stage")) {
        return success(STRATEGY_JSON);
      }
      // Decision / Appeal / Verification make no model call; nothing else should
      // reach the client, but return a benign success if it does.
      return success("{}");
    },
  };
});

// STUB the PDF renderer so a drafting path never writes a real file (and so
// Verification_QA sees a set Case.appealPdfUrl and actually runs).
vi.mock("./appealPdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./appealPdf")>();
  return {
    ...actual,
    generateAppealPdf: async (caseId: string): Promise<{ url: string }> => ({
      url: `stub://appeal-${caseId}.pdf`,
    }),
  };
});

// ─── Test-DB wiring (bound before importing the runner) ───────────────────────

type GlobalWithPrisma = { prisma?: PrismaClient };
type RunnerModule = typeof import("./agentRunner");

let testDb: TestDb;
let prisma: PrismaClient;
let runner: RunnerModule;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  // Bind the isolated schema's client as the shared singleton BEFORE importing
  // the runner, so `runAgent` and its persistence hit it.
  process.env.DATABASE_URL = testDb.databaseUrl;
  (globalThis as unknown as GlobalWithPrisma).prisma = prisma;

  runner = await import("./agentRunner");
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

// A monotonic per-run token keeps each sample's Patient/Payer names unique so
// linkage is scoped to THIS run's records (the shared schema is not reset per run).
let runSeq = 0;

/** The three independent grounding dimensions the scenario controls. */
interface Scenario {
  /** Seed a Patient matching the extracted name (patient citation resolves)? */
  patientInScope: boolean;
  /** Seed a matching Payer + PayerPolicy (payer-policy citation resolves)? */
  policyInScope: boolean;
  /** When the patient IS in scope, seed a matching chart note (diagnosis resolves)? */
  chartInScope: boolean;
}

/**
 * Seed a Case whose in-scope stored records are shaped by the scenario, so each
 * grounding dimension independently governs whether its Appeal_Packet citation
 * resolves. Returns the Case id.
 *
 * Linkage is by exact, case-insensitive NAME match performed during Intake:
 *   • a Patient named `hoisted.patientName` links Case.patientId (patient in scope),
 *   • a Payer named `hoisted.payerName` links Case.payerId; a PayerPolicy for the
 *     procedure code then lets the payer-policy citation resolve.
 * A patient requires a backing Payer FK, so we give it a DISTINCT (non-matching)
 * payer name that never affects Case.payerId linkage — keeping the patient and
 * payer-policy dimensions fully independent.
 */
async function seedScenario(scn: Scenario): Promise<string> {
  const token = `${Date.now().toString(36)}-${(runSeq += 1)}`;
  hoisted.patientName = `Jane Doe ${token}`;
  hoisted.payerName = `Acme Health Plan ${token}`;

  // Payer-policy grounding: seed the matched Payer + a PayerPolicy for the
  // procedure code ONLY when the payer-policy citation should resolve.
  if (scn.policyInScope) {
    const matchedPayer = await prisma.payer.create({
      data: { name: hoisted.payerName },
    });
    await prisma.payerPolicy.create({
      data: {
        payerId: matchedPayer.id,
        policyCode: "LCD L34567",
        procedureCode: PROCEDURE_CODE,
        criteriaText:
          "Approve when three months of documented conservative therapy have failed.",
      },
    });
  }

  // Patient grounding: seed a Patient with the matching name ONLY when the
  // patient citation should resolve. Its backing Payer uses a NON-matching name.
  if (scn.patientInScope) {
    const backingPayer = await prisma.payer.create({
      data: { name: `Backing Payer ${token}` },
    });
    const patient = await prisma.patient.create({
      data: {
        name: hoisted.patientName,
        dob: new Date("1980-05-01T00:00:00.000Z"),
        payerId: backingPayer.id,
      },
    });

    // Diagnosis grounding: seed a chart note whose diagnosis code matches the
    // extracted code ONLY when the diagnosis citation should resolve; otherwise
    // withhold all chart notes so the diagnosis code resolves to no Chart_Note.
    if (scn.chartInScope) {
      await prisma.chartNote.create({
        data: {
          patientId: patient.id,
          noteDate: new Date("2025-11-01T00:00:00.000Z"),
          content: "Documented failed conservative therapy; symptoms persist.",
          diagnosisCode: DIAGNOSIS_CODE,
        },
      });
    }
  }

  const kase = await prisma.case.create({
    data: {
      intakeType: "denial_letter",
      rawIntakeText: "seed intake for citation-grounding property test",
      status: "New",
      slaDeadline: new Date("2026-01-15T12:00:00.000Z"),
    },
  });
  return kase.id;
}

/** Grounding "slots" — the three citations the grounding check can flag unresolved. */
type Slot = "patient" | "policy" | "diagnosis";

/** The unresolved-citation slots the scenario's withheld records MUST produce. */
function expectedUnresolvedSlots(scn: Scenario): Slot[] {
  const slots: Slot[] = [];
  // Req 22.9 — the patient citation must resolve to a stored Patient in scope.
  if (!scn.patientInScope) slots.push("patient");
  // Req 22.9 — the payer-policy citation must resolve to a stored Payer_Policy.
  if (!scn.policyInScope) slots.push("policy");
  // Req 22.9 — the diagnosis code must resolve to a Chart_Note (only reachable
  // when the patient resolved; otherwise the patient issue subsumes it).
  if (scn.patientInScope && !scn.chartInScope) slots.push("diagnosis");
  return slots.sort();
}

/** Classify an `unresolved_citation` issue into its grounding slot by its detail. */
function classifyUnresolved(issue: FlaggedIssue): Slot | "unknown" {
  const detail = issue.detail;
  if (detail.includes("stored patient record")) return "patient";
  if (detail.includes("Payer_Policy record")) return "policy";
  if (detail.includes("Chart_Note record")) return "diagnosis";
  return "unknown";
}

describe("Property 58: unresolved citations force a blocking verification fail (Req 22.8, 22.9)", () => {
  it(
    "flags an unresolved_citation for EXACTLY the citations that don't resolve, each blocking, forcing status fail",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            patientInScope: fc.boolean(),
            policyInScope: fc.boolean(),
            chartInScope: fc.boolean(),
          }),
          async (scn: Scenario) => {
            const caseId = await seedScenario(scn);

            await runner.runAgent(caseId);

            // Read back the persisted Verification_Result (Req 23.2).
            const kase = await prisma.case.findUnique({
              where: { id: caseId },
              select: { verificationResult: true, resolutionPath: true },
            });

            // Sanity: the pipeline took a drafting path so verification ran.
            expect(kase?.resolutionPath).toBe("Auto_Draft");

            const result =
              kase?.verificationResult as unknown as VerificationResult | null;
            expect(result).not.toBeNull();
            expect(Array.isArray(result?.flaggedIssues)).toBe(true);

            const issues = (result as VerificationResult).flaggedIssues;
            const unresolved = issues.filter(
              (i: FlaggedIssue) => i.type === "unresolved_citation",
            );

            // The unresolved_citation set is EXACTLY the set of withheld records
            // (completeness + soundness of the grounding check — Req 22.8/22.9):
            // every unresolved citation appears and none is added for a resolved one.
            const actualSlots = unresolved
              .map(classifyUnresolved)
              .sort();
            const expectedSlots = expectedUnresolvedSlots(scn);
            expect(actualSlots).toEqual(expectedSlots);

            // Each grounding failure is BLOCKING (Req 22.9).
            for (const issue of unresolved) {
              expect(issue.severity).toBe("blocking");
            }

            if (expectedSlots.length > 0) {
              // Req 22.9 — any unresolved reference forces status "fail".
              expect((result as VerificationResult).status).toBe("fail");
            } else {
              // Fully grounded — every citation resolves, so nothing is flagged
              // and the appeal verifies (Req 22.4/22.8).
              expect(issues.length).toBe(0);
              expect((result as VerificationResult).status).toBe("pass");
            }
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});
