// =============================================================================
// lib/agentRunner.intakeUnresolved.test.ts
//
// Property 38: Unresolved intake fields are traced without terminating.
//
// **Validates: Requirements 20.4**
//
// Requirement 20.4 mandates that in the Intake_And_Extraction stage
// (`lib/agentRunner.ts`), for any of the five required Extracted_Fields
// (patient, payer, procedure_code, diagnosis_code, denial_reason) that cannot be
// resolved, the stage records a Trace_Step naming each unresolved field and
// CONTINUES the pipeline WITHOUT terminating the Case.
//
// Property: for ANY subset of the five fields being unresolvable, a Trace_Step
// is recorded naming each unresolved field AND the pipeline proceeds past intake
// (the Case is not terminated at intake — subsequent stages execute).
//
// Strategy (mirrors the established agentRunner test pattern):
//   • The intake stage's single Qwen extraction call is the only seam that
//     decides which fields resolve. We `vi.mock` `./qwen`.callQwen and, for the
//     Intake_And_Extraction system prompt, return an extraction JSON that leaves
//     the sampled subset of fields "unknown" (and, for the resolvable subset,
//     returns values that resolve — a seeded Patient/Payer name for the two
//     entity fields, a plain value for the three text fields). Every other stage
//     gets a trivial `{}` success so the pipeline runs to completion without the
//     live model.
//   • `./appealPdf`.generateAppealPdf is stubbed so no PDF is rendered to disk on
//     the drafting paths.
//   • Persistence uses an isolated, throwaway PostgreSQL schema (`createTestDb`),
//     wired as the shared Prisma client BEFORE importing the runner so `runAgent`
//     and its `createTraceStep` writes land in the disposable schema.
//
// Uses Vitest + fast-check (numRuns 100), consistent with the rest of the suite.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type { QwenOutcome } from "./types";

// ─── Known, resolvable entity names (seeded once in beforeAll) ────────────────

const KNOWN_PATIENT_NAME = "Jane Intake Doe";
const KNOWN_PAYER_NAME = "Acme Health Insurance";

// Resolvable plain-text values for the three non-entity fields.
const RESOLVABLE_PROCEDURE_CODE = "70450";
const RESOLVABLE_DIAGNOSIS_CODE = "R51";
const RESOLVABLE_DENIAL_REASON = "not medically necessary per policy";

// The persisted field names the Intake_And_Extraction stage uses (Req 20.3/20.4).
const FIELD_NAME = {
  patient: "patient",
  payer: "payer",
  procedureCode: "procedure_code",
  diagnosisCode: "diagnosis_code",
  denialReason: "denial_reason",
} as const;

// ─── Hoisted controller shared with the module mocks ──────────────────────────
//
// `vi.mock` factories are hoisted above imports, so the mutable state they close
// over must be created with `vi.hoisted`. Each property sample sets
// `controller.intakeContent` to the extraction JSON for that run.
const controller = vi.hoisted(() => ({
  /** The intake extraction JSON the mocked Qwen returns for the current sample. */
  intakeContent: "{}",
}));

// FAKE Qwen: for the Intake_And_Extraction stage, return the crafted extraction
// (leaving the sampled subset "unknown"); every other stage completes on its
// first iteration with a trivial `{}` success so the pipeline runs end to end
// with no network. Preserve every other `./qwen` export.
vi.mock("./qwen", async (importActual) => {
  const actual = await importActual<typeof import("./qwen")>();
  return {
    ...actual,
    callQwen: async (
      messages: import("./qwen").ChatMessage[],
    ): Promise<QwenOutcome> => {
      const sys =
        typeof messages[0]?.content === "string" ? messages[0].content : "";
      if (sys.includes("the Intake_And_Extraction stage")) {
        return { ok: true as const, toolCalls: [], content: controller.intakeContent };
      }
      return { ok: true as const, toolCalls: [], content: "{}" };
    },
  };
});

// Stub the generate-appeal-PDF tool so drafting paths render nothing to disk.
vi.mock("./appealPdf", async (importActual) => {
  const actual = await importActual<typeof import("./appealPdf")>();
  return {
    ...actual,
    generateAppealPdf: async (caseId: string) => ({ url: `/appeals/${caseId}.pdf` }),
  };
});

// ─── Test-DB wiring (bound before importing the runner) ───────────────────────

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

  // Seed the known Payer + Patient the two entity fields can resolve against.
  const payer = await prisma.payer.create({
    data: { name: KNOWN_PAYER_NAME },
    select: { id: true },
  });
  await prisma.patient.create({
    data: {
      name: KNOWN_PATIENT_NAME,
      dob: new Date("1980-05-05T00:00:00.000Z"),
      payerId: payer.id,
    },
  });
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface Unresolvable {
  patient: boolean;
  payer: boolean;
  procedureCode: boolean;
  diagnosisCode: boolean;
  denialReason: boolean;
}

