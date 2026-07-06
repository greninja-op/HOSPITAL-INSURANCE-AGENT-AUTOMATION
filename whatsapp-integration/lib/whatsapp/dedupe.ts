/**
 * WhatsApp webhook dedupe / idempotency.
 *
 * Meta redelivers webhooks (at-least-once). Every inbound message id must be processed
 * at most once. Two layers:
 *   1. An in-memory ring for the hot path (fast reject of immediate redeliveries).
 *   2. A durable Prisma-backed store (`ProcessedMessage`) that survives restarts and
 *      serializes concurrent claims via a unique constraint on `messageId`.
 *
 * The durable claim FAILS OPEN: if the store times out or throws, we treat the message
 * as claimable (better to risk a rare double-process than to silently drop a real
 * message). This aligns with AuthPilot's idempotency requirement — the ProcessedMessage
 * table shares the same "at most once" guarantee as the Idempotency_Key store.
 */

const RING_CAPACITY = 2000;
const DURABLE_TIMEOUT_MS = 2000;

/** Port implemented by a Prisma adapter (see prisma/whatsapp.prisma → ProcessedMessage). */
export interface DurableDedupStore {
  /** Atomically claim a message id. Returns true if newly claimed, false if already seen. */
  claim(messageId: string): Promise<boolean>;
  /** Mark a claimed message as fully processed. */
  markProcessed(messageId: string): Promise<void>;
  /** Release a claim so a later redelivery can retry (e.g. media download failed). */
  release(messageId: string): Promise<void>;
}

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

export function createDedupe(durable: DurableDedupStore) {
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
    /** Returns true if this id is newly claimed and should be processed. */
    async claim(messageId: string): Promise<boolean> {
      if (!messageId) return true; // never block an unidentifiable message
      if (seenRecently(messageId)) return false;
      remember(messageId);
      // Fail open: on durable timeout/throw we proceed with the claim.
      return withTimeout(durable.claim(messageId), DURABLE_TIMEOUT_MS, true);
    },
    async markProcessed(messageId: string): Promise<void> {
      if (!messageId) return;
      await withTimeout(durable.markProcessed(messageId), DURABLE_TIMEOUT_MS, undefined);
    },
    async release(messageId: string): Promise<void> {
      if (!messageId) return;
      ringSet.delete(messageId);
      await withTimeout(durable.release(messageId), DURABLE_TIMEOUT_MS, undefined);
    },
  };
}

export type Dedupe = ReturnType<typeof createDedupe>;
