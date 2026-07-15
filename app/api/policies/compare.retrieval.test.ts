// =============================================================================
// app/api/policies/compare.retrieval.test.ts
//
// Property 34 — Policy comparison retrieves per-payer criteria
// (Validates: Requirements 17.1).
//
// GET /api/policies/compare?procedureCode=CPT retrieves the matching
// Payer_Policy criteria for a procedure code across payers. For ANY procedure
// code, the comparison must return EXACTLY the payers that have a policy for
// that code — each carrying its OWN criteria — with no payer missing and none
// extra, and with the correct per-payer criteria mapping.
//
// Persistence goes through the shared `prisma` singleton in `lib/db.ts`, which
// binds to DATABASE_URL when constructed on import. We therefore provision an
// isolated throwaway schema via `createTestDb` and repoint DATABASE_URL BEFORE
// dynamically importing the route, so every seeded Payer/PayerPolicy lands in
// the disposable schema and the route reads back through the same singleton.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { FC_CONFIG } from "@/lib/testConfig";
import { createTestDb, type TestDb } from "@/lib/testDb";

// Bound after DATABASE_URL is repointed (see beforeAll).
type RouteModule = typeof import("@/app/api/policies/compare/route");
type DbModule = typeof import("@/lib/db");

let testDb: TestDb;
let route: RouteModule;
let db: DbModule;

beforeAll(async () => {
  // 1. Provision an isolated, disposable schema with the AuthPilot schema applied.
  testDb = await createTestDb();

  // 2. Repoint DATABASE_URL at the throwaway schema so the `lib/db.ts` singleton
  //    (used by the route) connects there when it is constructed on import.
  process.env.DATABASE_URL = testDb.databaseUrl;

  // 3. Import AFTER repointing so the route + shared prisma read/write the test schema.
  db = await import("@/lib/db");
  route = await import("@/app/api/policies/compare/route");
}, 120_000);

afterAll(async () => {
  await db?.prisma.$disconnect().catch(() => {});
  await testDb?.cleanup();
});

/** A small pool of CPT-like procedure codes so payers overlap on some codes. */
const PROCEDURE_CODES = ["27447", "29881", "43239", "64483", "99999"] as const;

/** Build a GET request for the compare route carrying the given procedure code. */
function compareRequest(procedureCode: string): Request {
  const url = `http://localhost/api/policies/compare?procedureCode=${encodeURIComponent(
    procedureCode,
  )}`;
  return new Request(url);
}

/** One seeded policy for a payer. */
interface SeedPolicy {
  procedureCode: string;
  policyCode: string;
  criteriaText: string;
}

/** One seeded payer with zero or more policies. */
interface SeedPayer {
  name: string;
  policies: SeedPolicy[];
}

const policyArb: fc.Arbitrary<SeedPolicy> = fc.record({
  procedureCode: fc.constantFrom(...PROCEDURE_CODES),
  policyCode: fc.string({ minLength: 1, maxLength: 12 }),
  criteriaText: fc.string({ minLength: 0, maxLength: 40 }),
});

const payerArb: fc.Arbitrary<SeedPayer> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 20 }),
  // A payer may have no policies at all (⇒ must never appear in any comparison).
  policies: fc.array(policyArb, { minLength: 0, maxLength: 4 }),
});

describe("GET /api/policies/compare — Property 34: retrieves per-payer criteria (Req 17.1)", () => {
  it("returns EXACTLY the payers with a policy for the code, each with its own criteria", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(payerArb, { minLength: 1, maxLength: 5 }),
        fc.constantFrom(...PROCEDURE_CODES),
        async (payers, queryCode) => {
          // Seed payers + their policies, tracking the DB ids we assign so we can
          // build the exact expected set for the queried procedure code.
          const created: {
            payerId: string;
            policy: SeedPolicy;
          }[] = [];
          const createdPayerIds: string[] = [];

          try {
            for (const p of payers) {
              const payer = await db.prisma.payer.create({ data: { name: p.name } });
              createdPayerIds.push(payer.id);
              for (const pol of p.policies) {
                await db.prisma.payerPolicy.create({
                  data: {
                    payerId: payer.id,
                    policyCode: pol.policyCode,
                    procedureCode: pol.procedureCode,
                    criteriaText: pol.criteriaText,
                  },
                });
                created.push({ payerId: payer.id, policy: pol });
              }
            }

            const res = await route.GET(compareRequest(queryCode));
            expect(res.status).toBe(200);
            const payload = (await res.json()) as {
              procedureCode: string;
              policies: {
                payerId: string;
                policyCode: string;
                procedureCode: string;
                criteriaText: string;
              }[];
            };

            expect(payload.procedureCode).toBe(queryCode);

            // Expected: exactly the seeded policies whose procedureCode matches.
            // Each entry maps a payer to ITS OWN criteria — no cross-contamination.
            const expected = created
              .filter((c) => c.policy.procedureCode === queryCode)
              .map((c) => ({
                payerId: c.payerId,
                policyCode: c.policy.policyCode,
                procedureCode: c.policy.procedureCode,
                criteriaText: c.policy.criteriaText,
              }));

            const actual = payload.policies.map((e) => ({
              payerId: e.payerId,
              policyCode: e.policyCode,
              procedureCode: e.procedureCode,
              criteriaText: e.criteriaText,
            }));

            // Order-independent exact-set comparison (none missing, none extra,
            // correct per-payer criteria mapping).
            const sortKey = (e: (typeof expected)[number]) =>
              `${e.payerId}\u0000${e.policyCode}\u0000${e.criteriaText}`;
            const sortFn = (
              a: (typeof expected)[number],
              b: (typeof expected)[number],
            ) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0);

            expect([...actual].sort(sortFn)).toEqual([...expected].sort(sortFn));

            // Every returned entry must carry the queried code (no extra codes).
            for (const e of payload.policies) {
              expect(e.procedureCode).toBe(queryCode);
            }
          } finally {
            // Isolate iterations: remove this run's rows before the next sample.
            await db.prisma.payerPolicy.deleteMany({
              where: { payerId: { in: createdPayerIds } },
            });
            await db.prisma.payer.deleteMany({
              where: { id: { in: createdPayerIds } },
            });
          }
        },
      ),
      FC_CONFIG,
    );
  }, 300_000);
});
