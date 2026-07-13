// =============================================================================
// lib/db.test.ts
//
// Tests for the `createTraceStep` Trace_Step persistence guard (Requirements
// 23.3, 23.6). The guard admits a Trace_Step ONLY when its `stepType` is one of
// the seven allowed values (STEP_TYPES); any other value is rejected with a
// structured error identifying the invalid type and is NOT persisted.
//
// These tests run against an isolated, throwaway PostgreSQL schema provisioned by
// `createTestDb`. Because `createTraceStep` writes through the shared `prisma`
// singleton in `lib/db.ts` (which reads DATABASE_URL when the client is built),
// we point DATABASE_URL at the throwaway schema BEFORE dynamically importing the
// module, so all persistence lands in the disposable schema and is dropped on
// cleanup.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { FC_CONFIG } from "@/lib/testConfig";
import { STEP_TYPES, type StepType } from "@/lib/types";
import { createTestDb, type TestDb } from "@/lib/testDb";

// Pure membership check mirrored locally so generators/assertions do not depend
// on the dynamically-imported module. This is exactly the seven allowed values.
const ALLOWED = new Set<string>(STEP_TYPES);
const isAllowed = (s: string): boolean => ALLOWED.has(s);

// Bound to the module under test after DATABASE_URL is repointed (see beforeAll).
type DbModule = typeof import("@/lib/db");
let db: DbModule;
let testDb: TestDb;
let caseId: string;

beforeAll(async () => {
  // 1. Provision an isolated, disposable schema with the AuthPilot schema applied.
  testDb = await createTestDb();

  // 2. Repoint DATABASE_URL at the throwaway schema so the `lib/db.ts` singleton
  //    connects there when it is constructed on import.
  process.env.DATABASE_URL = testDb.databaseUrl;

  // 3. Import AFTER repointing so `createTraceStep` persists into the test schema.
  db = await import("@/lib/db");

  // 4. Seed a Case so the TraceStep.caseId foreign key is satisfiable.
  const seededCase = await db.prisma.case.create({
    data: {
      intakeType: "denial_letter",
      rawIntakeText: "seed intake for trace-step guard tests",
      status: "New",
      slaDeadline: new Date("2026-01-15T12:00:00.000Z"),
    },
  });
  caseId = seededCase.id;
}, 120_000);

afterAll(async () => {
  await db?.prisma.$disconnect().catch(() => {});
  await testDb?.cleanup();
});

// A generic reasoning payload; the guard's decision depends only on stepType.
const REASONING = "trace step recorded by createTraceStep guard test";

describe("createTraceStep — allowed step types are accepted and persisted (Req 23.3)", () => {
  it.each(STEP_TYPES)("persists a Trace_Step for allowed step type %s", async (stepType) => {
    const result = await db.createTraceStep({ caseId, stepType, reasoning: REASONING });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.traceStep.stepType).toBe(stepType);
      // The row is really in the store.
      const row = await db.prisma.traceStep.findUnique({
        where: { id: result.traceStep.id },
      });
      expect(row).not.toBeNull();
      expect(row?.stepType).toBe(stepType);
    }
  });
});

describe("createTraceStep — disallowed step types are rejected, not persisted (Req 23.6)", () => {
  it.each([
    "Tool_Call", // wrong casing
    "toolcall", // missing underscore
    "TOOL_CALL", // upper case
    "review", // not one of the seven
    "medical", // partial
    "strategy ", // trailing space
    "verification!", // extra punctuation
    "unknown",
    "", // empty
  ])("rejects disallowed step type %j with an error naming it", async (stepType) => {
    const before = await db.prisma.traceStep.count();
    const result = await db.createTraceStep({ caseId, stepType, reasoning: REASONING });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Error indication identifies the invalid step type (Req 23.6).
      expect(result.invalidStepType).toBe(stepType);
      expect(result.error).toContain(stepType);
    }
    // Nothing was persisted for the rejected step.
    const after = await db.prisma.traceStep.count();
    expect(after).toBe(before);
  });
});

// =============================================================================
// Property 51: Trace step type restriction
// **Validates: Requirements 23.3, 23.6**
//
// For a stepType drawn from a space that spans BOTH the seven allowed values and
// arbitrary values outside them, `createTraceStep`:
//   • accepts and persists iff the stepType is one of the seven allowed values;
//   • otherwise rejects with an error that names the invalid step type and
//     persists nothing.
// =============================================================================

/** Any of the seven allowed step types. */
const allowedStepTypeArb: fc.Arbitrary<StepType> = fc.constantFrom(...STEP_TYPES);

/**
 * Values NOT in the allowed set: arbitrary strings filtered to exclude the seven
 * allowed values, plus deliberate near-miss constants (casing / spacing / partials).
 */
const disallowedStepTypeArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ maxLength: 30 }).filter((s) => !isAllowed(s)),
  fc.constantFrom(
    "Tool_Call",
    "toolcall",
    "TOOL_CALL",
    "decision ",
    " decision",
    "human",
    "human_action ",
    "review",
    "medical",
    "policy",
    "strategy_x",
    "verification!",
    "unknown",
    "",
  ),
);

/** A stepType tagged with whether it should be accepted, spanning both partitions. */
const stepTypeArb: fc.Arbitrary<{ stepType: string; expectedAllowed: boolean }> = fc.oneof(
  allowedStepTypeArb.map((stepType) => ({ stepType, expectedAllowed: true })),
  disallowedStepTypeArb.map((stepType) => ({ stepType, expectedAllowed: false })),
);

describe("Property 51: Trace step type restriction (Req 23.3, 23.6)", () => {
  // **Validates: Requirements 23.3, 23.6**
  it("accepts+persists exactly the seven allowed step types and rejects all others", async () => {
    await fc.assert(
      fc.asyncProperty(stepTypeArb, async ({ stepType, expectedAllowed }) => {
        // The guard's classification must match the seven-value allow-list.
        expect(expectedAllowed).toBe(isAllowed(stepType));

        const result = await db.createTraceStep({ caseId, stepType, reasoning: REASONING });

        if (expectedAllowed) {
          // Allowed → accepted and persisted (Req 23.3).
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.traceStep.stepType).toBe(stepType);
            const row = await db.prisma.traceStep.findUnique({
              where: { id: result.traceStep.id },
            });
            expect(row).not.toBeNull();
            expect(row?.stepType).toBe(stepType);
          }
        } else {
          // Disallowed → rejected with an error naming the invalid type (Req 23.6).
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.invalidStepType).toBe(stepType);
            expect(result.error).toContain(stepType);
          }
        }
      }),
      FC_CONFIG,
    );

    // Whole-store invariant: no invalid step type was ever persisted (Req 23.6).
    const rows = await db.prisma.traceStep.findMany({ select: { stepType: true } });
    for (const row of rows) {
      expect(isAllowed(row.stepType)).toBe(true);
    }
  }, 120_000);
});
