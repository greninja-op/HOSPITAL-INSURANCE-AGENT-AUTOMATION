// =============================================================================
// lib/agentRunner.intakeUnresolved.test.ts
//
// Property 38: Unresolved intake fields are traced without terminating.
//
// **Validates: Requirements 20.4**
//
// For ANY intake in which some subset of the five required Extracted_Fields
// (patient, payer, procedure code, diagnosis code, denial reason) cannot be
// resolved, the Intake_And_Extraction stage (`lib/agentRunner.ts`):
//   • records a Trace_Step that NAMES EACH unresolved field, and
//   • CONTINUES the pipeline to the subsequent stages rather than terminating
//     the Case.
//
// Strategy (mirrors the other end-to-end runner property tests, e.g.
// lib/agentRunner.verificationDiscrepancies.test.ts):
//   • The intake stage body is not exported and `runAgent` exposes no `deps`
//     seam, so the SMALLEST seam that still exercises unresolved-field tracing
//     is the REAL `runAgent` pipeline. We drive it end to end against an
//     isolated, throwaway PostgreSQL schema (`createTestDb`), replacing only the
//     two non-deterministic seams:
//       - `./qwen`.callQwen — a deterministic FAKE routed by the stage's system
//         prompt. For Intake it returns a controlled five-field extraction in
//         which the generated subset of fields is "unknown" (unresolvable);
//         Medical/Policy/Strategy return benign completions so the pipeline
//         proceeds past intake without a live model.
//       - `./appealPdf`.generateAppealPdf — stubbed so no real file is written.
//   • A field is "unresolved" when either the model returned "unknown" (the
//     three plain-text fields), or the extracted patient/payer value does not
//     match any stored record. We drive both mechanisms: unresolved fields are
//     emitted as "unknown"; resolved patient/payer values match a seeded record.
//   • After each run we read back the persisted Trace_Steps and assert the
//     Intake stage recorded a Trace_Step whose `unresolvedFields` output NAMES
//     EXACTLY the generated unresolved set (and whose reasoning names each), and
//     that the pipeline CONTINUED — the concurrent Medical_Review and
//     Policy_Review stages ran (their labeled Trace_Steps exist) and the Case
//     was not left terminated at intake (status advanced past "New").
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

// ─── The five required intake fields and their persisted/unresolved names ─────
//
// Keys are the extraction JSON keys; `traceName` is the name the Intake stage
// records for an unresolved field (mirrors INTAKE_FIELD_NAMES in the runner).

const FIELDS = [
  { key: "patient", traceName: "patient" },
  { key: "payer", traceName: "payer" },
  { key: "procedureCode", traceName: "procedure_code" },
  { key: "diagnosisCode", traceName: "diagnosis_code" },
  { key: "denialReason", traceName: "denial_reason" },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];

// Fixed, resolvable values for fields the sample keeps RESOLVED. Patient/payer
// values carry a per-run token (set below) so they match this run's seeded
// records; the three plain-text fields are any non-"unknown" value.
const RESOLVED_PROCEDURE_CODE = "27447";
const RESOLVED_DIAGNOSIS_CODE = "M17.11";
const RESOLVED_DENIAL_REASON = "Not medically necessary per policy criteria.";

// ─── Per-run controller shared with the hoisted Qwen mock ─────────────────────
//
// `vi.mock` factories are hoisted above imports, so the mutable handle they
// close over must be created with `vi.hoisted`. Each sample sets the extraction
// the Intake stage should return (with the generated subset marked "unknown")
// and the per-run patient/payer names before invoking `runAgent`.

const hoisted = vi.hoisted(() => ({
  patientName: "Jane Doe",
  payerName: "Acme Health Plan",
  extractionJson: "{}",
}));

// FAKE Qwen: route by the stage's system prompt to deterministic outputs so the
// pipeline runs past intake with no network. Every other `./qwen` export is
// preserved so unrelated importers are unaffected.
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

      // Intake_And_Extraction — the controlled five-field extraction.
      if (sys.includes("the Intake_And_Extraction stage")) {
        return success(hoisted.extractionJson);
      }
      // Medical_Review / Policy_Review — benign single-line assessments so both
      // concurrent reviews complete and the pipeline proceeds past intake.
      if (sys.includes("the Medical_Review stage")) {
        return success("Chart reviewed; assessment recorded for downstream use.");
      }
      if (sys.includes("the Policy_Review stage")) {
        return success("Payer policy reviewed; assessment recorded for downstream use.");
      }
      // Strategy — a minimal valid options payload (1 approach).
      if (sys.includes("the Strategy stage")) {
        return success(
          JSON.stringify({
            options: [
              {
                approach: "Peer-to-peer review",
                winProbability: 50,
                rationale: "Baseline approach for the sample.",
              },
            ],
            payerTrackRecordSummary: "No payer-specific history available.",
          }),
        );
      }
      // Decision / Appeal / Verification make no model call; return benign JSON.
      return success("{}");
    },
  };
});

// STUB the PDF renderer so a drafting path never writes a real file.
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

