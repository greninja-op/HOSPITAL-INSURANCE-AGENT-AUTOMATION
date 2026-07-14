/**
 * Property test — Case_Status transitions obey the allowed-transition table.
 *
 * // Feature: authpilot, Property 63: Status transitions obey the allowed-transition table
 * Validates: Requirements 28.1, 28.2, 28.3, 28.4, 28.5
 *
 * For any (from-status, to-status) pair drawn from the full CaseStatus x CaseStatus
 * space, `assertTransition` accepts the transition if and only if the to-status is
 * in the implementation's allowed set for the from-status (or it is a same-state
 * request); a rejected (illegal) transition leaves the status unchanged and returns
 * a message identifying the illegal transition; a same-state request is an idempotent
 * no-op success leaving the status unchanged; and every outgoing transition from a
 * terminal status to a different status is rejected.
 *
 * The allowed edges are read from the implementation's own ALLOWED_TRANSITIONS table
 * rather than re-declared here, so the test tracks the real API.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { CaseStatus } from "./types";
import {
  ALLOWED_TRANSITIONS,
  TERMINAL_STATUSES,
  assertTransition,
} from "./caseStatus";

// The full CaseStatus universe, derived from the implementation's own table so
// the generator enumerates exactly the statuses the guard knows about.
const ALL_STATUSES = Object.keys(ALLOWED_TRANSITIONS) as CaseStatus[];

const anyStatus = fc.constantFrom<CaseStatus>(...ALL_STATUSES);

describe("Case_Status transition table (Property 63)", () => {
  it("accepts exactly the edges in the implementation's transition table and rejects all others", () => {
    fc.assert(
      fc.property(anyStatus, anyStatus, (from, to) => {
        const result = assertTransition(from, to);
        const isAllowedEdge = ALLOWED_TRANSITIONS[from].includes(to);
        const isSameState = to === from;

        if (isSameState) {
          // Req 28.3 — same-state is an idempotent no-op success, status unchanged.
          expect(result.ok).toBe(true);
          expect(result.noop).toBe(true);
          expect(result.status).toBe(from);
        } else if (isAllowedEdge) {
          // Req 28.1 — allowed transition succeeds and advances to `to`.
          expect(result.ok).toBe(true);
          expect(result.status).toBe(to);
        } else {
          // Req 28.2/28.4/28.5 — illegal transition is rejected, status unchanged,
          // with a message identifying the illegal transition.
          expect(result.ok).toBe(false);
          expect(result.status).toBe(from);
          expect(typeof result.message).toBe("string");
          expect(result.message).toContain(from);
          expect(result.message).toContain(to);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("acceptance is iff: allowed edges never reject and disallowed differing edges always reject", () => {
    fc.assert(
      fc.property(anyStatus, anyStatus, (from, to) => {
        const result = assertTransition(from, to);
        const accepted = result.ok;
        const shouldAccept =
          to === from || ALLOWED_TRANSITIONS[from].includes(to);
        expect(accepted).toBe(shouldAccept);
      }),
      { numRuns: 100 },
    );
  });

  it("every outgoing transition from a terminal status to a different status is rejected (Req 28.4/28.5)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<CaseStatus>(...(TERMINAL_STATUSES as CaseStatus[])),
        anyStatus,
        (from, to) => {
          const result = assertTransition(from, to);
          if (to === from) {
            // Same-state is still an idempotent no-op success.
            expect(result.ok).toBe(true);
            expect(result.status).toBe(from);
          } else {
            expect(result.ok).toBe(false);
            expect(result.status).toBe(from);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
