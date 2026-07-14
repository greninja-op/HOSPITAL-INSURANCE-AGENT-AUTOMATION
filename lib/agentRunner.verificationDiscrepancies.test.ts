// =============================================================================
// lib/agentRunner.verificationDiscrepancies.test.ts
//
// Property 46: Verification flags all discrepancies.
//
// **Validates: Requirements 22.1, 22.2, 22.3**
//
// The Verification_QA stage (`lib/agentRunner.ts`) independently re-reads the
// in-scope Payer_Policy / Chart_Note records and the Case Extracted_Field values
// and checks the drafted Appeal_Packet against them, COLLECTING EVERY flagged
// issue:
//   • every citation against retrieved Payer_Policy/Chart_Note data (Req 22.1),
//   • every patient/policy/code reference against the Extracted_Field values
//     (Req 22.2),
//   • every claim against the retrieved evidence (Req 22.3).
//
// Property (completeness): for any set of citations/references/claims where SOME
// are discrepant, EVERY discrepancy appears as a flagged issue — none is missed
// — and, conversely, a fully-consistent packet flags nothing.
//
// Strategy of this test:
//   • We drive the REAL `runAgent` pipeline end to end against an isolated,
//     throwaway PostgreSQL schema (`createTestDb`), replacing only the two
//     non-deterministic seams: the Qwen_Client (`./qwen`.callQwen — routed by
//     the stage's system prompt to fixed, deterministic stage outputs) and the
//     PDF renderer (`./appealPdf`.generateAppealPdf — stubbed to a bare URL so
//     no file is ever written). The Decision/Verification stages make no model
//     call, so the pipeline's routing and the independent grounding checks run
//     for real.
//   • The intake mock resolves the five fields with high confidence and NO
//     blocking findings, so the deterministic Decision_Engine routes to
//     Auto_Draft (confidence 95 > 85) — a drafting path — and the appeal is
//     generated, so Verification_QA actually runs (Req 22.5).
//   • Entity linkage is by exact name match (Intake links a Patient/Payer only
//     when the extracted value equals a stored record). We therefore keep the
//     patient + payer LINKED and a chart note present, and inject discrepancies
//     on the two dimensions that a linked-record pipeline can actually surface:
//       - DIAGNOSIS reference (Req 22.2): the chart note's diagnosis code either
//         matches the Extracted_Field diagnosis code (consistent) or differs
//         (→ a `reference_mismatch` on the diagnosis code), and
//       - PAYER-POLICY citation (Req 22.1): the cited policy either resolves to
//         a stored policy WITH criteria text (consistent), does not resolve at
//         all (→ `unresolved_citation`), or resolves to a policy with EMPTY
//         criteria (→ `unsupported_citation`).
//     These two dimensions are independent, so any combination — including both
//     discrepant at once — must surface BOTH issues (the "none missed" core of
//     the property), while the all-consistent combination must surface none.
//   • After each run we read back the persisted `Case.verificationResult`
//     (Req 23.2) and assert the flagged-issue set is EXACTLY the set implied by
//     the injected discrepancies (completeness + soundness), and that
//     `status` is `fail` iff any discrepancy was injected (Req 22.4).
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
// its OWN seeded Patient/Payer (Intake links by exact, case-insensitive name),
// keeping runs isolated within the shared schema. Codes/denial are fixed.

const PROCEDURE_CODE = "27447";
const DIAGNOSIS_CODE = "M17.11";
const MISMATCHED_DIAGNOSIS_CODE = "Z99.999"; // never equal to DIAGNOSIS_CODE
const DENIAL_REASON = "Not medically necessary per policy criteria.";

// Fixed, single-line stage assessments so the reconstructed Appeal_Packet
// content (policy clause / supporting evidence / argument) is deterministic.
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
// Intake links to THIS run's records (the shared schema is not reset per run).
let runSeq = 0;

type PolicyState = "good" | "absent" | "empty";

interface Scenario {
  /** chart note diagnosis code equals the extracted diagnosis code? */
  diagMatches: boolean;
  policyState: PolicyState;
}

