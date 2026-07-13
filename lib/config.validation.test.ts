/**
 * Property + example tests for fail-fast, all-or-nothing App_Configuration validation.
 *
 * Covers `loadConfig(env)` in `lib/config.ts`:
 *   - it validates EVERY required key at once and fails fast (throws) rather than
 *     one at a time, and the single thrown message names EVERY offending key
 *     (Req 38.1, 38.2), and
 *   - the four WhatsApp keys are an all-or-nothing group: enabled only when all
 *     four are present, disabled when none are, and a PARTIAL group is itself a
 *     validation error reported alongside any other problems (Req 38.3).
 *
 * These are pure: the env is passed explicitly to `loadConfig(env)` and
 * `process.env` is never mutated. Run under Vitest + fast-check (≥100 runs),
 * consistent with the rest of the suite.
 *
 * Property 73: Config validation is fail-fast and all-or-nothing.
 * **Validates: Requirements 38.1, 38.2, 38.3**
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { loadConfig, whatsappEnabled } from "./config";

const RUNS = { numRuns: 100 };

// The three keys that are required with no default: absent ⇒ fail-fast error.
const REQUIRED_KEYS = ["QWEN_API_KEY", "QWEN_API_BASE", "DATABASE_URL"] as const;

// The four WhatsApp keys, validated as an all-or-nothing group.
const WHATSAPP_KEYS = [
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
] as const;

// Valid sample values for each required key (QWEN_API_BASE must be a URL).
const VALID: Record<(typeof REQUIRED_KEYS)[number], string> = {
  QWEN_API_KEY: "sk-test-key",
  QWEN_API_BASE: "https://api.example.com/v1",
  DATABASE_URL: "file:./dev.db",
};

const VALID_WA: Record<(typeof WHATSAPP_KEYS)[number], string> = {
  WHATSAPP_VERIFY_TOKEN: "verify-token",
  WHATSAPP_APP_SECRET: "app-secret",
  WHATSAPP_TOKEN: "graph-token",
  WHATSAPP_PHONE_NUMBER_ID: "1234567890",
};

// How each required key appears in a generated env.
type KeyState = "valid" | "absent" | "invalid";

interface EnvPlan {
  qwenApiKey: "valid" | "absent";
  qwenApiBase: KeyState; // the URL key can also be present-but-invalid
  databaseUrl: "valid" | "absent";
  whatsapp: { kind: "none" } | { kind: "full" } | { kind: "partial"; keys: string[] };
}

/** Build a plain env record from a plan (never touches process.env). */
function buildEnv(plan: EnvPlan): Record<string, string> {
  const env: Record<string, string> = {};

  if (plan.qwenApiKey === "valid") env.QWEN_API_KEY = VALID.QWEN_API_KEY;
  if (plan.databaseUrl === "valid") env.DATABASE_URL = VALID.DATABASE_URL;

  if (plan.qwenApiBase === "valid") env.QWEN_API_BASE = VALID.QWEN_API_BASE;
  else if (plan.qwenApiBase === "invalid") env.QWEN_API_BASE = "not-a-valid-url";
  // "absent" ⇒ leave unset

  if (plan.whatsapp.kind === "full") {
    for (const k of WHATSAPP_KEYS) env[k] = VALID_WA[k];
  } else if (plan.whatsapp.kind === "partial") {
    for (const k of plan.whatsapp.keys) env[k] = VALID_WA[k as keyof typeof VALID_WA];
  }
  // "none" ⇒ leave all four unset

  return env;
}

/** The exact set of key names the thrown message must name for a given plan. */
function offendingKeys(plan: EnvPlan): string[] {
  const offenders: string[] = [];
  if (plan.qwenApiKey === "absent") offenders.push("QWEN_API_KEY");
  if (plan.qwenApiBase !== "valid") offenders.push("QWEN_API_BASE");
  if (plan.databaseUrl === "absent") offenders.push("DATABASE_URL");
  if (plan.whatsapp.kind === "partial") {
    // The partial group reports the missing members of the group.
    for (const k of WHATSAPP_KEYS) {
      if (!plan.whatsapp.keys.includes(k)) offenders.push(k);
    }
  }
  return offenders;
}