/** Build one field draft: "unknown" (confidence 0) when unresolvable. */
function draft(value: string, unresolvable: boolean) {
  return unresolvable
    ? { value: "unknown", confidence: 0, reasoning: "test: left unresolvable" }
    : { value, confidence: 0.9, reasoning: "test: resolvable value" };
}

/**
 * Craft the intake extraction JSON, leaving the sampled subset "unknown". The
 * resolvable entity fields use the seeded Patient/Payer names so they link;
 * the resolvable text fields use plain non-unknown values.
 */
function buildIntakeContent(u: Unresolvable): string {
  return JSON.stringify({
    patient: draft(KNOWN_PATIENT_NAME, u.patient),
    payer: draft(KNOWN_PAYER_NAME, u.payer),
    procedureCode: draft(RESOLVABLE_PROCEDURE_CODE, u.procedureCode),
    diagnosisCode: draft(RESOLVABLE_DIAGNOSIS_CODE, u.diagnosisCode),
    denialReason: draft(RESOLVABLE_DENIAL_REASON, u.denialReason),
  });
}

/** The persisted field names expected to be reported unresolved for a subset. */
function expectedUnresolved(u: Unresolvable): string[] {
  const out: string[] = [];
  if (u.patient) out.push(FIELD_NAME.patient);
  if (u.payer) out.push(FIELD_NAME.payer);
  if (u.procedureCode) out.push(FIELD_NAME.procedureCode);
  if (u.diagnosisCode) out.push(FIELD_NAME.diagnosisCode);
  if (u.denialReason) out.push(FIELD_NAME.denialReason);
  return out;
}

/** Seed a fresh, independent `New` Case for one property sample. */
async function seedCase(): Promise<string> {
  const kase = await prisma.case.create({
    data: {
      intakeType: "denial_letter",
      rawIntakeText: "seed intake for unresolved-fields property test",
      status: "New",
      slaDeadline: new Date("2099-01-01T00:00:00.000Z"),
    },
    select: { id: true },
  });
  return kase.id;
}

// ─── Property 38 ────────────────────────────────────────────────────────────

describe("Property 38: unresolved intake fields are traced without terminating (Req 20.4)", () => {
  it(
    "records a Trace_Step naming each unresolved field and proceeds past intake, for any subset",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            patient: fc.boolean(),
            payer: fc.boolean(),
            procedureCode: fc.boolean(),
            diagnosisCode: fc.boolean(),
            denialReason: fc.boolean(),
          }),
          async (u: Unresolvable) => {
            controller.intakeContent = buildIntakeContent(u);
            const expected = expectedUnresolved(u);

            const caseId = await seedCase();
            await runAgent(caseId);

            const steps = await prisma.traceStep.findMany({
              where: { caseId },
              select: { stepType: true, reasoning: true, output: true },
            });

            // ── (A) Unresolved fields are TRACED, naming each one (Req 20.4) ──
            const unresolvedStep = steps.find(
              (s) =>
                s.stepType === "tool_call" &&
                s.reasoning.includes("Unresolved intake field(s):"),
            );

            if (expected.length > 0) {
              // A dedicated Trace_Step must exist naming each unresolved field.
              expect(unresolvedStep).toBeDefined();

              // The structured output lists exactly the unresolved fields.
              const output = (unresolvedStep!.output ?? {}) as {
                unresolvedFields?: unknown;
              };
              const named = Array.isArray(output.unresolvedFields)
                ? (output.unresolvedFields as string[])
                : [];
              expect([...named].sort()).toEqual([...expected].sort());

              // The human-readable reasoning names each unresolved field.
              for (const field of expected) {
                expect(unresolvedStep!.reasoning).toContain(field);
              }
            } else {
              // Nothing unresolvable ⇒ no unresolved-field Trace_Step is written.
              expect(unresolvedStep).toBeUndefined();
            }

            // ── (B) The pipeline PROCEEDS past intake (not terminated) ────────
            // Subsequent stages executing is the observable proof intake did not
            // terminate the Case: the two review stages run right after intake.
            const stageStepTypes = new Set(steps.map((s) => s.stepType));
            expect(stageStepTypes.has("medical_review")).toBe(true);
            expect(stageStepTypes.has("policy_review")).toBe(true);

            // The Case is never left in a terminal-denied state by intake.
            const kase = await prisma.case.findUnique({
              where: { id: caseId },
              select: { status: true },
            });
            expect(kase?.status).not.toBe("DeniedFinal");
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});
