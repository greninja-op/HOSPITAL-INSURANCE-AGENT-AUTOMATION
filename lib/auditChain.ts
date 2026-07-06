/**
 * lib/auditChain.ts
 *
 * Tamper-evident Audit_Chain for a Case (Requirement 25).
 *
 * Every audit event (each Trace_Step, and each Human_Action recorded as a
 * `human_action` Trace_Step) is chained by hash to the immediately preceding
 * event for its Case: each event stores the hash of the previous event
 * (`prevHash`) and its own `hash`, computed over a Canonical_Serialization of
 * the event content. The first event in a Case links to the fixed
 * `GENESIS_HASH`. Any later tampering — altered content or a rewired link — is
 * detectable by re-walking the chain.
 *
 * This module is PURE and DETERMINISTIC: no DB access, no network, no I/O. It
 * operates on plain event objects/arrays supplied by the caller (which loads the
 * ordered TraceSteps). Hashing uses Node's built-in SHA-256 so identical content
 * always produces the same hash.
 */
import { createHash } from "node:crypto";

import type { AuditVerifyResult } from "./types";

export type { AuditVerifyResult } from "./types";

/**
 * Fixed, well-known starting hash used as the `prevHash` of the first audit
 * event in a Case Audit_Chain (Req 25.2). 64 hex zeros — the width of a SHA-256
 * hex digest, so genesis is indistinguishable in shape from any real link.
 */
export const GENESIS_HASH = "0".repeat(64);

/**
 * The content of an audit event that participates in the hash — i.e. everything
 * except the chain metadata (`prevHash`/`hash`) and non-content bookkeeping
 * (`id`/`timestamp`). For a mutating change, `beforeState`/`afterState` capture
 * the changed fields so the mutation itself is part of what is hashed (Req 25.3).
 */
export interface AuditEventContent {
  /** One of the seven allowed Trace_Step types. */
  stepType: string;
  /** Present for `tool_call` events. */
  toolName?: string | null;
  /** Structured tool/step input. */
  input?: unknown;
  /** Structured tool/step output. */
  output?: unknown;
  /** Human-readable reasoning recorded with the event. */
  reasoning: string;
  /** Field values before a mutating change (Req 25.3). */
  beforeState?: unknown;
  /** Field values after a mutating change (Req 25.3). */
  afterState?: unknown;
  /** Owning Case id — binds the event to its Case so an event cannot be moved between chains undetected. */
  caseId?: string;
}

/**
 * A stored audit event as read back from the chain: its content plus the chain
 * metadata (`id`, `prevHash`, `hash`) needed to verify integrity.
 */
export interface AuditEvent extends AuditEventContent {
  /** Stable identifier used to report the first broken event (Req 25.5, 25.6). */
  id: string;
  /** Stored hash of the immediately preceding event, or GENESIS_HASH for the first. */
  prevHash: string;
  /** Stored hash of this event: sha256(prevHash + canonicalSerialize(content)). */
  hash: string;
}

// ─── Canonical serialization ─────────────────────────────────────────────────

/**
 * Deterministic, order-stable JSON encoding of an arbitrary JSON value: object
 * keys are emitted in sorted order recursively, so two structurally-equal values
 * always produce the same string regardless of original key order. `undefined`
 * and non-finite numbers are normalized to `null` so encoding never throws and
 * stays stable.
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";

  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify(value.toString());

  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
        .join(",") +
      "}"
    );
  }

  // functions, symbols, and anything else are not content — normalize to null.
  return "null";
}

/**
 * Deterministic, order-stable textual representation of an audit event's content
 * — the input to hashing (Req 25.1). Only the content fields are included (chain
 * metadata and bookkeeping are excluded), and missing optional fields are
 * normalized to `null`, so identical content always yields an identical string.
 */