// ─── Generators ──────────────────────────────────────────────────────────────

const whatsappArb = fc.oneof(
  fc.constant<EnvPlan["whatsapp"]>({ kind: "none" }),
  fc.constant<EnvPlan["whatsapp"]>({ kind: "full" }),
  // A strict, non-empty subset (size 1..3) ⇒ partial group.
  fc
    .subarray([...WHATSAPP_KEYS], { minLength: 1, maxLength: 3 })
    .map((keys) => ({ kind: "partial" as const, keys })),
);

const planArb: fc.Arbitrary<EnvPlan> = fc.record({
  qwenApiKey: fc.constantFrom<"valid" | "absent">("valid", "absent"),
  qwenApiBase: fc.constantFrom<KeyState>("valid", "absent", "invalid"),
  databaseUrl: fc.constantFrom<"valid" | "absent">("valid", "absent"),
  whatsapp: whatsappArb,
});

// ─── Property 73 ───────────────────────────────────────────────────────────────

describe("Property 73: config validation is fail-fast and all-or-nothing", () => {
  it("succeeds only when all required keys are valid and the WhatsApp group is full-or-empty; otherwise throws a single message naming every offending key", () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const env = buildEnv(plan);
        const offenders = offendingKeys(plan);
        const shouldSucceed = offenders.length === 0;

        if (shouldSucceed) {
          const cfg = loadConfig(env);
          // WhatsApp enabled iff the whole group was provided.
          expect(whatsappEnabled(cfg)).toBe(plan.whatsapp.kind === "full");
          return;
        }

        // Fail fast: exactly one thrown Error naming EVERY offending key.
        let thrown: unknown;
        try {
          loadConfig(env);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;

        // Every offending key is referenced (not just the first).
        for (const key of offenders) {
          expect(message).toContain(key);
        }
        // A partial WhatsApp group is reported as a group error.
        if (plan.whatsapp.kind === "partial") {
          expect(message).toContain("WhatsApp channel partially configured");
        }
      }),
      RUNS,
    );
  });
});

// ─── Anchored examples ─────────────────────────────────────────────────────────

describe("loadConfig examples", () => {
  it("accepts a complete, valid config with the WhatsApp group disabled", () => {
    const env = buildEnv({
      qwenApiKey: "valid",
      qwenApiBase: "valid",
      databaseUrl: "valid",
      whatsapp: { kind: "none" },
    });
    const cfg = loadConfig(env);
    expect(whatsappEnabled(cfg)).toBe(false);
  });

  it("enables the WhatsApp channel only when all four keys are present", () => {
    const env = buildEnv({
      qwenApiKey: "valid",
      qwenApiBase: "valid",
      databaseUrl: "valid",
      whatsapp: { kind: "full" },
    });
    expect(whatsappEnabled(loadConfig(env))).toBe(true);
  });

  it("names EVERY missing key at once (not just the first)", () => {
    const env = buildEnv({
      qwenApiKey: "absent",
      qwenApiBase: "absent",
      databaseUrl: "absent",
      whatsapp: { kind: "none" },
    });
    expect(() => loadConfig(env)).toThrow();
    try {
      loadConfig(env);
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("QWEN_API_KEY");
      expect(message).toContain("QWEN_API_BASE");
      expect(message).toContain("DATABASE_URL");
    }
  });

  it("treats a partial WhatsApp group as a validation error naming the missing members", () => {
    const env = buildEnv({
      qwenApiKey: "valid",
      qwenApiBase: "valid",
      databaseUrl: "valid",
      whatsapp: { kind: "partial", keys: ["WHATSAPP_TOKEN"] },
    });
    try {
      loadConfig(env);
      throw new Error("expected loadConfig to throw for a partial WhatsApp group");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("WhatsApp channel partially configured");
      expect(message).toContain("WHATSAPP_VERIFY_TOKEN");
      expect(message).toContain("WHATSAPP_APP_SECRET");
      expect(message).toContain("WHATSAPP_PHONE_NUMBER_ID");
    }
  });
});