/**
 * Seed a fresh, LINKED Case (patient + payer resolvable by the intake mock's
 * fixed names) with a single chart note and an optional payer policy, shaped by
 * the scenario's injected discrepancies. Returns the Case id.
 */
async function seedScenario(scn: Scenario): Promise<string> {
  const token = `${Date.now().toString(36)}-${(runSeq += 1)}`;
  hoisted.patientName = `Jane Doe ${token}`;
  hoisted.payerName = `Acme Health Plan ${token}`;

  const payer = await prisma.payer.create({
    data: { name: hoisted.payerName },
  });

  const patient = await prisma.patient.create({
    data: {
      name: hoisted.patientName,
      dob: new Date("1980-05-01T00:00:00.000Z"),
      payerId: payer.id,
    },
  });

  // Exactly one chart note (so hasChart is true) — its diagnosis code either
  // matches the extracted diagnosis code or is deliberately different.
  await prisma.chartNote.create({
    data: {
      patientId: patient.id,
      noteDate: new Date("2025-11-01T00:00:00.000Z"),
      content: "Documented failed conservative therapy; symptoms persist.",
      diagnosisCode: scn.diagMatches ? DIAGNOSIS_CODE : MISMATCHED_DIAGNOSIS_CODE,
    },
  });

  // Payer policy: present-with-criteria (consistent), absent (unresolved), or
  // present-with-EMPTY-criteria (unsupported citation).
  if (scn.policyState !== "absent") {
    await prisma.payerPolicy.create({
      data: {
        payerId: payer.id,
        policyCode: "LCD L34567",
        procedureCode: PROCEDURE_CODE,
        criteriaText:
          scn.policyState === "empty"
            ? ""
            : "Approve when three months of documented conservative therapy have failed.",
      },
    });
  }

  const kase = await prisma.case.create({
    data: {
      intakeType: "denial_letter",
      rawIntakeText: "seed intake for verification-discrepancies property test",
      status: "New",
      slaDeadline: new Date("2026-01-15T12:00:00.000Z"),
    },
  });
  return kase.id;
}

/** The flagged-issue TYPES the scenario's injected discrepancies MUST produce. */
function expectedIssueTypes(scn: Scenario): string[] {
  const types: string[] = [];
  // Req 22.2 — the diagnosis-code reference must match the chart record.
  if (!scn.diagMatches) types.push("reference_mismatch");
  // Req 22.1 — the cited payer policy must resolve and be supported.
  if (scn.policyState === "absent") types.push("unresolved_citation");
  else if (scn.policyState === "empty") types.push("unsupported_citation");
  return types.sort();
}

describe("Property 46: Verification_QA flags every discrepancy (Req 22.1, 22.2, 22.3)", () => {
  it(
    "for any injected discrepancies, EVERY discrepancy is flagged (none missed) and a consistent packet flags none",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            diagMatches: fc.boolean(),
            policyState: fc.constantFrom<PolicyState>("good", "absent", "empty"),
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

            const result = kase?.verificationResult as unknown as VerificationResult | null;
            expect(result).not.toBeNull();
            expect(Array.isArray(result?.flaggedIssues)).toBe(true);

            const issues = (result as VerificationResult).flaggedIssues;
            const actualTypes = issues.map((i: FlaggedIssue) => i.type).sort();
            const expected = expectedIssueTypes(scn);

            // Completeness + soundness — the flagged-issue set is EXACTLY the set
            // implied by the injected discrepancies: every discrepancy appears
            // (none missed) and nothing spurious is added.
            expect(actualTypes).toEqual(expected);

            // The diagnosis reference_mismatch must name the offending code
            // (the Extracted_Field diagnosis value) — Req 22.2.
            if (!scn.diagMatches) {
              const dxIssue = issues.find(
                (i: FlaggedIssue) => i.type === "reference_mismatch",
              );
              expect(dxIssue?.reference).toBe(DIAGNOSIS_CODE);
            }

            // Req 22.4 — pass iff no issue was flagged, else fail.
            expect((result as VerificationResult).status).toBe(
              expected.length === 0 ? "pass" : "fail",
            );
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});
