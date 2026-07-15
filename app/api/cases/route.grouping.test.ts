// =============================================================================
// app/api/cases/route.grouping.test.ts
//
// Property 28 — Dashboard grouping partitions all cases (Validates: Requirements 10.1).
//
// GET /api/cases returns the flat list of Case summaries the Dashboard groups
// into the seven Case_Status Kanban columns (New, Investigating,
// NeedsHumanInput, AwaitingApproval, AppealSent, Resolved, DeniedFinal). That
// grouping must be a PARTITION of the full set of cases: every case appears in
// exactly ONE column, and the union of all columns equals the complete set of
// returned cases — none lost, none duplicated.
//
// For ANY seeded set of cases spread across all statuses, we call the GET
// handler directly and reconstruct the by-status grouping the Dashboard performs,
// then assert the partition:
//   • sum of the seven group sizes === total number of cases,
//   • every case id appears in exactly one group (no duplicates), and
//   • the union of the groups' ids equals the full set of returned ids, which in
//     turn equals the set of seeded ids (nothing lost, nothing invented).
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
import type { CaseStatus } from "@/lib/types";

// The seven — and only seven — Case_Status Kanban columns (Req 10.1).
const CASE_STATUSES = [
  "New",
  "Investigating",
  "NeedsHumanInput",
  "AwaitingApproval",
  "AppealSent",
  "Resolved",
  "DeniedFinal",
] as const satisfies readonly CaseStatus[];

// Bound after DATABASE_URL is repointed (see beforeAll).
type RouteModule = typeof import("@/app/api/cases/route");
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
  route = await import("@/app/api/cases/route");
}, 120_000);

afterAll(async () => {
  await db?.prisma.$disconnect().catch(() => {});
  await testDb?.cleanup();
});

/** One Case summary as returned by GET /api/cases. */
interface CaseSummary {
  id: string;
  status: CaseStatus;
}

/**
 * Group summaries by status into the seven Kanban columns exactly as the
 * Dashboard does. Every column exists (possibly empty); each case lands in the
 * single column named by its own status.
 */
function groupByStatus(
  summaries: CaseSummary[],
): Record<CaseStatus, CaseSummary[]> {
  const groups = Object.fromEntries(
    CASE_STATUSES.map((s) => [s, [] as CaseSummary[]]),
  ) as Record<CaseStatus, CaseSummary[]>;
  for (const summary of summaries) {
    groups[summary.status].push(summary);
  }
  return groups;
}

describe("GET /api/cases — Property 28: dashboard grouping partitions all cases (Req 10.1)", () => {
  it("groups every case into exactly one status column with none lost or duplicated", async () => {
    await fc.assert(
      fc.asyncProperty(
        // A set of cases spread across ALL statuses: each entry carries a status
        // drawn from the seven columns. minLength 0 covers the empty board.
        fc.array(fc.constantFrom<CaseStatus>(...CASE_STATUSES), {
          minLength: 0,
          maxLength: 25,
        }),
        async (statuses) => {
          // Isolate each run: clear any cases seeded by a previous iteration.
          await db.prisma.case.deleteMany({});

          // Seed one Case per generated status (spanning all statuses). Only the
          // columns the fields the summary/grouping needs are required; patient
          // is optional so we omit the relation.
          const seededIds = new Set<string>();
          for (const status of statuses) {
            const created = await db.prisma.case.create({
              data: {
                intakeType: "denial_letter",
                rawIntakeText: "seeded case for grouping partition test",
                status,
                slaDeadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
              },
              select: { id: true },
            });
            seededIds.add(created.id);
          }

          // Call the GET handler directly and read the flat summary list.
          const res = await route.GET();
          expect(res.status).toBe(200);
          const summaries = (await res.json()) as CaseSummary[];

          // The returned set must be exactly the seeded set (nothing lost/invented).
          const returnedIds = new Set(summaries.map((s) => s.id));
          expect(returnedIds).toEqual(seededIds);

          // Reconstruct the Dashboard's by-status grouping.
          const groups = groupByStatus(summaries);
          const groupSizes = CASE_STATUSES.map((s) => groups[s].length);

          // PARTITION — sum of group sizes equals the total number of cases.
          const totalInGroups = groupSizes.reduce((a, b) => a + b, 0);
          expect(totalInGroups).toBe(summaries.length);
          expect(totalInGroups).toBe(seededIds.size);

          // PARTITION — every case id appears in EXACTLY one group (no dupes),
          // and the union of all groups equals the full set of returned ids.
          const unionIds = new Set<string>();
          for (const status of CASE_STATUSES) {
            for (const summary of groups[status]) {
              // Each case sits in the column named by its own status.
              expect(summary.status).toBe(status);
              // Appears for the first time here ⇒ no duplication across groups.
              expect(unionIds.has(summary.id)).toBe(false);
              unionIds.add(summary.id);
            }
          }
          expect(unionIds).toEqual(seededIds);
        },
      ),
      FC_CONFIG,
    );
  }, 300_000);
});
