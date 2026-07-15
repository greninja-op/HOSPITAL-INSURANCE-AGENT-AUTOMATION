// =============================================================================
// app/api/patients/search.filtering.test.ts
//
// Property 35 — Global search filters by patient name (Validates: Requirements 19.2).
//
// GET /api/patients/search?q=<name> powers the persistent global search box: an
// Operator types a patient name and sees the matching patients (and their linked
// Cases). The route's matching rule (see app/api/patients/search/route.ts) is a
// CASE-INSENSITIVE SUBSTRING match on the patient name, with the query trimmed
// first and a blank/whitespace-only query returning an empty set.
//
// The property: for ANY set of seeded patients and ANY query string, the set of
// patients returned by the handler is EXACTLY the set of seeded patients whose
// name case-insensitively contains the trimmed query — none missing, none extra.
// A blank/whitespace-only query yields the empty set.
//
// We compute the expected match set by hand with the same rule the route uses
// (name.toLowerCase().includes(query.trim().toLowerCase())) and assert the
// returned id set equals it.
//
// Alphabet note: generated names and queries are drawn from letters + space
// only. Prisma's `contains` compiles to Postgres ILIKE, where `%`, `_` and `\`
// are wildcards/escapes; excluding them keeps ILIKE equivalent to a plain
// case-insensitive substring test, so the hand-computed oracle matches the DB.
//
// Persistence goes through the shared `prisma` singleton in `lib/db.ts`, which
// binds to DATABASE_URL when constructed on import; we therefore provision an
// isolated throwaway schema via `createTestDb` and repoint DATABASE_URL BEFORE
// dynamically importing the route, mirroring the sibling route tests.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { FC_CONFIG } from "@/lib/testConfig";
import { createTestDb, type TestDb } from "@/lib/testDb";

// Bound after DATABASE_URL is repointed (see beforeAll).
type RouteModule = typeof import("@/app/api/patients/search/route");
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

  // 3. Import AFTER repointing so the route + shared prisma read from the test
  //    schema. The route reads the same singleton we seed through.
  db = await import("@/lib/db");
  route = await import("@/app/api/patients/search/route");
}, 120_000);

afterAll(async () => {
  await db?.prisma.$disconnect().catch(() => {});
  await testDb?.cleanup();
});

// Response shape returned by GET /api/patients/search.
interface PatientSearchResult {
  id: string;
  name: string;
}
interface PatientSearchResponse {
  query: string;
  patients: PatientSearchResult[];
}

// Letters + a space. Deliberately excludes ILIKE metacharacters (% _ \) so the
// DB substring match and the JS oracle agree exactly. Mixed case exercises the
// case-insensitivity of the match.
const NAME_CHAR = fc.constantFrom(
  "a",
  "b",
  "c",
  "A",
  "B",
  "C",
  " ",
);

// A patient name: 1–6 chars over the alphabet (Patient.name is required).
const nameArb = fc
  .array(NAME_CHAR, { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(""));

// A search query: 0–4 chars (empty exercises the blank-query branch; may be
// whitespace-only, which the route trims to empty).
const queryArb = fc
  .array(NAME_CHAR, { minLength: 0, maxLength: 4 })
  .map((chars) => chars.join(""));

/** The route's matching rule, computed independently as the oracle. */
function matches(name: string, rawQuery: string): boolean {
  const q = rawQuery.trim();
  if (q.length === 0) return false; // blank query ⇒ empty result set
  return name.toLowerCase().includes(q.toLowerCase());
}

/** Invoke the GET handler with the given query string and parse the response. */
async function search(query: string): Promise<PatientSearchResponse> {
  const url = new URL("http://localhost/api/patients/search");
  url.searchParams.set("q", query);
  const res = await route.GET(new Request(url.toString()));
  expect(res.status).toBe(200);
  return (await res.json()) as PatientSearchResponse;
}

describe("GET /api/patients/search — Property 35: global search filters by patient name (Req 19.2)", () => {
  it("returns exactly the patients whose name case-insensitively contains the trimmed query", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(nameArb, { minLength: 0, maxLength: 8 }), queryArb, async (names, query) => {
        // Isolate each run: clear rows seeded by a previous iteration. Order
        // respects FK edges (case → patient/payer, patient → payer).
        await db.prisma.case.deleteMany({});
        await db.prisma.chartNote.deleteMany({});
        await db.prisma.patient.deleteMany({});
        await db.prisma.payer.deleteMany({});

        // Patients require a payer relation; one shared payer suffices.
        const payer = await db.prisma.payer.create({
          data: { name: "Test Payer" },
          select: { id: true },
        });

        // Seed one patient per generated name (duplicate names allowed — they
        // are distinct patients with distinct ids).
        const seeded: { id: string; name: string }[] = [];
        for (const name of names) {
          const created = await db.prisma.patient.create({
            data: { name, dob: new Date("1990-01-01T00:00:00.000Z"), payerId: payer.id },
            select: { id: true, name: true },
          });
          seeded.push(created);
        }

        // Hand-computed expected match set (the oracle).
        const expectedIds = new Set(
          seeded.filter((p) => matches(p.name, query)).map((p) => p.id),
        );

        // Actual set returned by the route.
        const body = await search(query);
        const returnedIds = new Set(body.patients.map((p) => p.id));

        // EXACT match: none missing, none extra.
        expect(returnedIds).toEqual(expectedIds);

        // Sanity: every returned patient genuinely matches the rule (no extras),
        // reinforcing the set-equality above at the per-row level.
        for (const p of body.patients) {
          expect(matches(p.name, query)).toBe(true);
        }
      }),
      FC_CONFIG,
    );
  }, 300_000);
});
