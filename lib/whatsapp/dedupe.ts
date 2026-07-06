// =============================================================================
// lib/whatsapp/dedupe.ts
//
// Two-layer, at-most-once inbound WhatsApp dedupe (Requirement 31.6).
//
// Meta redelivers webhooks (at-least-once delivery). Every inbound message id
// must be processed AT MOST ONCE, consistent with the idempotency guarantees of
// Requirement 26. We use two layers keyed by the inbound WhatsApp message id:
//
//   1. A fast, process-local ring buffer (hot path) that rejects immediate
//      redeliveries without touching the database.
//   2. A durable layer backed by the `ProcessedMessage` table. The claim is
//      serialized by the unique primary key on `messageId`: the first INSERT
//      wins; a redelivery hits a unique-constraint violation and is reported as
//      already-processed. This survives process restarts and coordinates across
//      concurrent workers.
//
// The durable claim FAILS OPEN: if the store times out or throws an unexpected
// error, we treat the id as claimable (return true) so a transient fault never
// silently drops a real message. Only an explicit unique-constraint violation
// (a genuine duplicate) reports "already processed".
// =============================================================================

import { Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "../db";

const RING_CAPACITY = 2000;
const DURABLE_TIMEOUT_MS = 2000;

/** Prisma unique-constraint violation code (duplicate primary key / unique field). */
const PRISMA_UNIQUE_VIOLATION = "P2002";

/**
 * The narrow slice of the Prisma client this module needs. Declaring it as an
 * interface (rather than requiring a full `PrismaClient`) keeps the durable
 * store trivially injectable with a fake in unit tests.
 */
export interface ProcessedMessageClient {
  processedMessage: {
    create(args: {
      data: { messageId: string; status: string };
    }): Promise<unknown>;
    update(args: {
      where: { messageId: string };
      data: { status: string };
    }): Promise<unknown>;
    delete(args: { where: { messageId: string } }): Promise<unknown>;
  };
}

/** Port implemented by the durable (Prisma-backed) dedupe store. */
export interface DurableDedupStore {
  /** Atomically claim a message id. Returns true if newly claimed, false if already seen. */
  claim(messageId: string): Promise<boolean>;
  /** Mark a claimed message as fully processed. */
  markProcessed(messageId: string): Promise<void>;
  /** Release a claim so a later redelivery can retry (e.g. media download failed). */
  release(messageId: string): Promise<void>;
}

/** True iff the error is a Prisma unique-constraint violation (a genuine duplicate). */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === PRISMA_UNIQUE_VIOLATION
  );
}

/**
 * Build a durable dedupe store backed by the `ProcessedMessage` table.
 *
 * `client` is injectable and defaults to the shared prisma client from lib/db.ts
 * so production code shares the single connection pool while tests can pass a
 * fake. The claim inserts a `ProcessedMessage` row with status "claimed"; the
 * unique primary key on `messageId` guarantees only the first insert succeeds.
 * A unique-constraint violation means the id was already claimed → returns
 * false. Any other error is rethrown so the caller (createDedupe) can fail open.
 */
export function createProcessedMessageStore(
  client: ProcessedMessageClient = defaultPrisma,
): DurableDedupStore {
  return {
    async claim(messageId: string): Promise<boolean> {
      try {
        await client.processedMessage.create({
          data: { messageId, status: "claimed" },
        });
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Already claimed by an earlier delivery → this is a duplicate.
          return false;
        }
        // Unexpected store error: rethrow so the caller fails open.
        throw err;
      }
    },
    async markProcessed(messageId: string): Promise<void> {
      await client.processedMessage.update({
        where: { messageId },
        data: { status: "processed" },
      });
    },
    async release(messageId: string): Promise<void> {
      try {
        await client.processedMessage.delete({ where: { messageId } });
      } catch (err) {
        // A missing row (nothing to release) is not an error worth surfacing.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2025"
        ) {
          return;
        }
        throw err;
      }
    },
  };
}

/**
 * Resolve a durable promise within `ms`, falling back to `onTimeout` if it
 * times out OR rejects. Used to make the durable claim fail open: on any
 * timeout or unexpected error we proceed with the claim rather than dropping
 * the message. A deliberate `false` (a real duplicate) still propagates because
 * the promise resolves with `false` before the timer fires.
 */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(onTimeout);
      },
    );
  });
}

/**
 * Create a two-layer inbound dedupe.
 *
 * The `durable` store is injectable and defaults to a Prisma-backed
 * `ProcessedMessage` store using the shared client from lib/db.ts. Tests can
 * pass either a fake `DurableDedupStore` here or a fake prisma client via
 * `createProcessedMessageStore(fakePrisma)`.
 */
export function createDedupe(
  durable: DurableDedupStore = createProcessedMessageStore(),
) {
  const ring: string[] = [];
  const ringSet = new Set<string>();

  function seenRecently(id: string): boolean {
    return ringSet.has(id);
  }

  function remember(id: string): void {
    ring.push(id);
    ringSet.add(id);
    if (ring.length > RING_CAPACITY) {
      const evicted = ring.shift();
      if (evicted !== undefined) ringSet.delete(evicted);
    }
  }

  return {
    /**
     * Atomically claim a message id. Returns true if this id is newly claimed
     * and should be processed; false if it was already seen (duplicate).
     *
     * Fast path: a recent id in the in-memory ring is rejected immediately.
     * Durable path: the ProcessedMessage unique claim wins at most once per id.
     * The durable layer fails open (returns true) on timeout/error.
     */
    async claim(messageId: string): Promise<boolean> {
      if (!messageId) return true; // never block an unidentifiable message
      if (seenRecently(messageId)) return false;
      remember(messageId);
      return withTimeout(durable.claim(messageId), DURABLE_TIMEOUT_MS, true);
    },
    /** Mark a claimed message as fully processed. Fails open on store error. */
    async markProcessed(messageId: string): Promise<void> {
      if (!messageId) return;
      await withTimeout(
        durable.markProcessed(messageId),
        DURABLE_TIMEOUT_MS,
        undefined,
      );
    },
    /** Release a claim so a later redelivery can retry. Also clears the ring. */
    async release(messageId: string): Promise<void> {
      if (!messageId) return;
      ringSet.delete(messageId);
      await withTimeout(
        durable.release(messageId),
        DURABLE_TIMEOUT_MS,
        undefined,
      );
    },
  };
}

export type Dedupe = ReturnType<typeof createDedupe>;
