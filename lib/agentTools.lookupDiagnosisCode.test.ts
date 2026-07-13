// =============================================================================
// lib/agentTools.lookupDiagnosisCode.test.ts
//
// Example/unit tests for the NIH diagnosis-code lookup tool (Task 7.6).
//
//   • Happy path (Req 3.3): a well-formed NIH Clinical Tables response resolves
//     to `{ code, name, validated: true }` with the canonical name.
//   • Service-unavailable edge (Req 3.7): a thrown network error or a non-200
//     response degrades gracefully to `{ validated: false }` WITHOUT throwing.
//
// The `fetch` dependency is injected via `deps.fetchImpl` and the base URL via
// `deps.baseUrl`, so these tests never touch the real network or config.
// =============================================================================

import { describe, expect, it, vi } from "vitest";
import { lookupDiagnosisCode } from "@/lib/agentTools";

const BASE_URL = "https://clinicaltables.example/api/icd10cm/v3/search";

/**
 * Build a fake `fetch` that returns a well-formed NIH Clinical Tables payload.
 * The NIH search endpoint shape is `[total, [codes], hashOrNull, [[code, name], ...]]`.
 */
function fakeFetchReturning(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => {
    return {
      ok,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("lookupDiagnosisCode — happy path against the NIH shape (Req 3.3)", () => {
  it("returns { validated: true } with the resolved name for a well-formed NIH payload", async () => {
    // NIH ICD-10-CM response for E11.9 (Type 2 diabetes mellitus without complications).
    const nihPayload = [
      1,
      ["E11.9"],
      null,
      [["E11.9", "Type 2 diabetes mellitus without complications"]],
    ];
    const fetchImpl = fakeFetchReturning(nihPayload);

    const result = await lookupDiagnosisCode("E11.9", {
      fetchImpl,
      baseUrl: BASE_URL,
    });

    expect(result).toEqual({
      code: "E11.9",
      name: "Type 2 diabetes mellitus without complications",
      validated: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("matches the requested code among multiple returned rows (Req 3.3)", async () => {
    const nihPayload = [
      2,
      ["E11.8", "E11.9"],
      null,
      [
        ["E11.8", "Type 2 diabetes mellitus with unspecified complications"],
        ["E11.9", "Type 2 diabetes mellitus without complications"],
      ],
    ];

    const result = await lookupDiagnosisCode("E11.9", {
      fetchImpl: fakeFetchReturning(nihPayload),
      baseUrl: BASE_URL,
    });

    expect(result.validated).toBe(true);
    expect(result.code).toBe("E11.9");
    expect(result.name).toBe("Type 2 diabetes mellitus without complications");
  });
});

describe("lookupDiagnosisCode — service unavailable degrades gracefully (Req 3.7)", () => {
  it("returns { validated: false } and does NOT throw when fetch throws a network error", async () => {
    const throwingFetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED: NIH service unreachable");
    }) as unknown as typeof fetch;

    const promise = lookupDiagnosisCode("E11.9", {
      fetchImpl: throwingFetch,
      baseUrl: BASE_URL,
    });

    // It resolves rather than rejecting — the pipeline is never blocked.
    await expect(promise).resolves.toEqual({
      code: "E11.9",
      name: "",
      validated: false,
    });
  });

  it("returns { validated: false } and does NOT throw on a non-200 response", async () => {
    const fetchImpl = fakeFetchReturning(null, false, 503);

    const result = await lookupDiagnosisCode("E11.9", {
      fetchImpl,
      baseUrl: BASE_URL,
    });

    expect(result).toEqual({ code: "E11.9", name: "", validated: false });
  });
});
