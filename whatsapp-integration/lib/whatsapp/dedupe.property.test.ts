/**
 * Property test — WhatsApp dedupe is idempotent under redelivery.
 *
 * // Feature: authpilot-whatsapp, Property W2: an inbound message id is claimed at most once
 * Validates: for any sequence of claim() calls over a set of message ids, each id is
 * successfully claimed exactly once regardless of how many times it is redelivered.
 *
 * Uses an in-memory fake DurableDedupStore (no DB), matching AuthPilot's ports+fakes
 * testing discipline.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createDedupe, type DurableDedupStore } from "./dedupe";

function fakeDurable(): DurableDedupStore {
  const seen = new Set<string>();
  return {
    async claim(id) {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    async markProcessed() {},
    async release(id) {
      seen.delete(id);
    },
  };
}

describe("WhatsApp dedupe", () => {
  it("claims each message id at most once across redeliveries", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 50 }),
        async (ids) => {
          const dedupe = createDedupe(fakeDurable());
          const claimCount = new Map<string, number>();
          // Redeliver the whole list twice, interleaved.
          for (const id of [...ids, ...ids]) {
            const claimed = await dedupe.claim(id);
            if (claimed) claimCount.set(id, (claimCount.get(id) ?? 0) + 1);
          }
          for (const id of new Set(ids)) {
            expect(claimCount.get(id)).toBe(1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
