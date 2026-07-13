// =============================================================================
// lib/agentTools.fetchPayerPolicy.test.ts
//
// Property-based test for `fetchPayerPolicy(payerId, procedureCode)` (Task 7.3).
//
// Property 7 (design): for any stored set of payer policies and any
// (payer identifier, procedure code) query, the fetch-payer-policy tool returns
// a policy matching BOTH the payer and the procedure code when one exists, and
// no policy (null) otherwise; a returned policy always matches the requested
// payer and procedure code.
//
// `fetchPayerPolicy` queries the SHARED Prisma singleton from `lib/db.ts`. To
// exercise it against an isolated, throwaway PostgreSQL schema we bind that
// singleton (via `globalThis.prisma`, which `lib/db.ts` reads on first import)
// to the schema `createTestDb()` provisions, THEN dynamically import the tool so
// its `prisma` resolves to the test client. Each fast-check sample seeds its own
// payers/policies and cleans them up, so samples never see each other's rows.
//
// Validates: Requirements 3.2
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { createTestDb, type TestDb } from "@/lib/testDb";
import { FC_CONFIG } from "@/lib/testConfig";

// The shared-singleton shape `lib/db.ts` reads/writes on `globalThis`.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

let testDb: TestDb;
let prisma: PrismaClient;
let fetchPayerPolicy: (
  payerId: string,
  procedureCode: string,
) => Promise<{ payerId: string; procedureCode: string } | null>;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  // Bind the shared singleton to the isolated test schema BEFORE the first
  // import of `lib/db.ts` (pulled in transitively by `lib/agentTools`), so
  // `fetchPayerPolicy` queries exactly the schema we seed below.
  globalForPrisma.prisma = prisma;

  ({ fetchPayerPolicy } = await import("@/lib/agentTools"));
});

afterAll(async () => {
  await testDb.cleanup();
  delete globalForPrisma.prisma;
});

// A small pool of real-looking CPT codes to draw the "stored set" from, plus a
// sentinel code that is NEVER seeded so it is a guaranteed miss.
const CODE_POOL = ["27447", "64483", "70553", "43239"] as const;
const NEVER_SEEDED_CODE = "00000";

// Monotonic suffix so seeded payer names are distinguishable across samples.
let seedCounter = 0;

/** One generated "stored set": 1-3 payers, each with a unique subset of codes. */
const datasetArb = fc.array(
  fc.uniqueArray(fc.constantFrom(...CODE_POOL), {
    minLength: 0,
    maxLength: CODE_POOL.length,
  }),
  { minLength: 1, maxLength: 3 },
);

interface SeededPayer {
  payerId: string;
  codes: string[];
}

/** Seed the generated dataset; returns the created payers (with their codes). */
async function seedDataset(dataset: string[][]): Promise<SeededPayer[]> {
  const seeded: SeededPayer[] = [];
  for (const codes of dataset) {
    const payer = await prisma.payer.create({
      data: { name: `PBT Payer ${seedCounter++}` },
    });
    for (const code of codes) {
      await prisma.payerPolicy.create({
        data: {
          payerId: payer.id,
          policyCode: `LCD-${code}-${seedCounter}`,
          procedureCode: code,
          criteriaText: `Medical necessity criteria for procedure ${code}.`,
        },
      });
    }
    seeded.push({ payerId: payer.id, codes });
  }
  return seeded;
}

/** Remove every row created for a sample (children before parents). */
async function cleanupPayers(payerIds: string[]): Promise<void> {
  if (payerIds.length === 0) return;
  await prisma.payerPolicy.deleteMany({ where: { payerId: { in: payerIds } } });
  await prisma.payer.deleteMany({ where: { id: { in: payerIds } } });
}

describe("fetchPayerPolicy — payer policy fetch matching (Property 7)", () => {
  // Feature: authpilot, Property 7: For any stored set of payer policies and any
  // (payer identifier, procedure code) query, the fetch-payer-policy tool returns
  // a policy matching both the payer and the procedure code when one exists, and
  // no policy otherwise.
  it("returns a matching policy on a hit, null on a miss, and any returned policy matches the query", async () => {
    await fc.assert(
      fc.asyncProperty(datasetArb, async (dataset) => {
        const seeded = await seedDataset(dataset);
        const payerIds = seeded.map((p) => p.payerId);

        try {
          // HIT: every seeded (payerId, procedureCode) pair returns a policy
          // whose payer and procedure code match exactly what was requested.
          for (const { payerId, codes } of seeded) {
            for (const code of codes) {
              const result = await fetchPayerPolicy(payerId, code);
              expect(result).not.toBeNull();
              expect(result?.payerId).toBe(payerId);
              expect(result?.procedureCode).toBe(code);
            }
          }

          // MISS (payer-scoping): a code that exists overall but NOT for this
          // payer returns null — matching requires BOTH fields, not just code.
          for (const { payerId, codes } of seeded) {
            const absentForPayer = CODE_POOL.filter((c) => !codes.includes(c));
            for (const code of absentForPayer) {
              expect(await fetchPayerPolicy(payerId, code)).toBeNull();
            }
            // MISS (sentinel code never seeded anywhere).
            expect(await fetchPayerPolicy(payerId, NEVER_SEEDED_CODE)).toBeNull();
          }

          // MISS (unknown payer): a non-existent payer with a real code → null.
          const someCode = seeded.find((p) => p.codes.length > 0)?.codes[0] ?? CODE_POOL[0];
          expect(
            await fetchPayerPolicy(`no-such-payer-${seedCounter}`, someCode),
          ).toBeNull();
        } finally {
          await cleanupPayers(payerIds);
        }
      }),
      FC_CONFIG,
    );
  }, 120_000);

  // Example-based smoke test complementing the property: one seeded policy,
  // one hit and one miss, to make the core behavior obvious at a glance.
  it("returns the seeded policy for its payer+code and null for a mismatched code", async () => {
    const payer = await prisma.payer.create({
      data: { name: `PBT Payer example ${seedCounter++}` },
    });
    await prisma.payerPolicy.create({
      data: {
        payerId: payer.id,
        policyCode: "LCD L33455",
        procedureCode: "27447",
        criteriaText: "Total knee arthroplasty medical necessity criteria.",
      },
    });

    try {
      const hit = await fetchPayerPolicy(payer.id, "27447");
      expect(hit).not.toBeNull();
      expect(hit?.payerId).toBe(payer.id);
      expect(hit?.procedureCode).toBe("27447");

      expect(await fetchPayerPolicy(payer.id, "64483")).toBeNull();
    } finally {
      await cleanupPayers([payer.id]);
    }
  });
});