// A monotonic per-run token keeps each sample's Patient/Payer names unique so a
// RESOLVED patient/payer links to THIS run's records (the shared schema is not
// reset per run).
let runSeq = 0;

/** A single draft field the Intake mock emits. */
function draft(value: string, resolved: boolean) {
  return {
    value,
    confidence: resolved ? 0.95 : 0,
    reasoning: resolved ? "seed" : "not determinable",
  };
}

/**
 * Seed a Case whose intake resolves exactly the fields NOT in `unresolved`.
 * A resolvable patient/payer is seeded and named in the extraction; unresolved
 * fields are emitted as "unknown". Returns the Case id and the sorted set of
 * trace names expected in the Intake stage's unresolved-field Trace_Step.
 */
async function seedCase(
  unresolved: Set<FieldKey>,
): Promise<{ caseId: string; expected: string[] }> {
  const token = `${Date.now().toString(36)}-${(runSeq += 1)}`;
  hoisted.patientName = `Jane Doe ${token}`;
  hoisted.payerName = `Acme Health Plan ${token}`;

  // Seed a resolvable Payer + Patient so a RESOLVED patient/payer value links.
  const payer = await prisma.payer.create({ data: { name: hoisted.payerName } });
  await prisma.patient.create({
    data: {
      name: hoisted.patientName,
      dob: new Date("1980-05-01T00:00:00.000Z"),
      payerId: payer.id,
    },
  });

  const isUnres = (k: FieldKey) => unresolved.has(k);
  const extraction = {
    patient: draft(isUnres("patient") ? "unknown" : hoisted.patientName, !isUnres("patient")),
    payer: draft(isUnres("payer") ? "unknown" : hoisted.payerName, !isUnres("payer")),
    procedureCode: draft(
      isUnres("procedureCode") ? "unknown" : RESOLVED_PROCEDURE_CODE,
      !isUnres("procedureCode"),
    ),
    diagnosisCode: draft(
      isUnres("diagnosisCode") ? "unknown" : RESOLVED_DIAGNOSIS_CODE,
      !isUnres("diagnosisCode"),
    ),
    denialReason: draft(
      isUnres("denialReason") ? "unknown" : RESOLVED_DENIAL_REASON,
      !isUnres("denialReason"),
    ),
  };
  hoisted.extractionJson = JSON.stringify(extraction);

  const kase = await prisma.case.create({
    data: {
      intakeType: "denial_letter",
      rawIntakeText: "seed intake for unresolved-field property test",
      status: "New",
      slaDeadline: new Date("2026-01-15T12:00:00.000Z"),
    },
  });

  const expected = FIELDS.filter((f) => unresolved.has(f.key))
    .map((f) => f.traceName)
    .sort();
  return { caseId: kase.id, expected };
}

describe("Property 38: unresolved intake fields are traced without terminating (Req 20.4)", () => {
  it(
    "names each unresolved field in a Trace_Step and continues the pipeline past intake",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // Any NON-EMPTY subset of the five fields is unresolvable. Non-empty so
          // the Intake stage writes its unresolved-field Trace_Step at all.
          fc
            .subarray(FIELDS.map((f) => f.key) as FieldKey[])
            .filter((keys) => keys.length > 0),
          async (unresolvedKeys: FieldKey[]) => {
            const unresolved = new Set<FieldKey>(unresolvedKeys);
            const { caseId, expected } = await seedCase(unresolved);

            // Act: run the REAL pipeline end to end.
            await runner.runAgent(caseId);

            const steps = await prisma.traceStep.findMany({
              where: { caseId },
              orderBy: { timestamp: "asc" },
            });

            // ── Req 20.4 (trace): the Intake stage recorded a Trace_Step that
            // names EACH unresolved field. ────────────────────────────────────
            const unresolvedStep = steps.find(
              (s) =>
                s.reasoning.includes("[Intake_And_Extraction]") &&
                s.reasoning.includes("Unresolved intake field(s)"),
            );
            expect(unresolvedStep).toBeDefined();

            // The structured output names EXACTLY the unresolved set.
            const output = unresolvedStep?.output as
              | { unresolvedFields?: unknown }
              | null;
            const named = Array.isArray(output?.unresolvedFields)
              ? [...(output!.unresolvedFields as string[])].sort()
              : [];
            expect(named).toEqual(expected);

            // The human-readable reasoning also names each unresolved field.
            for (const name of expected) {
              expect(unresolvedStep?.reasoning).toContain(name);
            }

            // ── Req 20.4 (continue, don't terminate): the pipeline PROCEEDED to
            // the subsequent concurrent review stages. Their labeled Trace_Steps
            // exist only if intake did NOT terminate the Case. ─────────────────
            const stepTypes = new Set(steps.map((s) => s.stepType));
            expect(stepTypes.has("medical_review")).toBe(true);
            expect(stepTypes.has("policy_review")).toBe(true);

            // The Case was not left terminated at intake — its status advanced
            // past the initial "New".
            const kase = await prisma.case.findUnique({
              where: { id: caseId },
              select: { status: true },
            });
            expect(kase?.status).not.toBe("New");
          },
        ),
        FC_CONFIG,
      );
    },
    600_000,
  );
});
