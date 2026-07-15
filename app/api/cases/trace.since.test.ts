// =============================================================================
// app/api/cases/trace.since.test.ts
//
// Property 29 — Trace-since returns only newer steps (Validates: Requirements 11.3).
//
// GET /api/cases/[id]/trace supports an optional `since` filter. For ANY `since`
// value, the returned steps must be EXACTLY those Trace_Steps whose timestamp is
// strictly newer (>) than `since` — none older or equal included, none newer
// omitted — and they must be returned in chronological (ascending) order
// (the route filters with Prisma `gt` and orders `timestamp: "asc"`).
//
// Persistence goes through the shared `prisma` singleton in `lib/db.ts`, which
// binds to DATABASE_URL when constructed on import. We therefore provision an
// isolated throwaway schema via `createTestDb` and repoint DATABASE_URL BEFORE
// dynamically importing the route, so every seeded Case/TraceStep lands in the
// disposable schema and the route reads back through the same singleton.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { NextRequest } from "next/server";
import { FC_CONFIG } from "@/lib/testConfig";
import { createTestDb, type TestDb } from "@/lib/testDb";

// Bound after DATABASE_URL is repointed (see beforeAll).
type RouteModule = typeof import("@/app/api/cases/[id]/trace/route");
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
  route = await import("@/app/api/cases/[id]/trace/route");
}, 120_000);

afterAll(async () => {
  await db?.prisma.$disconnect().catch(() => {});
  await testDb?.cleanup();
});

/** Fixed base epoch for generated timestamps: 2026-01-01T00:00:00.000Z. */
const BASE_EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
/** Milliseconds per offset unit — 1s spacing keeps timestamps clean and distinct. */
const STEP_MS = 1_000;

/** Build a GET request carrying the given `since` query value (ISO or absent). */
function traceRequest(caseId: string, since?: string): NextRequest {
  const base = `http://localhost/api/cases/${caseId}/trace`;
  const url = since === undefined ? base : `${base}?since=${encodeURIComponent(since)}`;
  return new NextRequest(url);
}

describe("GET /api/cases/[id]/trace — Property 29: trace-since returns only newer steps (Req 11.3)", () => {
  it("returns EXACTLY the steps strictly newer than `since`, in chronological order", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Distinct offset units (⇒ distinct timestamps) for a handful of steps.
        fc.uniqueArray(fc.integer({ min: 0, max: 1_000 }), {
          minLength: 1,
          maxLength: 8,
        }),
        // A `since` offset spanning before/at/between/after the step timestamps,
        // so the strict-boundary (equality excluded) case is exercised.
        fc.integer({ min: -5, max: 1_005 }),
        async (offsets, sinceOffset) => {
          // Seed a Case (slaDeadline has no default ⇒ must be supplied).
          const createdCase = await db.prisma.case.create({
            data: {
              intakeType: "denial_letter",
              rawIntakeText: "seed intake",
              status: "Investigating",
              slaDeadline: new Date(BASE_EPOCH + 10_000 * STEP_MS),
            },
          });

          try {
            // Seed one Trace_Step per offset at a distinct timestamp.
            for (let i = 0; i < offsets.length; i++) {
              await db.prisma.traceStep.create({
                data: {
                  caseId: createdCase.id,
                  stepType: "decision",
                  reasoning: `step ${i}`,
                  prevHash: `prev-${i}`,
                  hash: `hash-${i}`,
                  timestamp: new Date(BASE_EPOCH + offsets[i] * STEP_MS),
                },
              });
            }

            const sinceDate = new Date(BASE_EPOCH + sinceOffset * STEP_MS);
            const res = await route.GET(traceRequest(createdCase.id, sinceDate.toISOString()), {
              params: { id: createdCase.id },
            });
            expect(res.status).toBe(200);
            const payload = (await res.json()) as { steps: { timestamp: string }[] };

            // Expected: timestamps strictly greater than `since`, ascending.
            const expected = offsets
              .map((o) => BASE_EPOCH + o * STEP_MS)
              .filter((ms) => ms > sinceDate.getTime())
              .sort((a, b) => a - b);

            const actual = payload.steps.map((s) => new Date(s.timestamp).getTime());

            // Exact set AND order — none older/equal included, none newer omitted.
            expect(actual).toEqual(expected);
          } finally {
            // Isolate iterations: remove this run's rows before the next sample.
            await db.prisma.traceStep.deleteMany({ where: { caseId: createdCase.id } });
            await db.prisma.case.delete({ where: { id: createdCase.id } });
          }
        },
      ),
      FC_CONFIG,
    );
  }, 300_000);
});
