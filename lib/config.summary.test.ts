/**
 * Property + example tests for the secret-free App_Configuration summary.
 *
 * Covers `redactedSummary(cfg)` in `lib/config.ts`: it maps EVERY configuration
 * key to only `"set"` or `"missing"` and its output NEVER contains any secret
 * value, so it is safe for boot logs / health output (Req 38.4).
 *
 * These are pure: the env is passed explicitly to `loadConfig(env)` and
 * `process.env` is never mutated. Run under Vitest + fast-check (≥100 runs),
 * consistent with the rest of the suite.
 *
 * Property 74: Config summary never leaks a secret.
 * **Validates: Requirements 38.4**
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { loadConfig, redactedSummary } from "./config";

const RUNS = { numRuns: 100 };

// Every key `redactedSummary` must report, independent of any secret value.
const EXPECTED_SUMMARY_KEYS = [
  "QWEN_API_KEY",
  "QWEN_API_BASE",
  "QWEN_MODEL",
  "QWEN_ATTEMPT_TIMEOUT_MS",
  "DATABASE_URL",
  "NIH_CLINICAL_TABLES_BASE",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "SARVAM_API_KEY",
] as const;

// The four WhatsApp keys, populated together (all-or-nothing group).
const WHATSAPP_KEYS = [
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
] as const;

// The fixed, non-secret tokens that legitimately appear in a summary: the key
// names plus the two allowed marker values. A generated "secret" that is a
// substring of any of these would collide with the summary's own structure and
// produce a false leak, so such values are excluded from the generator below.
// (Joined with a NUL, which fast-check's printable-ASCII strings never emit, so
// no match can straddle a boundary.)
const STRUCTURAL_TOKENS = [...EXPECTED_SUMMARY_KEYS, "set", "missing"].join("\u0000");

// Arbitrary, non-trivial secret values: non-empty after trimming (so the loader
// treats them as present) and never a substring of the summary's own structure
// (so any appearance in the output is a genuine leak, not a coincidence).
const secretArb = fc
  .string({ minLength: 1, maxLength: 64 })
  .filter((s) => s.trim() !== "" && !STRUCTURAL_TOKENS.includes(s));

interface ConfigPlan {
  qwenApiKey: string;
  databaseUrl: string;
  whatsapp?: Record<(typeof WHATSAPP_KEYS)[number], string>;
  sarvamApiKey?: string;
}

const planArb: fc.Arbitrary<ConfigPlan> = fc.record({
  qwenApiKey: secretArb,
  databaseUrl: secretArb,
  // The WhatsApp channel is all-or-nothing: either the full group or none.
  whatsapp: fc.option(
    fc.record({
      WHATSAPP_VERIFY_TOKEN: secretArb,
      WHATSAPP_APP_SECRET: secretArb,
      WHATSAPP_TOKEN: secretArb,
      WHATSAPP_PHONE_NUMBER_ID: secretArb,
    }),
    { nil: undefined },
  ),
  // The Sarvam layer is enabled iff SARVAM_API_KEY is present.
  sarvamApiKey: fc.option(secretArb, { nil: undefined }),
});

/** Build a plain, valid env from a plan (never touches process.env). */
function buildEnv(plan: ConfigPlan): {
  env: Record<string, string>;
  secrets: string[];
} {
  const env: Record<string, string> = {
    QWEN_API_KEY: plan.qwenApiKey,
    QWEN_API_BASE: "https://api.example.com/v1",
    DATABASE_URL: plan.databaseUrl,
  };
  const secrets: string[] = [plan.qwenApiKey, plan.databaseUrl];

  if (plan.whatsapp) {
    for (const k of WHATSAPP_KEYS) {
      env[k] = plan.whatsapp[k];
      secrets.push(plan.whatsapp[k]);
    }
  }
  if (plan.sarvamApiKey !== undefined) {
    env.SARVAM_API_KEY = plan.sarvamApiKey;
    secrets.push(plan.sarvamApiKey);
  }

  return { env, secrets };
}

// ─── Property 74 ───────────────────────────────────────────────────────────────

describe("Property 74: config summary never leaks a secret", () => {
  it("reports every key as only 'set'/'missing' and never emits any secret value", () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const { env, secrets } = buildEnv(plan);
        const cfg = loadConfig(env);
        const summary = redactedSummary(cfg);

        // Every expected key is present, and no unexpected keys are added.
        expect(Object.keys(summary).sort()).toEqual([...EXPECTED_SUMMARY_KEYS].sort());

        // Every reported value is strictly "set" or "missing".
        for (const value of Object.values(summary)) {
          expect(value === "set" || value === "missing").toBe(true);
        }

        // No secret value leaks anywhere in the summary (keys or values).
        const serialized = JSON.stringify(summary);
        for (const secret of secrets) {
          expect(serialized).not.toContain(secret);
        }

        // Presence markers reflect the plan (enabled groups ⇒ "set").
        const waMark = plan.whatsapp ? "set" : "missing";
        for (const k of WHATSAPP_KEYS) expect(summary[k]).toBe(waMark);
        expect(summary.SARVAM_API_KEY).toBe(
          plan.sarvamApiKey !== undefined ? "set" : "missing",
        );
      }),
      RUNS,
    );
  });
});

// ─── Anchored examples ─────────────────────────────────────────────────────────

describe("redactedSummary examples", () => {
  it("marks optional groups 'missing' and never contains the secret values", () => {
    const env = {
      QWEN_API_KEY: "sk-super-secret-key",
      QWEN_API_BASE: "https://api.example.com/v1",
      DATABASE_URL: "postgres://user:p@ssw0rd@host/db",
    };
    const summary = redactedSummary(loadConfig(env));

    expect(summary.QWEN_API_KEY).toBe("set");
    expect(summary.DATABASE_URL).toBe("set");
    expect(summary.WHATSAPP_TOKEN).toBe("missing");
    expect(summary.SARVAM_API_KEY).toBe("missing");

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("sk-super-secret-key");
    expect(serialized).not.toContain("p@ssw0rd");
  });

  it("marks the WhatsApp group 'set' when enabled without leaking token/secret", () => {
    const env = {
      QWEN_API_KEY: "qwen-key",
      QWEN_API_BASE: "https://api.example.com/v1",
      DATABASE_URL: "file:./dev.db",
      WHATSAPP_VERIFY_TOKEN: "verify-secret",
      WHATSAPP_APP_SECRET: "app-secret-value",
      WHATSAPP_TOKEN: "graph-token-value",
      WHATSAPP_PHONE_NUMBER_ID: "1234567890",
    };
    const summary = redactedSummary(loadConfig(env));

    for (const k of WHATSAPP_KEYS) expect(summary[k]).toBe("set");

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("app-secret-value");
    expect(serialized).not.toContain("graph-token-value");
    expect(serialized).not.toContain("verify-secret");
  });
});
