// =============================================================================
// lib/agentRunner.linkage.test.ts
//
// Property 53: Patient and payer linkage set on resolve, unset otherwise.
//
// **Validates: Requirements 2.5, 2.6, 2.7, 2.8**
//
// In the Intake_And_Extraction stage (`lib/agentRunner.ts`):
//   • Req 2.5 — WHEN the extracted patient resolves to a known Patient record,
//     Case.patientId is set to that Patient's id.
//   • Req 2.6 — IF the extracted patient cannot be matched, Case.patientId is
//     left unset AND the patient is recorded as an unresolved field (Req 20.4).
//   • Req 2.7 — WHEN the extracted payer resolves to a known Payer, the Case
//     payer reference (Case.payerId AND Case.payerName) is set to that Payer.
//   • Req 2.8 — IF the extracted payer cannot be resolved, the Case payer
//     reference is left unset AND the payer is recorded as an unresolved field.
//
// Property: for EACH entity independently, the Case linkage is set EXACTLY when
// the extracted value resolves to a stored record, and is left unset with an
// unresolved-field Trace_Step otherwise.
//
// Strategy (mirrors the established agentRunner test pattern):
//   • The intake stage's single Qwen extraction call is the only seam deciding
//     which entity values are presented. We `vi.mock` `./qwen`.callQwen and, for
//     the Intake_And_Extraction system prompt, return a crafted extraction JSON:
//       - "resolves"  → the seeded Patient/Payer name (links),
//       - "no_match"  → a generated name guaranteed not to match any seed,
//       - "unknown"   → the "unknown" sentinel (confidence 0).
//     Every other stage gets a trivial `{}` success so the pipeline runs to
//     completion with no live model. The three plain-text fields are always
//     resolvable, so the only fields that can appear unresolved are patient and
//     payer — exactly what this property inspects.
//   • `./appealPdf`.generateAppealPdf is stubbed so no PDF hits disk.
//   • Persistence uses an isolated, throwaway PostgreSQL schema (`createTestDb`),
//     wired as the shared Prisma client BEFORE importing the runner.
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

const KNOWN_PATIENT_NAME = "Linkage Test Patient";
const KNOWN_PAYER_NAME = "Linkage Test Payer Co";

// Always-resolvable plain-text values for the three non-entity fields, so the
// only fields that can be unresolved are the two entity fields under test.
const RESOLVABLE_PROCEDURE_CODE = "70450";
const RESOLVABLE_DIAGNOSIS_CODE = "R51";
const RESOLVABLE_DENIAL_REASON = "not medically necessary per policy";

// The persisted field names the Intake_And_Extraction stage uses (Req 20.3/20.4).
const FIELD_NAME = {
  patient: "patient",
  payer: "payer",
} as const;

// ─── Hoisted controller shared with the module mocks ──────────────────────────
const controller = vi.hoisted(() => ({
  /** The intake extraction JSON the mocked Qwen returns for the current sample. */
  intakeContent: "{}",
}));

// FAKE Qwen: for the Intake_And_Extraction stage, return the crafted extraction;
// every other stage completes on its first iteration with a trivial `{}` success
// so the pipeline runs end to end with no network. Preserve other `./qwen` exports.
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
let seededPatientId: string;
let seededPayerId: string;

