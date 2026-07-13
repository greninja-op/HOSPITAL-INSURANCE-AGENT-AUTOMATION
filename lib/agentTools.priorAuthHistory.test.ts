/**
 * lib/agentTools.priorAuthHistory.test.ts
 *
 * Property test (Task 7.4): prior-auth history isolation.
 *
 * Feature: authpilot, Property 8: Prior-auth history isolation — for any
 * patient, the prior-auth-history tool returns exactly the Cases belonging to
 * that patient and no Cases belonging to any other patient.
 *
 * Strategy: seed a fresh, isolated PostgreSQL schema (via `createTestDb`) with
 * several patients — each owning its own generated set of Cases — then, for
 * every seeded patient, assert that `checkPriorAuthHistory(patientId)` returns
 * exactly that patient's Case ids and never any Case belonging to a different
 * patient.
 *
 * The function under test uses the shared Prisma client from `lib/db.ts`, so we
 * point `DATABASE_URL` at the throwaway test schema BEFORE importing the module
 * (via dynamic import in `beforeAll`), ensuring both seeding and the tool query
 * hit the same isolated data.
 *
 * Uses Vitest + fast-check (numRuns 100), consistent with the rest of the suite.
 *
 * Validates: Requirements 3.4
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";

let testDb: TestDb;
let prisma: PrismaClient;
let checkPriorAuthHistory: typeof import("./agentTools").checkPriorAuthHistory;

beforeAll(async () => {
  // Provision an isolated schema, then bind the shared Prisma client to it so
  // the tool-under-test reads the same data we seed. Env must be set BEFORE the
  // dynamic import that constructs the shared PrismaClient in lib/db.ts.
  testDb = await createTestDb();
  process.env.DATABASE_URL = testDb.databaseUrl;

  const agentTools = await import("./agentTools");
  checkPriorAuthHistory = agentTools.checkPriorAuthHistory;

  const db = await import("./db");
  prisma = db.prisma;
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

/**
 * A single patient's worth of seed data: a name/payer plus a set of Cases,
 * each described by the minimal fields required by the Case model.
 */
interface PatientSeed {
  name: string;
  caseCount: number;
}

const patientSeedArb: fc.Arbitrary<PatientSeed> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 24 }),
  // 0..5 Cases per patient — include the empty-history case (Req 3.4).
  caseCount: fc.integer({ min: 0, max: 5 }),
});

// 2..5 patients so isolation is exercised across multiple owners.
const patientsArb: fc.Arbitrary<PatientSeed[]> = fc.array(patientSeedArb, {
  minLength: 2,
  maxLength: 5,
});

describe("checkPriorAuthHistory — prior-auth history isolation (Task 7.4, Property 8)", () => {
  it("returns exactly a patient's own Cases and never another patient's Cases", async () => {
    await fc.assert(
      fc.asyncProperty(patientsArb, async (patientSeeds) => {
        // Fresh slate each run: remove any Cases/Patients from prior runs.
        // Cases reference Patient, so delete Cases first.
        await prisma.case.deleteMany({});
        await prisma.patient.deleteMany({});
        await prisma.payer.deleteMany({});

        // A single shared payer keeps required Patient.payerId satisfied
        // without affecting the patient-scoped isolation under test.
        const payer = await prisma.payer.create({
          data: { name: "Test Payer" },
        });

        // Seed each patient with its own Cases; track expected ownership.
        const expectedByPatient = new Map<string, Set<string>>();
        const allCaseIds = new Set<string>();

        for (const seed of patientSeeds) {
          const patient = await prisma.patient.create({
            data: {
              name: seed.name,
              dob: new Date("1990-01-01T00:00:00.000Z"),
              payerId: payer.id,
            },
          });

          const owned = new Set<string>();
          for (let i = 0; i < seed.caseCount; i++) {
            const created = await prisma.case.create({
              data: {
                patientId: patient.id,
                intakeType: "new_pa_request",
                rawIntakeText: `raw intake ${i}`,
                status: "New",
                slaDeadline: new Date("2099-01-01T00:00:00.000Z"),
              },
            });
            owned.add(created.id);
            allCaseIds.add(created.id);
          }
          expectedByPatient.set(patient.id, owned);
        }

        // Isolation assertion: each patient's query returns exactly its own
        // Case ids and nothing belonging to a different patient.
        for (const [patientId, ownedIds] of expectedByPatient) {
          const history = await checkPriorAuthHistory(patientId);
          const returnedIds = history.map((c) => c.id);

          // No duplicates in the result set.
          expect(new Set(returnedIds).size).toBe(returnedIds.length);

          // Exactly the patient's own Cases (set equality).
          expect(new Set(returnedIds)).toEqual(ownedIds);

          // Explicitly: no returned Case belongs to any other patient.
          for (const id of returnedIds) {
            expect(ownedIds.has(id)).toBe(true);
            expect(allCaseIds.has(id)).toBe(true);
          }
        }
      }),
      FC_CONFIG,
    );
  }, 300_000);
});
