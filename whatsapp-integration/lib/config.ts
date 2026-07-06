/**
 * Fail-fast, validated configuration loader.
 *
 * Pattern adopted for AuthPilot: collect required keys, fail on boot if any are missing,
 * and expose a `redactedSummary()` that logs only PRESENCE (never values) so secrets
 * never hit logs. WhatsApp keys are OPTIONAL — the app runs without the channel; when
 * present they must all be present together.
 *
 * Uses Zod (already an AuthPilot dependency). Drop this at `lib/config.ts` in the app.
 */
import { z } from "zod";

const schema = z.object({
  // Core LLM (required)
  QWEN_API_KEY: z.string().min(1),
  QWEN_API_BASE: z.string().url(),
  QWEN_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // Data (required). SQLite by default; switch provider + this URL for Postgres.
  DATABASE_URL: z.string().min(1),

  // Optional external code lookup
  NIH_CLINICAL_TABLES_BASE: z
    .string()
    .url()
    .default("https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search"),

  // WhatsApp channel (optional group — all-or-nothing when enabled)
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default("v23.0"),
  WHATSAPP_REENGAGEMENT_TEMPLATE: z.string().optional(),
  // Comma-separated E.164 numbers that are treated as staff (approve-from-WhatsApp).
  WHATSAPP_STAFF_NUMBERS: z.string().optional(),

  // Multilingual language layer (Sarvam AI) — optional. When SARVAM_API_KEY is set, the
  // WhatsApp channel detects the patient's language, translates inbound text to English for
  // the pipeline, and localizes generic outbound replies back into the patient's language.
  // Models/speaker default to current Sarvam defaults; TTS/STT are only used for voice notes.
  SARVAM_API_KEY: z.string().optional(),
  SARVAM_API_BASE: z.string().url().default("https://api.sarvam.ai"),
  SARVAM_STT_MODEL: z.string().default("saarika:v2.5"),
  SARVAM_TTS_MODEL: z.string().default("bulbul:v3"),
  SARVAM_TTS_SPEAKER: z.string().default("anushka"),
  SARVAM_TTS_MAX_CHARS: z.coerce.number().int().positive().default(2500),
  // Enable spoken (voice-note) replies for patients who send voice notes. Off by default.
  TTS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // App
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;

  // WhatsApp is all-or-nothing: if any key is set, the core four must all be set.
  const waKeys = [
    cfg.WHATSAPP_TOKEN,
    cfg.WHATSAPP_PHONE_NUMBER_ID,
    cfg.WHATSAPP_APP_SECRET,
    cfg.WHATSAPP_VERIFY_TOKEN,
  ];
  const anyWa = waKeys.some(Boolean);
  const allWa = waKeys.every(Boolean);
  if (anyWa && !allWa) {
    throw new Error(
      "WhatsApp partially configured: set all of WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, or none.",
    );
  }
  return cfg;
}

export function whatsappEnabled(cfg: AppConfig): boolean {
  return Boolean(
    cfg.WHATSAPP_TOKEN &&
      cfg.WHATSAPP_PHONE_NUMBER_ID &&
      cfg.WHATSAPP_APP_SECRET &&
      cfg.WHATSAPP_VERIFY_TOKEN,
  );
}

/** True when the Sarvam multilingual language layer is configured. */
export function languageLayerEnabled(cfg: AppConfig): boolean {
  return Boolean(cfg.SARVAM_API_KEY);
}

/** Presence-only summary for safe boot logging. Never prints secret values. */
export function redactedSummary(cfg: AppConfig): Record<string, string> {
  const present = (v: unknown) => (v ? "set" : "unset");
  return {
    QWEN_API_KEY: present(cfg.QWEN_API_KEY),
    QWEN_API_BASE: cfg.QWEN_API_BASE,
    DATABASE_URL: present(cfg.DATABASE_URL),
    whatsapp: whatsappEnabled(cfg) ? "enabled" : "disabled",
    language: languageLayerEnabled(cfg) ? "enabled" : "disabled",
    NODE_ENV: cfg.NODE_ENV,
    APP_BASE_URL: cfg.APP_BASE_URL,
  };
}