beforeAll(async () => {
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
  seededPayerId = payer.id;
  const patient = await prisma.patient.create({
    data: {
      name: KNOWN_PATIENT_NAME,
      dob: new Date("1980-05-05T00:00:00.000Z"),
      payerId: payer.id,
    },
    select: { id: true },
  });
  seededPatientId = patient.id;
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** How an entity value is presented to the intake stage for a sample. */
type Variant =
  | { kind: "resolves" }
  | { kind: "no_match"; name: string }
  | { kind: "unknown" };

/** True iff this variant is expected to link the entity to a stored record. */
function resolves(v: Variant): boolean {
  return v.kind === "resolves";
}

/** Build one field draft for the given entity variant and seeded name. */
function entityDraft(v: Variant, seededName: string) {
  if (v.kind === "resolves") {
    return { value: seededName, confidence: 0.9, reasoning: "test: resolvable" };
  }
  if (v.kind === "no_match") {
    return { value: v.name, confidence: 0.9, reasoning: "test: non-matching name" };
  }
  return { value: "unknown", confidence: 0, reasoning: "test: unknown" };
}

/** Craft the intake extraction JSON for a (patient, payer) variant pair. */
function buildIntakeContent(patient: Variant, payer: Variant): string {
  return JSON.stringify({
    patient: entityDraft(patient, KNOWN_PATIENT_NAME),
    payer: entityDraft(payer, KNOWN_PAYER_NAME),
    procedureCode: {
      value: RESOLVABLE_PROCEDURE_CODE,
      confidence: 0.9,
      reasoning: "test: resolvable",
    },
    diagnosisCode: {
      value: RESOLVABLE_DIAGNOSIS_CODE,
      confidence: 0.9,
      reasoning: "test: resolvable",
    },
    denialReason: {
      value: RESOLVABLE_DENIAL_REASON,
      confidence: 0.9,
      reasoning: "test: resolvable",
    },
  });
}

/** Seed a fresh, independent `New` Case for one property sample. */
async function seedCase(): Promise<string> {
  const kase = await prisma.case.create({
    data: {
      intakeType: "denial_letter",
      rawIntakeText: "seed intake for patient/payer linkage property test",
      status: "New",
      slaDeadline: new Date("2099-01-01T00:00:00.000Z"),
    },
    select: { id: true },
  });
  return kase.id;
}

// A generator for entity variants. The "no_match" name is a generated string
// prefixed so it can never collide with a seeded name (case-insensitively).
const variantArb: fc.Arbitrary<Variant> = fc.oneof(
  fc.constant<Variant>({ kind: "resolves" }),
  fc.constant<Variant>({ kind: "unknown" }),
  fc
    .string({ minLength: 1, maxLength: 12 })
    .map((s) => s.replace(/[^A-Za-z0-9 ]/g, "").trim() || "X")
    .map<Variant>((s) => ({ kind: "no_match", name: `Unmatched ${s} 9Z7` })),
);

// ─── Property 53 ──────────────────────────────────────────────────────────────

describe("Property 53: patient/payer linkage set on resolve, unset otherwise (Req 2.5–2.8)", () => {
  it(
    "sets Case.patientId / Case.payerId+payerName exactly when the entity resolves, else leaves unset and traces it unresolved",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          variantArb,
          variantArb,
          async (patientVariant: Variant, payerVariant: Variant) => {
            controller.intakeContent = buildIntakeContent(
              patientVariant,
              payerVariant,
            );
            const patientShouldLink = resolves(patientVariant);
            const payerShouldLink = resolves(payerVariant);

            const caseId = await seedCase();
            await runAgent(caseId);

            const kase = await prisma.case.findUnique({
              where: { id: caseId },
              select: { patientId: true, payerId: true, payerName: true },
            });
            expect(kase).not.toBeNull();

            // ── Patient linkage (Req 2.5 / 2.6) ──────────────────────────────
            if (patientShouldLink) {
              expect(kase!.patientId).toBe(seededPatientId);
            } else {
              expect(kase!.patientId).toBeNull();
            }

            // ── Payer linkage (Req 2.7 / 2.8) ────────────────────────────────
            if (payerShouldLink) {
              expect(kase!.payerId).toBe(seededPayerId);
              expect(kase!.payerName).toBe(KNOWN_PAYER_NAME);
            } else {
              expect(kase!.payerId).toBeNull();
              expect(kase!.payerName).toBeNull();
            }

            // ── Unresolved-field Trace_Step (Req 2.6 / 2.8 via Req 20.4) ─────
            const steps = await prisma.traceStep.findMany({
              where: { caseId },
              select: { stepType: true, reasoning: true, output: true },
            });
            const unresolvedStep = steps.find(
              (s) =>
                s.stepType === "tool_call" &&
                s.reasoning.includes("Unresolved intake field(s):"),
            );

            const expectedUnresolved: string[] = [];
            if (!patientShouldLink) expectedUnresolved.push(FIELD_NAME.patient);
            if (!payerShouldLink) expectedUnresolved.push(FIELD_NAME.payer);

            if (expectedUnresolved.length > 0) {
              // A Trace_Step must exist naming each unresolved entity field.
              expect(unresolvedStep).toBeDefined();
              const output = (unresolvedStep!.output ?? {}) as {
                unresolvedFields?: unknown;
              };
              const named = Array.isArray(output.unresolvedFields)
                ? (output.unresolvedFields as string[])
                : [];
              // The three text fields always resolve, so the unresolved set is
              // exactly the sampled entity fields that did not link.
              expect([...named].sort()).toEqual([...expectedUnresolved].sort());
              for (const field of expectedUnresolved) {
                expect(unresolvedStep!.reasoning).toContain(field);
              }
            } else {
              // Both entities linked and all text fields resolve ⇒ no unresolved step.
              expect(unresolvedStep).toBeUndefined();
            }
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});
