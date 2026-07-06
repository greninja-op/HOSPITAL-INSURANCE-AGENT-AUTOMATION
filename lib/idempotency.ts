// =============================================================================
// lib/idempotency.ts
//
// Idempotency store for AuthPilot mutating operations (Requirement 26).
//
// Every mutating operation — appeal submission, appeal approval, Case_Outcome
// recording, and stage-advancing status writes — carries a client-supplied
// Idempotency_Key and must take effect AT MOST ONCE. `withIdempotency` is the
// single guard those operations run through:
//
//   - First-seen key  → run `fn` exactly once, store its result together with
//                        the key in the `IdempotencyKey` model, and return it
//                        (Req 26.1, 26.2).
//   - Replayed key    → return the STORED original result WITHOUT re-running
//                        `fn`, so the effect is applied at most once across all
//                        retries with that key (Req 26.3, 26.4, 26.5).
//
// The claim is serialized on the unique `IdempotencyKey.key` (primary key): if
// two invocations with the same key race, at most one `create` succeeds; the
// loser catches Prisma's unique-constraint violation (P2002) and replays the
// stored result rather than double-applying the effect.
// =============================================================================

import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "./db";

/**
 * The minimal Prisma surface `withIdempotency` needs. Declaring it structurally
 * (rather than requiring the full `PrismaClient`) keeps the client injectable
 * for testing — a fake exposing just `idempotencyKey.findUnique`/`create`
 * satisfies it. The real `PrismaClient` from `lib/db.ts` is the default.
 */
export interface IdempotencyClient {
  idempotencyKey: {
    findUnique: PrismaClient["idempotencyKey"]["findUnique"];
    create: PrismaClient["idempotencyKey"]["create"];
  };
}

/** Prisma's unique-constraint-violation error code. */
const UNIQUE_VIOLATION = "P2002";

/**
 * Narrow an unknown error to Prisma's known-request-error for a unique
 * constraint violation (P2002) on the Idempotency_Key claim.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === UNIQUE_VIOLATION
  );
}

/**
 * Run a mutating operation at most once per client-supplied Idempotency_Key.
 *
 * On the first call for `key`, executes `fn`, persists its result in the
 * `IdempotencyKey` model (keyed by `key`, tagged with `caseId`/`operation`),
 * and returns the result. On any retry with the same `key`, returns the stored
 * original result WITHOUT re-executing `fn`, guaranteeing the operation effect
 * is applied at most once (Requirement 26).
 *
 * The result must be JSON-serializable — it is stored in and replayed from the
 * `IdempotencyKey.result` Json column.
 *
 * @param key - The client-supplied Idempotency_Key that identifies the operation.
 * @param caseId - The Case the operation acts on (stored for audit/traceability).
 * @param operation - The operation label, e.g. "approve" | "submit" | "appeal_won" | "advance".
 * @param fn - The mutating effect to run at most once; its result is stored and replayed.
 * @param client - Prisma client (defaults to the shared `lib/db.ts` instance); injectable for tests.
 * @returns The freshly computed result on first use, or the stored original result on a replay.
 */
export async function withIdempotency<T>(
  key: string,
  caseId: string,
  operation: string,
  fn: () => Promise<T>,
  client: IdempotencyClient = defaultPrisma,
): Promise<T> {
  // Fast path for the common sequential retry: a previously processed key
  // replays its stored result without ever touching `fn` (Req 26.3).
  const existing = await client.idempotencyKey.findUnique({ where: { key } });
  if (existing) {
    return existing.result as T;
  }

  // First-seen key: apply the effect exactly once, then persist its result.
  const result = await fn();

  try {
    await client.idempotencyKey.create({
      data: {
        key,
        caseId,
        operation,
        // The result is stored verbatim in the Json column and replayed as-is.
        result: result as unknown as Prisma.InputJsonValue,
      },
    });
    return result;
  } catch (error) {
    // A racing invocation with the same key won the claim between our
    // findUnique and create. Rather than double-apply, replay the STORED
    // original result so both invocations agree on one outcome (Req 26.3).
    if (isUniqueViolation(error)) {
      const stored = await client.idempotencyKey.findUnique({ where: { key } });
      if (stored) {
        return stored.result as T;
      }
    }
    throw error;
  }
}
