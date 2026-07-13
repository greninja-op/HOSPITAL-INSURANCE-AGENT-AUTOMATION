/**
 * lib/idempotency.property.test.ts
 *
 * Property test (Task 23.10): idempotent mutating operations.
 *
 * Feature: authpilot, Property 61: Mutating operations are idempotent under a
 * repeated key — for any operation guarded by `withIdempotency`, invoking it N
 * times with the SAME client-supplied Idempotency_Key executes the underlying
 * effect EXACTLY ONCE and every call returns the identical stored result;
 * operations guarded by DISTINCT keys execute independently.
 *
 * Strategy: provision an isolated PostgreSQL schema (via `createTestDb`) because
 * idempotency keys are persisted through Prisma. Generate a set of operations,
 * each with a distinct key and a repeat count. Each operation is backed by a
 * counter-based fake `fn` that increments an execution counter and returns a
 * result derived from that counter. If the guard ever re-executed the effect for
 * a repeated key, the counter (and therefore a later return value) would change —
 * so asserting exactly-once execution and identical returns proves idempotency.
 *
 * The `withIdempotency` client is injectable, so we pass the test-schema Prisma
 * client directly; no shared-module env rebinding is required.
 *
 * Uses Vitest + fast-check (numRuns 100), consistent with the rest of the suite.
 *
 * Validates: Requirements 26.2, 26.3, 26.4, 26.5
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import { withIdempotency } from "./idempotency";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

/** One guarded operation: a unique key plus how many times it is invoked. */
interface OpSpec {
  key: string;
  callCount: number;
}

const opArb: fc.Arbitrary<OpSpec> = fc.record({
  key: fc.string({ minLength: 1, maxLength: 40 }),
  // 1..6 invocations per key; >1 exercises the replay path (Req 26.3).
  callCount: fc.integer({ min: 1, max: 6 }),
});

// 1..5 operations, keys forced distinct so cross-key independence is exercised.
const opsArb: fc.Arbitrary<OpSpec[]> = fc.uniqueArray(opArb, {
  minLength: 1,
  maxLength: 5,
  selector: (o) => o.key,
});

describe("withIdempotency — idempotent mutating operations (Task 23.10, Property 61)", () => {
  it("executes the effect exactly once per key, replays the identical result, and treats distinct keys independently", async () => {
    await fc.assert(
      fc.asyncProperty(opsArb, async (ops) => {
        // Fresh slate each run so keys from a prior run cannot pre-satisfy a claim.
        await prisma.idempotencyKey.deleteMany({});

        // Per-key execution counters incremented only when the underlying effect
        // actually runs. Exactly-once ⇒ every counter ends at 1.
        const execCounts = new Map<string, number>();

        // Build an interleaved schedule of (opIndex) invocations: repeating each
        // key `callCount` times, then interleaving, so replays for one key are
        // separated by other keys' calls — a realistic retry ordering.
        const schedule: number[] = [];
        const remaining = ops.map((o) => o.callCount);
        let pending = remaining.reduce((a, b) => a + b, 0);
        while (pending > 0) {
          for (let i = 0; i < ops.length; i++) {
            if (remaining[i] > 0) {
              schedule.push(i);
              remaining[i] -= 1;
              pending -= 1;
            }
          }
        }

        // Collect every returned result per key to assert they are all identical.
        const returnsByKey = new Map<string, unknown[]>();

        for (const i of ops.keys()) {
          returnsByKey.set(ops[i].key, []);
        }

        for (const i of schedule) {
          const op = ops[i];
          const result = await withIdempotency(
            op.key,
            `case_${i}`,
            "test_op",
            async () => {
              // The effect: bump this key's execution counter and return a
              // value derived from it. A re-execution would yield a different
              // `execAt`, which the identical-result assertion would catch.
              const next = (execCounts.get(op.key) ?? 0) + 1;
              execCounts.set(op.key, next);
              return { key: op.key, execAt: next };
            },
            prisma,
          );
          returnsByKey.get(op.key)!.push(result);
        }

        // Exactly-once execution and identical replays for every key.
        for (const op of ops) {
          // The effect ran exactly once regardless of how many times invoked.
          expect(execCounts.get(op.key)).toBe(1);

          const results = returnsByKey.get(op.key)!;
          expect(results.length).toBe(op.callCount);

          // Every returned result equals the stored first-execution result.
          const expected = { key: op.key, execAt: 1 };
          for (const r of results) {
            expect(r).toEqual(expected);
          }

          // Persisted store holds exactly one row for the key (the at-most-once claim).
          const stored = await prisma.idempotencyKey.findUnique({
            where: { key: op.key },
          });
          expect(stored).not.toBeNull();
          expect(stored!.result).toEqual(expected);
        }

        // Distinct keys executed independently: one persisted row per distinct key.
        const total = await prisma.idempotencyKey.count();
        expect(total).toBe(ops.length);
      }),
      FC_CONFIG,
    );
  }, 300_000);
});
