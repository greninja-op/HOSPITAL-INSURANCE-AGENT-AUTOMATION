// =============================================================================
// lib/config.ts
//
// Fail-fast, Zod-validated App_Configuration loader (Requirement 38).
//
// `loadConfig(env)` validates every required key at once and FAILS FAST (throws)
// with a single message naming EVERY missing/invalid key — all-or-nothing, never
// one at a time (Req 38.1, 38.2). The four WhatsApp keys are an all-or-nothing
// group: the channel is enabled only when all four are present, disabled when
// none are, and a partial group is a validation error (Req 38.3). The optional
// Sarvam multilingual layer is enabled only when SARVAM_API_KEY is present.
//
// `redactedSummary(cfg)` reports only the PRESENCE ("set"/"missing") of each
// configuration key and NEVER a secret value, so it is safe for boot logs and
// health output (Req 38.4).
//
// This mirrors the schema/semantics of `whatsapp-integration/lib/config.ts` so
// the app and the WhatsApp package agree on the same configuration contract.
// =============================================================================
import { z } from "zod";

// ─── The four WhatsApp channel keys (validated all-or-nothing) ───────────────
const WHATSAPP_KEYS = [
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
] as const;

// ─── Raw environment schema ──────────────────────────────────────────────────
// Required keys have no default, so an absent/empty value is a fail-fast error.
// Keys with a default are always present in the resulting config. Optional group
// members (WhatsApp / Sarvam) are validated for presence separately below so a
// partial group can be reported alongside any other missing/invalid keys.
const EnvSchema = z.object({
  // Core LLM
  QWEN_API_KEY: z.string().min(1),
  QWEN_API_BASE: z.string().url(),
  QWEN_MODEL: z.string().min(1).default("qwen-plus"),
  QWEN_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // Data store (SQLite by default; switch provider + this URL for Postgres)
  DATABASE_URL: z.string().min(1),

  // Optional external diagnosis-code lookup (degrades gracefully when down)
  NIH_CLINICAL_TABLES_BASE: z
    .string()
    .url()
    .default("https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search"),

  // WhatsApp channel (optional group — all four together, or none)
  WHATSAPP_VERIFY_TOKEN: z.string().min(1).optional(),
  WHATSAPP_APP_SECRET: z.string().min(1).optional(),
  WHATSAPP_TOKEN: z.string().min(1).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),

  // Sarvam multilingual language layer (optional — enabled by SARVAM_API_KEY)
  SARVAM_API_KEY: z.string().min(1).optional(),
  SARVAM_API_BASE: z.string().url().default("https://api.sarvam.ai"),
  SARVAM_STT_MODEL: z.string().min(1).default("saarika:v2.5"),
  SARVAM_TTS_MODEL: z.string().min(1).default("bulbul:v3"),
  SARVAM_TTS_SPEAKER: z.string().min(1).default("anushka"),
});

// ─── Validated, structured configuration ─────────────────────────────────────

/** The WhatsApp channel block — present iff all four WhatsApp keys are set. */
export interface WhatsAppConfig {
  verifyToken: string;
  appSecret: string;
  token: string;
  phoneNumberId: string;
}

/** The Sarvam multilingual layer block — present iff SARVAM_API_KEY is set. */
export interface LanguageConfig {
  apiKey: string;
  apiBase: string;
  sttModel: string;
  ttsModel: string;
  ttsSpeaker: string;
}

/** Validated App_Configuration. Optional groups are `undefined` when disabled. */
export interface AppConfig {
  qwenApiKey: string;
  qwenApiBase: string;
  qwenModel: string;
  qwenAttemptTimeoutMs: number;
  databaseUrl: string;
  nihClinicalTablesBase: string;
  /** Present iff all four WhatsApp keys are set (channel enabled). */
  whatsapp?: WhatsAppConfig;
  /** Present iff SARVAM_API_KEY is set (multilingual layer enabled). */
  language?: LanguageConfig;
}

/** Every configuration key reported by `redactedSummary`, in report order. */
const SUMMARY_KEYS = [
  "QWEN_API_KEY",
  "QWEN_API_BASE",
  "QWEN_MODEL",
  "QWEN_ATTEMPT_TIMEOUT_MS",
  "DATABASE_URL",
  "NIH_CLINICAL_TABLES_BASE",
  ...WHATSAPP_KEYS,
  "SARVAM_API_KEY",
] as const;

/**
 * Treat empty/whitespace-only values as absent so a blank env var is reported as
 * "missing" rather than as an invalid present value. Returns a plain record of
 * only the non-empty string entries.
 */
function normalizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim() !== "") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Validate the environment and build the structured config, or FAIL FAST.
 *
 * Collects ALL problems at once — every missing/invalid required key and, when
 * the WhatsApp group is partially set, the offending group — and throws a single
 * Error naming each by name (Req 38.1, 38.2, 38.3). Never logs any value.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const normalized = normalizeEnv(env);
  const parsed = EnvSchema.safeParse(normalized);

  const errors: string[] = [];

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join(".")}: ${issue.message}`);
    }
  }

  // WhatsApp is all-or-nothing: any strict, non-empty subset is a failure.
  const presentWa = WHATSAPP_KEYS.filter((key) => normalized[key] !== undefined);
  if (presentWa.length > 0 && presentWa.length < WHATSAPP_KEYS.length) {
    const missingWa = WHATSAPP_KEYS.filter((key) => normalized[key] === undefined);
    errors.push(
      `WhatsApp channel partially configured: set all of ${WHATSAPP_KEYS.join(
        ", ",
      )}, or none. Missing: ${missingWa.join(", ")}`,
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid App_Configuration — fix the following before starting:\n${errors
        .map((e) => `  - ${e}`)
        .join("\n")}`,
    );
  }

  // Safe: errors.length === 0 implies parse succeeded.
  const d = parsed.data!;

  const cfg: AppConfig = {
    qwenApiKey: d.QWEN_API_KEY,
    qwenApiBase: d.QWEN_API_BASE,
    qwenModel: d.QWEN_MODEL,
    qwenAttemptTimeoutMs: d.QWEN_ATTEMPT_TIMEOUT_MS,
    databaseUrl: d.DATABASE_URL,
    nihClinicalTablesBase: d.NIH_CLINICAL_TABLES_BASE,
  };

  if (
    d.WHATSAPP_VERIFY_TOKEN &&
    d.WHATSAPP_APP_SECRET &&
    d.WHATSAPP_TOKEN &&
    d.WHATSAPP_PHONE_NUMBER_ID
  ) {
    cfg.whatsapp = {
      verifyToken: d.WHATSAPP_VERIFY_TOKEN,
      appSecret: d.WHATSAPP_APP_SECRET,
      token: d.WHATSAPP_TOKEN,
      phoneNumberId: d.WHATSAPP_PHONE_NUMBER_ID,
    };
  }

  if (d.SARVAM_API_KEY) {
    cfg.language = {
      apiKey: d.SARVAM_API_KEY,
      apiBase: d.SARVAM_API_BASE,
      sttModel: d.SARVAM_STT_MODEL,
      ttsModel: d.SARVAM_TTS_MODEL,
      ttsSpeaker: d.SARVAM_TTS_SPEAKER,
    };
  }

  return cfg;
}

/** True iff the WhatsApp channel is enabled (all four WhatsApp keys present). */
export function whatsappEnabled(cfg: AppConfig): boolean {
  return cfg.whatsapp !== undefined;
}

/** True iff the Sarvam multilingual language layer is configured. */
export function languageLayerEnabled(cfg: AppConfig): boolean {
  return cfg.language !== undefined;
}

/**
 * Presence-only summary for safe boot logging / health output (Req 38.4).
 *
 * Maps every configuration key to only `"set"` or `"missing"` and NEVER emits a
 * secret value. WhatsApp keys report "set" only when the whole group is present;
 * Sarvam reports "set" when the language layer is enabled.
 */
export function redactedSummary(cfg: AppConfig): Record<string, "set" | "missing"> {
  const wa = whatsappEnabled(cfg);
  const lang = languageLayerEnabled(cfg);
  const mark = (present: boolean): "set" | "missing" => (present ? "set" : "missing");

  const presence: Record<string, boolean> = {
    QWEN_API_KEY: Boolean(cfg.qwenApiKey),
    QWEN_API_BASE: Boolean(cfg.qwenApiBase),
    QWEN_MODEL: Boolean(cfg.qwenModel),
    QWEN_ATTEMPT_TIMEOUT_MS: cfg.qwenAttemptTimeoutMs != null,
    DATABASE_URL: Boolean(cfg.databaseUrl),
    NIH_CLINICAL_TABLES_BASE: Boolean(cfg.nihClinicalTablesBase),
    WHATSAPP_VERIFY_TOKEN: wa,
    WHATSAPP_APP_SECRET: wa,
    WHATSAPP_TOKEN: wa,
    WHATSAPP_PHONE_NUMBER_ID: wa,
    SARVAM_API_KEY: lang,
  };

  const summary: Record<string, "set" | "missing"> = {};
  for (const key of SUMMARY_KEYS) {
    summary[key] = mark(presence[key]);
  }
  return summary;
}

// ─── Boot singleton ───────────────────────────────────────────────────────────
let cached: AppConfig | undefined;

/**
 * Load-and-cache the configuration. Call once at boot so misconfiguration fails
 * fast and immediately; subsequent calls return the same validated instance.
 */
export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached === undefined) {
    cached = loadConfig(env);
  }
  return cached;
}
