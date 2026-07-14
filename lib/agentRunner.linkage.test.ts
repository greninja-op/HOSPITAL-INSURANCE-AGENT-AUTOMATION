// =============================================================================
// lib/agentRunner.linkage.test.ts
//
// Property 53: Patient and payer linkage set on resolve, unset otherwise.
//
// **Validates: Requirements 2.5, 2.6, 2.7, 2.8**
//
// In the Intake_And_Extraction stage (`lib/agentRunner.ts`):
//   • Case.patientId is set to a matched Patient's id when the extracted patient
//     name matches a known Patient, and left unset otherwise (Req 2.5, 2.6).
//   • The Case payer reference (Case.payerId + Case.payerName) is set to a
//     resolved Payer when the extracted payer name resolves to a known Payer,
//     and left unset otherwise (Req 2.7, 2.8).
//   • For each of patient/payer that does NOT resolve, a Trace_Step naming that
//     field as unresolved is recorded (Req 2.6, 2.8 → 20.4).
//
// Property: for ANY combination of patient-resolvable/unresolvable and
// payer-resolvable/unresolvable, the Case links (patientId, payerId/payerName)
// are set EXACTLY when the corresponding entity resolves and left unset
// otherwise, with an unresolved Trace_Step naming each entity that does not
// resolve.
//
// Strategy (mirrors the established agentRunner test pattern in
// `agentRunner.intakeUnresolved.test.ts`):
//   • `vi.mock` `./qwen`.callQwen: for the Intake_And_Extraction system prompt
//     return an extraction JSON whose patient/payer names either MATCH the
//     seeded records (resolvable) or are a fresh non-matching name (unresolvable)
//     per the sample. Every other stage returns a trivial `{}` success so the
//     pipeline runs end to end with no network.
//   • The three plain-text fields are always given resolvable values so the only
//     entity-linkage variables under test are patient and payer.
//   • `./appealPdf`.generateAppealPdf is stubbed so drafting renders nothing.
//   • Persistence uses an isolated, throwaway PostgreSQL schema (`createTestDb`)
//     bound as the shared Prisma client BEFORE importing the runner.
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

const KNOWN_PATIENT_NAME = "Linkage Patient Doe";
const KNOWN_PAYER_NAME = "Linkage Health Insurance";

// Resolvable plain-text values for the three non-entity fields (kept resolvable
// so patient/payer are the only linkage variables under test).
const RESOLVABLE_PROCEDURE_CODE = "70450";
const RESOLVABLE_DIAGNOSIS_CODE = "R51";
const RESOLVABLE_DENIAL_REASON = "not medically necessary per policy";

// The persisted field names the Intake_And_Extraction stage uses (Req 20.3/20.4).
const FIELD_NAME = { patient: "patient", payer: "payer" } as const;

// ─── Hoisted controller shared with the module mocks ──────────────────────────
const controller = vi.hoisted(() => ({
  /** The intake extraction JSON the mocked Qwen returns for the current sample. */
  intakeContent: "{}",
}));

// FAKE Qwen: for the Intake_And_Extraction stage, return the crafted extraction;
// every other stage completes on its first iteration with a trivial `{}` success
// so the pipeline runs end to end with no network. Preserve every other export.
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

interface Sample {
  /** true ⇒ the extracted patient name matches the seeded Patient (resolves). */
  patientResolves: boolean;
  /** true ⇒ the extracted payer name matches the seeded Payer (resolves). */
  payerResolves: boolean;
  /** A fresh non-matching suffix, so unresolvable names never collide with seeds. */
  nonce: string;
}

function field(value: string) {
  return { value, confidence: 0.9, reasoning: "test: extracted value" };
}

/**
 * Craft the intake extraction JSON. Resolvable entity fields use the seeded
 * Patient/Payer names; unresolvable ones use a fresh non-matching name (never
 * "unknown", to prove resolution — not mere determinability — gates linkage).
 */
function buildIntakeContent(s: Sample): string {
  const patientName = s.patientResolves
    ? KNOWN_PATIENT_NAME
    : `No Such Patient ${s.nonce}`;
  const payerName = s.payerResolves
    ? KNOWN_PAYER_NAME
    : `No Such Payer ${s.nonce}`;
  return JSON.stringify({
    patient: field(patientName),
    payer: field(payerName),
    procedureCode: field(RESOLVABLE_PROCEDURE_CODE),
    diagnosisCode: field(RESOLVABLE_DIAGNOSIS_CODE),
    denialReason: field(RESOLVABLE_DENIAL_REASON),
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

// ─── Property 53 ──────────────────────────────────────────────────────────────

describe("Property 53: patient/payer linkage set on resolve, unset otherwise (Req 2.5-2.8)", () => {
  it(
    "sets Case.patientId and the payer reference exactly when the entity resolves, tracing each that does not",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            patientResolves: fc.boolean(),
            payerResolves: fc.boolean(),
            nonce: fc.hexaString({ minLength: 6, maxLength: 12 }),
          }),
          async (s: Sample) => {
            controller.intakeContent = buildIntakeContent(s);

            const caseId = await seedCase();
            await runAgent(caseId);

            const kase = await prisma.case.findUnique({
              where: { id: caseId },
              select: { patientId: true, payerId: true, payerName: true },
            });
            expect(kase).not.toBeNull();

            const seededPatient = await prisma.patient.findFirst({
              where: { name: KNOWN_PATIENT_NAME },
              select: { id: true },
            });
            const seededPayer = await prisma.payer.findFirst({
              where: { name: KNOWN_PAYER_NAME },
              select: { id: true },
            });

            // ── (A) Patient linkage: set to matched id iff resolvable ─────────
            if (s.patientResolves) {
              expect(kase!.patientId).toBe(seededPatient!.id); // Req 2.5
            } else {
              expect(kase!.patientId).toBeNull(); // Req 2.6
            }

            // ── (B) Payer reference: set to resolved payer iff resolvable ─────
            if (s.payerResolves) {
              expect(kase!.payerId).toBe(seededPayer!.id); // Req 2.7
              expect(kase!.payerName).toBe(KNOWN_PAYER_NAME); // Req 2.7
            } else {
              expect(kase!.payerId).toBeNull(); // Req 2.8
              expect(kase!.payerName).toBeNull(); // Req 2.8
            }

            // ── (C) An unresolved Trace_Step names each entity that did not
            //        resolve, and names neither when both resolve ─────────────
            const steps = await prisma.traceStep.findMany({
              where: { caseId },
              select: { stepType: true, reasoning: true, output: true },
            });
            const unresolvedStep = steps.find(
              (st) =>
                st.stepType === "tool_call" &&
                st.reasoning.includes("Unresolved intake field(s):"),
            );

            const named = unresolvedStep
              ? (() => {
                  const out = (unresolvedStep.output ?? {}) as {
                    unresolvedFields?: unknown;
                  };
                  return Array.isArray(out.unresolvedFields)
                    ? (out.unresolvedFields as string[])
                    : [];
                })()
              : [];

            // Patient appears as unresolved exactly when it did not resolve.
            expect(named.includes(FIELD_NAME.patient)).toBe(!s.patientResolves);
            // Payer appears as unresolved exactly when it did not resolve.
            expect(named.includes(FIELD_NAME.payer)).toBe(!s.payerResolves);

            if (!s.patientResolves) {
              expect(unresolvedStep).toBeDefined();
              expect(unresolvedStep!.reasoning).toContain(FIELD_NAME.patient);
            }
            if (!s.payerResolves) {
              expect(unresolvedStep).toBeDefined();
              expect(unresolvedStep!.reasoning).toContain(FIELD_NAME.payer);
            }
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});
