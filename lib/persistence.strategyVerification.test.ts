/**
 * lib/persistence.strategyVerification.test.ts
 *
 * Property test (Task 14.12): lossless strategy/verification persistence.
 *
 * Feature: authpilot, Property 50: Strategy and verification outputs persist and
 * retrieve losslessly.
 *
 *   For ANY valid StrategyOptions and VerificationResult object, writing it to a
 *   Case's `strategyOptions` (Json) / `verificationResult` (Json) columns and
 *   reading it back — both directly via Prisma and through
 *   `GET /api/cases/[id]` — yields a DEEP-EQUAL value. No field is dropped,
 *   re-ordered away, or altered by the JSON/JSONB round-trip.
 *
 * **Validates: Requirements 23.1, 23.2, 23.4**
 *
 * Strategy: provision an isolated, throwaway PostgreSQL schema via `createTestDb`
 * and REBIND `DATABASE_URL` to it BEFORE importing `lib/db` and the Case-detail
 * route, so both the direct-read path and the `GET /api/cases/[id]` handler write
 * to and read from the same test schema. For each sample we generate a valid
 * StrategyOptions (1..5 options sorted by descending win-probability, integer
 * win-probabilities in 0..100) and a valid VerificationResult (status is "pass"
 * iff the flagged-issues list is empty, else "fail"), persist them on a fresh
 * Case, then assert:
 *   1. the value read straight back through Prisma deep-equals the written value;
 *   2. the value returned by the `GET /api/cases/[id]` handler deep-equals it too.
 *
 * Text fields use rich unicode but strip the NUL character (\u0000), which
 * PostgreSQL JSONB cannot store — that is a database limitation, not a property
 * of the round-trip, so it is excluded from the generated input space.
 *
 * Uses Vitest + fast-check (numRuns 100), consistent with the rest of the suite.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type {
  FlaggedIssue,
  FlaggedIssueType,
  FindingSeverity,
  StrategyOption,
  StrategyOptions,
  VerificationResult,
} from "./types";

let testDb: TestDb;
let prisma: PrismaClient;
let GET: typeof import("../app/api/cases/[id]/route").GET;

beforeAll(async () => {
  // Provision an isolated schema and bind the shared Prisma client to it BEFORE
  // importing `lib/db` and the route, so the GET handler and the direct reads
  // both operate on the test schema.
  testDb = await createTestDb();
  process.env.DATABASE_URL = testDb.databaseUrl;

  const db = await import("./db");
  prisma = db.prisma;

  const route = await import("../app/api/cases/[id]/route");
  GET = route.GET;
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Rich unicode text minus the NUL character. PostgreSQL JSONB rejects \u0000, so
 * excluding it keeps the generator inside the storable input space without
 * weakening the lossless-round-trip property under test.
 */
const textArb: fc.Arbitrary<string> = fc
  .fullUnicodeString({ maxLength: 60 })
  .map((s) => s.replace(/\u0000/g, ""));

const winProbabilityArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 100 });

const strategyOptionArb: fc.Arbitrary<StrategyOption> = fc.record({
  approach: textArb,
  winProbability: winProbabilityArb,
  rationale: textArb,
});

/** 1..5 options, sorted by descending win-probability (the documented shape). */
const strategyOptionsArb: fc.Arbitrary<StrategyOptions> = fc.record({
  options: fc
    .array(strategyOptionArb, { minLength: 1, maxLength: 5 })
    .map((opts) => [...opts].sort((a, b) => b.winProbability - a.winProbability)),
  usedPriorAuthHistory: fc.boolean(),
  payerTrackRecordSummary: textArb,
});

const flaggedIssueTypeArb: fc.Arbitrary<FlaggedIssueType> = fc.constantFrom(
  "unsupported_citation",
  "reference_mismatch",
  "unsupported_claim",
  "unresolved_citation",
  "verification_error",
);

const severityArb: fc.Arbitrary<FindingSeverity> = fc.constantFrom(
  "warning",
  "blocking",
);

const flaggedIssueArb: fc.Arbitrary<FlaggedIssue> = fc.record({
  type: flaggedIssueTypeArb,
  reference: textArb,
  detail: textArb,
  severity: severityArb,
});

/**
 * A valid VerificationResult: status is "pass" iff the flagged-issues list is
 * empty and "fail" otherwise (Req 22.4), so status is derived from the list.
 */
const verificationResultArb: fc.Arbitrary<VerificationResult> = fc
  .array(flaggedIssueArb, { minLength: 0, maxLength: 5 })
  .map((flaggedIssues) => ({
    status: flaggedIssues.length === 0 ? ("pass" as const) : ("fail" as const),
    flaggedIssues,
  }));

// ─── Property 50 ────────────────────────────────────────────────────────────────

describe("Case.strategyOptions / verificationResult — lossless persistence (Task 14.12, Property 50)", () => {
  it(
    "round-trips StrategyOptions and VerificationResult deep-equal via Prisma and GET /api/cases/[id]",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          strategyOptionsArb,
          verificationResultArb,
          async (strategyOptions, verificationResult) => {
            // Persist both structured fields on a fresh Case.
            const created = await prisma.case.create({
              data: {
                intakeType: "denial_letter",
                rawIntakeText: "intake",
                status: "New",
                slaDeadline: new Date("2099-01-01T00:00:00.000Z"),
                strategyOptions: strategyOptions as object,
                verificationResult: verificationResult as object,
              },
              select: { id: true },
            });

            // 1) Read straight back through Prisma — no field dropped/altered.
            const readBack = await prisma.case.findUnique({
              where: { id: created.id },
              select: { strategyOptions: true, verificationResult: true },
            });
            expect(readBack).not.toBeNull();
            expect(readBack!.strategyOptions).toEqual(strategyOptions);
            expect(readBack!.verificationResult).toEqual(verificationResult);

            // 2) Read through the Case-detail route — same lossless values
            //    surface on the API (Req 23.4).
            const res = await GET(new Request("http://localhost/"), {
              params: { id: created.id },
            });
            expect(res.status).toBe(200);
            const body = (await res.json()) as {
              strategyOptions: StrategyOptions | null;
              verificationResult: VerificationResult | null;
            };
            expect(body.strategyOptions).toEqual(strategyOptions);
            expect(body.verificationResult).toEqual(verificationResult);
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});
