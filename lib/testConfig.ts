import type { Parameters as FcParameters } from "fast-check";

/**
 * Shared fast-check configuration for every property-based test in AuthPilot.
 *
 * All property tests MUST run at least 100 iterations (design: PBT ≥ 100 runs).
 * Import and spread this into `fc.assert(fc.property(...), FC_CONFIG)` so the run
 * count (and any future global tuning, e.g. a fixed seed in CI) stays consistent
 * across the whole suite.
 */
export const FC_NUM_RUNS = 100 as const;

export const FC_CONFIG: FcParameters<unknown> = {
  numRuns: FC_NUM_RUNS,
};