export function canonicalSerialize(event: AuditEventContent): string {
  // Fixed field set; `canonicalize` sorts keys, so the ordering here is only for
  // clarity — the output is order-stable regardless.
  const content = {
    stepType: event.stepType,
    toolName: event.toolName ?? null,
    input: event.input ?? null,
    output: event.output ?? null,
    reasoning: event.reasoning,
    beforeState: event.beforeState ?? null,
    afterState: event.afterState ?? null,
    caseId: event.caseId ?? null,
  };
  return canonicalize(content);
}

/**
 * Compute an event hash: `sha256(prevHash + canonicalSerialize(content))`,
 * returned as a lowercase hex digest (Req 25.1).
 */
export function computeHash(prevHash: string, event: AuditEventContent): string {
  return createHash("sha256")
    .update(prevHash + canonicalSerialize(event))
    .digest("hex");
}

/**
 * Compute the chain hashes for an ordered list of audit-event contents. Returns a
 * new array in which each event carries its `prevHash` (the previous event's
 * `hash`, or `GENESIS_HASH` for the first, Req 25.2) and its own `hash` (Req 25.1).
 * The input contents are not mutated.
 */
export function computeChainHashes<T extends AuditEventContent>(
  events: readonly T[],
): (T & { prevHash: string; hash: string })[] {
  const result: (T & { prevHash: string; hash: string })[] = [];
  let prevHash = GENESIS_HASH;

  for (const event of events) {
    const hash = computeHash(prevHash, event);
    result.push({ ...event, prevHash, hash });
    prevHash = hash;
  }

  return result;
}

// ─── Verification ─────────────────────────────────────────────────────────────

/**
 * Re-walk an ordered list of stored audit events for a Case and re-derive each
 * hash to detect tampering (Req 25.4–25.7).
 *
 * The events MUST be supplied in chronological (chain) order — the caller loads
 * the Case's TraceSteps ordered by timestamp. This function performs no DB
 * access; it operates purely on the provided objects.
 *
 * - If a stored `prevHash` ≠ the stored `hash` of the immediately preceding event
 *   (or ≠ `GENESIS_HASH` for the first event) → chain is broken; reason
 *   `"prevhash_mismatch"` (Req 25.6).
 * - Else if the recomputed hash (over the stored `prevHash` and canonical
 *   content) ≠ the stored `hash` → chain is broken; reason `"hash_mismatch"`
 *   (Req 25.5).
 * - The FIRST (earliest) offending event is reported so tampering is localized.
 * - If neither mismatch occurs across all events → intact; `headHash` is the
 *   stored hash of the most recent event (Req 25.7). For an empty chain the chain
 *   is trivially intact and `headHash` is `GENESIS_HASH`.
 *
 * The prevHash-linkage check is evaluated before the recomputed-hash check within
 * an event: a rewired `prevHash` also changes the recomputed hash, so checking
 * linkage first yields the precise reason for a link-tampering event.
 */
export function verifyAuditChain(events: readonly AuditEvent[]): AuditVerifyResult {
  if (events.length === 0) {
    return { intact: true, headHash: GENESIS_HASH };
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const expectedPrev = i === 0 ? GENESIS_HASH : events[i - 1].hash;

    // Req 25.6 — stored prevHash must link to the previous event's stored hash.
    if (event.prevHash !== expectedPrev) {
      return {
        intact: false,
        headHash: events[events.length - 1].hash,
        firstBrokenEventId: event.id,
        reason: "prevhash_mismatch",
      };
    }

    // Req 25.5 — recomputed hash (over stored prevHash + content) must match.
    const recomputed = computeHash(event.prevHash, event);
    if (recomputed !== event.hash) {
      return {
        intact: false,
        headHash: events[events.length - 1].hash,
        firstBrokenEventId: event.id,
        reason: "hash_mismatch",
      };
    }
  }

  // Req 25.7 — no mismatch anywhere: intact, head hash is the most recent event's.
  return { intact: true, headHash: events[events.length - 1].hash };
}
