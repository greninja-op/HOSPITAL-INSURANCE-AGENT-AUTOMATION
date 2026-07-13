// =============================================================================
// lib/agentTools.fetchPatient.test.ts
//
// Property-based test for `fetchPatientRecord` (Task 7.2).
//
// Feature: authpilot
// Property 6: Patient record fetch round trip — For any stored patient with
// associated chart notes, invoking the fetch-patient-record tool with that
// patient identifier returns that same patient and exactly its associated chart
// notes (no more, no less).
//
// **Validates: Requirements 3.1**
//
// The tool (`lib/agentTools.ts`) queries through the shared `prisma` client from
// `lib/db.ts`, which lazily resolves `globalThis.prisma`. We point that global at
// an isolated throwaway PostgreSQL schema (see `lib/testDb.ts`) BEFORE importing
// the tool, so the round trip is exercised against a real, isolated database with
// no production data and no mocking.
// =============================================================================

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "@/lib/testDb";
import { FC_CONFIG } from "@/lib/testConfig";
import type { fetchPatientRecord as FetchPatientRecordFn } from "@/lib/agentTools";

type GlobalWithPrisma = { prisma?: PrismaClient };

let testDb: TestDb;
let prisma: PrismaClient;
let fetchPatientRecord: typeof FetchPatientRecordFn;

beforeAll(async () => {
  // Provision an isolated schema and expose its client as the shared instance
  // BEFORE loading the tool module, so `lib/db.ts` binds to the test schema.
  testDb = await createTestDb();
  prisma = testDb.prisma;
  (globalThis as unknown as GlobalWithPrisma).prisma = prisma;

  ({ fetchPatientRecord } = await import("@/lib/agentTools"));
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
  delete (globalThis as unknown as GlobalWithPrisma).prisma;
});

// Keep runs independent: wipe seeded rows between property iterations. Order
// respects foreign keys (chart notes → patients → payers).
afterEach(async () => {
  await prisma.chartNote.deleteMany();
  await prisma.patient.deleteMany();
  await prisma.payer.deleteMany();
});

// ─── Generators ──────────────────────────────────────────────────────────────

interface ChartNoteSpec {
  content: string;
  diagnosisCode: string;
  noteDateMs: number;
}

interface PatientSpec {
  name: string;
  dobMs: number;
  chartNotes: ChartNoteSpec[];
}

// Millisecond precision keeps Postgres DateTime and JS Date in lock-step.
const dateMsArb = fc.integer({ min: 0, max: 4_102_444_800_000 }); // 1970 → 2100

const chartNoteArb: fc.Arbitrary<ChartNoteSpec> = fc.record({
  content: fc.string({ maxLength: 200 }),
  diagnosisCode: fc.string({ minLength: 1, maxLength: 10 }),
  noteDateMs: dateMsArb,
});

const patientArb: fc.Arbitrary<PatientSpec> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 60 }),
  dobMs: dateMsArb,
  // Include patients with zero notes so the "exactly its chart notes" guarantee
  // is exercised on the empty case too.
  chartNotes: fc.array(chartNoteArb, { maxLength: 4 }),
});

// At least one patient; several so the fetch must return ONLY the target
// patient's notes and none of the co-resident patients' notes.
const patientsArb = fc.array(patientArb, { minLength: 1, maxLength: 3 });

// ─── Property 6: Patient record fetch round trip (Req 3.1) ───────────────────

describe("Property 6: Patient record fetch round trip (Req 3.1)", () => {
  // **Validates: Requirements 3.1**
  it("returns exactly the seeded patient and exactly its associated chart notes", async () => {
    await fc.assert(
      fc.asyncProperty(patientsArb, async (patientSpecs) => {
        // Seed a payer to satisfy the Patient → Payer relation.
        const payer = await prisma.payer.create({
          data: { name: "Test Payer" },
        });

        // Seed every patient with its chart notes; capture the DB-assigned ids.
        const seeded = [];
        for (const spec of patientSpecs) {
          const patient = await prisma.patient.create({
            data: {
              name: spec.name,
              dob: new Date(spec.dobMs),
              payerId: payer.id,
              chartNotes: {
                create: spec.chartNotes.map((cn) => ({
                  content: cn.content,
                  diagnosisCode: cn.diagnosisCode,
                  noteDate: new Date(cn.noteDateMs),
                })),
              },
            },
            include: { chartNotes: true },
          });
          seeded.push(patient);
        }

        // For every seeded patient, the fetch must round-trip exactly.
        for (const patient of seeded) {
          const record = await fetchPatientRecord(patient.id);

          // Exactly that patient (identity + scalar fields), and the returned
          // patient shape carries no nested chart notes.
          expect(record.patient.id).toBe(patient.id);
          expect(record.patient.name).toBe(patient.name);
          expect(record.patient.payerId).toBe(payer.id);
          expect(record.patient.dob.getTime()).toBe(patient.dob.getTime());
          expect(record.patient).not.toHaveProperty("chartNotes");

          // Exactly its chart notes — no more, no less. Compare by id set.
          const expectedIds = new Set(patient.chartNotes.map((c) => c.id));
          const actualIds = new Set(record.chartNotes.map((c) => c.id));
          expect(actualIds).toEqual(expectedIds);
          expect(record.chartNotes).toHaveLength(patient.chartNotes.length);

          // Every returned note belongs to this patient and round-trips its data.
          const byId = new Map(patient.chartNotes.map((c) => [c.id, c]));
          for (const note of record.chartNotes) {
            expect(note.patientId).toBe(patient.id);
            const original = byId.get(note.id);
            expect(original).toBeDefined();
            expect(note.content).toBe(original!.content);
            expect(note.diagnosisCode).toBe(original!.diagnosisCode);
            expect(note.noteDate.getTime()).toBe(original!.noteDate.getTime());
          }
        }

        // Reset within the run so the next iteration starts clean even though
        // afterEach only fires between top-level test cases.
        await prisma.chartNote.deleteMany();
        await prisma.patient.deleteMany();
        await prisma.payer.deleteMany();
      }),
      FC_CONFIG,
    );
  }, 120_000);
});
