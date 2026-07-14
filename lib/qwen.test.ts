// =============================================================================
// lib/qwen.test.ts
//
// Property test for the Qwen_Client retry bound (Requirement 6.5).
//
// callQwen() retries ONLY transient failures with exponential backoff up to a
// 3-attempt total (original + 2 retries). This test injects a deterministic
// fake `deps` (no network, no API key, no real timers) whose transport fails a
// configurable number of consecutive times, and asserts that:
//   • the transport is invoked AT MOST 3 times regardless of how many
//     consecutive transient failures are generated, and
//   • callQwen always resolves to a structured QwenOutcome and never throws.
// =============================================================================

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  callQwen,
  classifyQwenFailure,
  type QwenDeps,
  type QwenErrorShape,
  type QwenHttpResult,
} from "@/lib/qwen";
import type { QwenFailureKind } from "@/lib/types";
import { FC_CONFIG } from "@/lib/testConfig";

const MAX_ATTEMPTS = 3;

/** A well-formed OpenAI-compatible success body callQwen can parse. */
const SUCCESS_BODY = {
  choices: [{ message: { content: "ok", tool_calls: [] } }],
};

/**
 * The transient failure modes callQwen must retry (network error + the
 * retryable HTTP statuses). Each is produced by the fake transport for the
 * first `failuresBeforeSuccess` attempts.
 */
type TransientMode = "network" | 429 | 500 | 502 | 503 | 504;

/**
 * Build a deterministic fake `deps` whose transport fails transiently the first
 * `failuresBeforeSuccess` times, then (if reached) succeeds. `sleep` is a no-op
 * so backoff introduces no real delay, and `calls` records the attempt count.
 */
function makeDeps(
  failuresBeforeSuccess: number,
  mode: TransientMode,
): { deps: QwenDeps; getCalls: () => number } {
  let calls = 0;

  const fetchImpl: QwenDeps["fetchImpl"] = async () => {
    calls += 1;
    if (calls <= failuresBeforeSuccess) {
      if (mode === "network") {
        // A transport/connection rejection → classified as transient `network`.
        throw new Error("simulated network error");
      }
      // A retryable HTTP status → transient (429 / 5xx).
      const res: QwenHttpResult = {
        ok: false,
        status: mode,
        json: async () => ({}),
      };
      return res;
    }
    const res: QwenHttpResult = {
      ok: true,
      status: 200,
      json: async () => SUCCESS_BODY,
    };
    return res;
  };

  const deps: QwenDeps = {
    apiKey: "test-key",
    apiBase: "https://qwen.test/v1",
    model: "test-model",
    attemptTimeoutMs: 1000,
    fetchImpl,
    sleep: async () => {},
    backoffBaseMs: 0,
  };

  return { deps, getCalls: () => calls };
}

describe("callQwen — retry bound (Req 6.5)", () => {
  // Feature: authpilot, Property 18: Qwen client retry bound
  // For any number of consecutive transient failures, the Qwen_Client makes at
  // most 3 total attempts (the original plus 2 retries): it succeeds if a
  // success occurs within those attempts and otherwise reports failure after
  // exactly 3 attempts.
  //
  // **Validates: Requirements 6.5**
  it("makes at most 3 attempts on transient failures and always resolves to a structured outcome", async () => {
    await fc.assert(
      fc.asyncProperty(
        // 0..12 consecutive transient failures — spans well past the 3-attempt
        // bound so the cap (not the input) is what limits attempts.
        fc.integer({ min: 0, max: 12 }),
        fc.constantFrom<TransientMode>("network", 429, 500, 502, 503, 504),
        async (failuresBeforeSuccess, mode) => {
          const { deps, getCalls } = makeDeps(failuresBeforeSuccess, mode);

          // Never throws — always resolves to a structured QwenOutcome.
          const outcome = await callQwen([{ role: "user", content: "hi" }], undefined, deps);

          // The transport is invoked at most 3 times regardless of how many
          // consecutive transient failures were generated.
          expect(getCalls()).toBeLessThanOrEqual(MAX_ATTEMPTS);

          // Result is a structured outcome discriminated by `ok`.
          expect(typeof outcome.ok).toBe("boolean");

          if (failuresBeforeSuccess < MAX_ATTEMPTS) {
            // A success occurred within the attempt budget.
            expect(outcome.ok).toBe(true);
            expect(getCalls()).toBe(failuresBeforeSuccess + 1);
          } else {
            // Transient retries exhausted → failure after exactly 3 attempts.
            expect(outcome.ok).toBe(false);
            expect(getCalls()).toBe(MAX_ATTEMPTS);
            if (!outcome.ok) {
              expect(outcome.transient).toBe(true);
              expect(outcome.attempts).toBe(MAX_ATTEMPTS);
            }
          }
        },
      ),
      FC_CONFIG,
    );
  });
});
