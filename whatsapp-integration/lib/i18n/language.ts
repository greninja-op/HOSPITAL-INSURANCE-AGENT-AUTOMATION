/**
 * Multilingual language layer (Sarvam AI) — AuthPilot's WhatsApp language-switching engine.
 *
 * This is the SINGLE primary speech/translation/detection path for the WhatsApp channel. A
 * patient can message AuthPilot in their own language; this layer:
 *
 *   1. DETECTS the language of inbound text — deterministic, network-free SCRIPT detection first
 *      (Devanagari, Tamil, Telugu, …), refining romanized/ambiguous Latin-script input via Sarvam
 *      `/text-lid` only when needed.
 *   2. TRANSLATES inbound patient text to English (`en-IN`) so the deterministic router and the
 *      nine-stage pipeline understand every supported language (`/translate`).
 *   3. LOCALIZES the generic, PHI-free outbound reply back into the patient's language, mirroring
 *      their register (formal vs code-mixed) so the reply reads naturally (`/translate`).
 *   4. Optionally transcribes voice notes (`speech-to-text`, saarika) and synthesizes spoken
 *      replies (`text-to-speech`, bulbul) when TTS is enabled.
 *
 * Design rules mirrored from the config's fail-fast philosophy:
 *   - EVERY network call goes through one injectable HTTP port ({@link SarvamFetchLike}, defaulting
 *     to the global `fetch`) so tests drive success/failure with no real network and no API key.
 *   - No silent wrong-provider fallback: on any Sarvam failure a method returns `null`/`undefined`.
 *     Callers (the router) decide how to degrade — typically by sending the English base text so a
 *     patient never receives silence.
 *   - The API key is sent only as the `api-subscription-key` header and is NEVER logged; audit
 *     entries carry a short, non-secret reason only.
 */

/** The 8s per-request timeout for every Sarvam call (matches the sender/media budget). */
export const SARVAM_TIMEOUT_MS = 8_000;

/** Default Sarvam REST base URL. Overridable for tests / self-hosted gateways. */
export const SARVAM_BASE_URL = "https://api.sarvam.ai";

/** The translation register/mode Sarvam `/translate` supports. */
export type TranslateMode = "formal" | "code-mixed" | "modern-colloquial" | "classic-colloquial";

/** The subset of `fetch` the language layer uses; the global `fetch` satisfies it. */
export type SarvamFetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Synthesized speech bytes ready to upload to Meta `/media` and send as a voice note. */
export interface SynthesizedSpeech {
  readonly buffer: Buffer;
  readonly mimeType: string;
}

/** A credential-safe audit entry describing a Sarvam failure. Never carries the API key. */
export interface LanguageAuditEntry {
  readonly op: "stt" | "translate" | "text_lid" | "tts";
  /** A short, non-secret description of what went wrong. */
  readonly reason: string;
}

/** The result of a speech-to-text call. */
export interface SttResult {
  /** The native transcript (in the spoken language). */
  readonly text: string;
  /** The detected spoken language as a BCP-47 code (e.g. `hi-IN`), when reported. */
  readonly language?: string | undefined;
}

/** The Sarvam language-layer surface. Every method fails to `null`/`undefined` (no fallback). */
export interface LanguageLayer {
  /** Transcribe audio natively (saarika) + spoken-language id. `null` on failure. */
  speechToText(
    audio: { buffer: Buffer; mimeType: string },
    languageHint?: string,
  ): Promise<SttResult | null>;
  /**
   * Detect the language of `text` as a BCP-47 code. Script-based first (deterministic, no
   * network); uses `/text-lid` only for romanized/ambiguous Latin-script input.
   */
  detectLanguage(text: string): Promise<string>;
  /** Translate arbitrary patient text to English (`en-IN`) so the pipeline can understand it. */
  translateToEnglish(text: string, sourceLanguage?: string): Promise<string | null>;
  /** Translate an English reply into the patient's language + register/mode. */
  translateFromEnglish(
    text: string,
    targetLanguage: string,
    mode?: TranslateMode,
  ): Promise<string | null>;
  /** Translate text line-by-line, preserving the original layout. */
  translateLines(
    lines: readonly string[],
    targetLanguage: string,
    mode?: TranslateMode,
  ): Promise<string[] | null>;
  /** Synthesize `text` to mp3 voice (bulbul). Returns bytes + MIME or `null`. */
  textToSpeech(text: string, language: string): Promise<SynthesizedSpeech | null>;
}

/** Injectable dependencies + tunables for {@link createLanguageLayer}. */
export interface LanguageLayerDeps {
  /** `SARVAM_API_KEY` used as the `api-subscription-key` header. Never logged. */
  readonly apiKey: string;
  /** STT model, e.g. `saarika:v2.5`. */
  readonly sttModel: string;
  /** TTS model, e.g. `bulbul:v3`. */
  readonly ttsModel: string;
  /** TTS speaker voice, e.g. `anushka`. */
  readonly ttsSpeaker: string;
  /** Max characters to synthesize (long replies are truncated to this before TTS). */
  readonly ttsMaxChars?: number;
  /** HTTP port (default: global `fetch`). Injected in tests to drive success/failure. */
  readonly fetch?: SarvamFetchLike;
  /** Base URL (default {@link SARVAM_BASE_URL}). */
  readonly baseUrl?: string;
  /** Per-request timeout in ms (default {@link SARVAM_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** Audit sink invoked on every failure path. Default: no-op. */
  readonly onAudit?: (entry: LanguageAuditEntry) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Script-based language detection (pure, deterministic, no network)
// ---------------------------------------------------------------------------

/** Unicode script ranges → BCP-47 language code, for the supported languages. */
const SCRIPT_RANGES: ReadonlyArray<{ readonly lang: string; readonly re: RegExp }> = [
  { lang: "ta-IN", re: /[\u0B80-\u0BFF]/ }, // Tamil
  { lang: "te-IN", re: /[\u0C00-\u0C7F]/ }, // Telugu
  { lang: "kn-IN", re: /[\u0C80-\u0CFF]/ }, // Kannada
  { lang: "ml-IN", re: /[\u0D00-\u0D7F]/ }, // Malayalam
  { lang: "bn-IN", re: /[\u0980-\u09FF]/ }, // Bengali
  { lang: "gu-IN", re: /[\u0A80-\u0AFF]/ }, // Gujarati
  { lang: "pa-IN", re: /[\u0A00-\u0A7F]/ }, // Gurmukhi (Punjabi)
  { lang: "or-IN", re: /[\u0B00-\u0B7F]/ }, // Odia
  // Devanagari covers BOTH Hindi and Marathi; resolved to Hindi by script alone and
  // disambiguated by /text-lid when needed.
  { lang: "hi-IN", re: /[\u0900-\u097F]/ }, // Devanagari (Hindi/Marathi)
  // International scripts. Japanese kana is checked before CJK so a Japanese sentence
  // (kana + kanji) resolves to Japanese, not Chinese.
  { lang: "ja", re: /[\u3040-\u30FF]/ }, // Hiragana + Katakana (Japanese)
  { lang: "ko", re: /[\uAC00-\uD7AF\u1100-\u11FF]/ }, // Hangul (Korean)
  { lang: "zh", re: /[\u4E00-\u9FFF]/ }, // CJK ideographs (Chinese)
  { lang: "ar", re: /[\u0600-\u06FF\u0750-\u077F]/ }, // Arabic
  { lang: "th", re: /[\u0E00-\u0E7F]/ }, // Thai
  { lang: "ru", re: /[\u0400-\u04FF]/ }, // Cyrillic (Russian)
];

/** True when `text` contains any non-Latin script character we recognize. */
function hasNonLatinScript(text: string): boolean {
  return SCRIPT_RANGES.some((entry) => entry.re.test(text));
}

/**
 * Deterministic, network-free language detection from the dominant script. Returns a BCP-47
 * code, or `en-IN` when the text is pure Latin script (which may still be romanized Indic — the
 * caller can refine via {@link LanguageLayer.detectLanguage}). Pure and exported for testing.
 */
export function detectLanguageByScript(text: string): string {
  if (typeof text !== "string" || text.trim().length === 0) return "en-IN";
  for (const entry of SCRIPT_RANGES) {
    if (entry.re.test(text)) return entry.lang;
  }
  return "en-IN";
}

/**
 * Detect code-mixing: native non-Latin script AND Latin letters in the same message. Drives the
 * `code-mixed` vs `formal` translate mode for register mirroring. Pure.
 */
export function isCodeMixed(text: string): boolean {
  if (typeof text !== "string") return false;
  return hasNonLatinScript(text) && /[A-Za-z]/.test(text);
}

/** Normalize a possibly-bare language code (e.g. `hi`) to a BCP-47 form (`hi-IN`). */
export function toBcp47(language: string): string {
  if (typeof language !== "string" || language.trim().length === 0) return "en-IN";
  const trimmed = language.trim();
  if (trimmed.includes("-")) return trimmed;
  const lower = trimmed.toLowerCase();
  return lower === "en" ? "en-IN" : `${lower}-IN`;
}

/**
 * Map a BCP-47 code to the exact code Sarvam expects. Sarvam uses `od-IN` for Odia (whereas the
 * ISO/registry code is `or-IN`), so we remap it here for every Sarvam request. Pure.
 */
export function toSarvamCode(language: string): string {
  const bcp = toBcp47(language);
  return bcp === "or-IN" ? "od-IN" : bcp;
}

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

/** Default characters above which a TTS input is truncated (keep voice replies short). */
const DEFAULT_TTS_MAX_CHARS = 2500;

/**
 * Build a {@link LanguageLayer} over the given dependencies. Pure construction — no environment or
 * network access happens until a method is called.
 */
export function createLanguageLayer(deps: LanguageLayerDeps): LanguageLayer {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as SarvamFetchLike);
  const baseUrl = deps.baseUrl ?? SARVAM_BASE_URL;
  const timeoutMs = deps.timeoutMs ?? SARVAM_TIMEOUT_MS;
  const onAudit = deps.onAudit ?? (() => {});
  const ttsMaxChars = deps.ttsMaxChars ?? DEFAULT_TTS_MAX_CHARS;
  const apiKeyHeader = { "api-subscription-key": deps.apiKey };

  async function audit(entry: LanguageAuditEntry): Promise<void> {
    try {
      await onAudit(entry);
    } catch {
      // Auditing must never break the fail-safe path.
    }
  }

  /** POST JSON to a Sarvam endpoint with the timeout; returns parsed JSON or `null`. */
  async function postJson(
    path: string,
    body: Record<string, unknown>,
    op: LanguageAuditEntry["op"],
  ): Promise<unknown | null> {
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: { ...apiKeyHeader, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        await audit({ op, reason: `sarvam ${path} returned status ${res.status}` });
        return null;
      }
      return await res.json();
    } catch (error) {
      await audit({ op, reason: `sarvam ${path} failed: ${describeError(error)}` });
      return null;
    }
  }

  async function speechToText(
    audio: { buffer: Buffer; mimeType: string },
    languageHint?: string,
  ): Promise<SttResult | null> {
    if (audio === null || audio === undefined || audio.buffer.length === 0) {
      await audit({ op: "stt", reason: "absent or empty audio" });
      return null;
    }
    try {
      const form = new FormData();
      form.append("model", deps.sttModel);
      // With a hint, lock to that language; without one, ask saarika to AUTO-DETECT ("unknown")
      // so any spoken language is transcribed natively and its detected language is returned.
      form.append(
        "language_code",
        languageHint !== undefined && languageHint.length > 0
          ? toSarvamCode(languageHint)
          : "unknown",
      );
      const blob = new Blob([new Uint8Array(audio.buffer)], { type: audio.mimeType });
      form.append("file", blob, "audio");
      const res = await fetchImpl(`${baseUrl}/speech-to-text`, {
        method: "POST",
        headers: { ...apiKeyHeader },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        await audit({ op: "stt", reason: `sarvam /speech-to-text returned status ${res.status}` });
        return null;
      }
      const json = (await res.json()) as { transcript?: unknown; language_code?: unknown } | null;
      const text = typeof json?.transcript === "string" ? json.transcript.trim() : "";
      if (text.length === 0) return null; // No intelligible transcript → ask to resend.
      const language =
        typeof json?.language_code === "string" && json.language_code.length > 0
          ? json.language_code
          : undefined;
      return { text, language };
    } catch (error) {
      await audit({ op: "stt", reason: `sarvam /speech-to-text failed: ${describeError(error)}` });
      return null;
    }
  }

  async function detectLanguage(text: string): Promise<string> {
    // (1) Script-based first — deterministic, no network.
    if (typeof text !== "string" || text.trim().length === 0) return "en-IN";
    if (hasNonLatinScript(text)) {
      // Devanagari may be Hindi or Marathi; refine via /text-lid when present.
      const byScript = detectLanguageByScript(text);
      if (byScript === "hi-IN") {
        const refined = await textLid(text);
        return refined ?? byScript;
      }
      return byScript;
    }
    // (2) Pure Latin script: may be English or ROMANIZED Indic — disambiguate via /text-lid.
    const refined = await textLid(text);
    return refined ?? "en-IN";
  }

  /** Call Sarvam `/text-lid` and return a BCP-47 code, or `null` on failure. */
  async function textLid(text: string): Promise<string | null> {
    const json = (await postJson("/text-lid", { input: text }, "text_lid")) as {
      language_code?: unknown;
    } | null;
    const code = json?.language_code;
    return typeof code === "string" && code.length > 0 ? toBcp47(code) : null;
  }

  async function translate(
    text: string,
    source: string,
    target: string,
    mode: TranslateMode,
  ): Promise<string | null> {
    if (typeof text !== "string" || text.length === 0) return text;
    // Same source/target (e.g. English→English) needs no translation.
    if (source === target) return text;
    const json = (await postJson(
      "/translate",
      {
        input: text,
        source_language_code: source,
        target_language_code: target,
        mode,
        numerals_format: "international",
      },
      "translate",
    )) as { translated_text?: unknown } | null;
    const out = json?.translated_text;
    return typeof out === "string" ? out : null;
  }

  async function translateToEnglish(text: string, sourceLanguage?: string): Promise<string | null> {
    const source = sourceLanguage !== undefined ? toSarvamCode(sourceLanguage) : "auto";
    return translate(text, source, "en-IN", "formal");
  }

  async function translateFromEnglish(
    text: string,
    targetLanguage: string,
    mode: TranslateMode = "formal",
  ): Promise<string | null> {
    const target = toSarvamCode(targetLanguage);
    if (target === "en-IN") return text; // No-op when already English.
    return translate(text, "en-IN", target, mode);
  }

  async function translateLines(
    lines: readonly string[],
    targetLanguage: string,
    mode: TranslateMode = "formal",
  ): Promise<string[] | null> {
    const target = toSarvamCode(targetLanguage);
    if (target === "en-IN") return [...lines];
    const out: string[] = [];
    for (const line of lines) {
      // Preserve blank lines verbatim so the message layout is kept.
      if (line.trim().length === 0) {
        out.push(line);
        continue;
      }
      const translated = await translate(line, "en-IN", target, mode);
      if (translated === null) return null; // A failed line fails the batch (no fallback).
      out.push(translated);
    }
    return out;
  }

  async function textToSpeech(text: string, language: string): Promise<SynthesizedSpeech | null> {
    if (typeof text !== "string" || text.trim().length === 0) return null;
    const target = toSarvamCode(language);
    const input = text.length > ttsMaxChars ? text.slice(0, ttsMaxChars) : text;
    const json = (await postJson(
      "/text-to-speech",
      {
        text: input,
        target_language_code: target,
        speaker: deps.ttsSpeaker,
        model: deps.ttsModel,
        // Request MP3: the REST default is WAV, which Meta rejects for WhatsApp audio messages.
        output_audio_codec: "mp3",
      },
      "tts",
    )) as { audios?: unknown } | null;
    const audios = json?.audios;
    if (!Array.isArray(audios) || audios.length === 0 || typeof audios[0] !== "string") {
      await audit({ op: "tts", reason: "sarvam /text-to-speech returned no audio" });
      return null;
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(audios[0], "base64");
    } catch {
      await audit({ op: "tts", reason: "sarvam /text-to-speech returned undecodable audio" });
      return null;
    }
    if (buffer.length === 0) return null;
    return { buffer, mimeType: "audio/mpeg" };
  }

  return {
    speechToText,
    detectLanguage,
    translateToEnglish,
    translateFromEnglish,
    translateLines,
    textToSpeech,
  };
}

/** A short, non-secret description of a thrown error for audit reasons. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError" ? "timeout" : error.name;
  }
  return "unknown error";
}

// ---------------------------------------------------------------------------
// Composite layer: Sarvam for Indian languages + English, Qwen for international
// ---------------------------------------------------------------------------

/** The international (non-Indian) language base codes routed to the Qwen layer, not Sarvam. */
const INTERNATIONAL_BASE_CODES: ReadonlySet<string> = new Set([
  "es",
  "fr",
  "de",
  "pt",
  "it",
  "nl",
  "ru",
  "ja",
  "ko",
  "zh",
  "ar",
  "tr",
  "vi",
  "id",
  "pl",
  "th",
]);

/**
 * True when `code` is one of the international languages routed to the Qwen layer (Spanish,
 * French, …, Thai). Everything else (the `xx-IN` Indian languages + English) routes to Sarvam.
 * Pure.
 */
export function isInternationalLanguage(code: string | undefined): boolean {
  if (typeof code !== "string" || code.trim().length === 0) return false;
  const base = code.trim().toLowerCase().split("-")[0] ?? code;
  return INTERNATIONAL_BASE_CODES.has(base);
}

/**
 * Build a {@link LanguageLayer} that DISPATCHES by language: Indian languages (+ English) go to the
 * Sarvam layer (`indic`), the international languages go to the Qwen layer (`intl`). It exposes the
 * exact same surface, so the router uses it unchanged. Pure construction.
 */
export function createCompositeLanguageLayer(parts: {
  readonly indic: LanguageLayer;
  readonly intl: LanguageLayer;
}): LanguageLayer {
  const { indic, intl } = parts;
  return {
    async speechToText(audio, languageHint) {
      // Route by the caller's language; the provider still auto-detects the actually-spoken one.
      return isInternationalLanguage(languageHint)
        ? intl.speechToText(audio)
        : indic.speechToText(audio, languageHint);
    },
    async detectLanguage(text) {
      // Script detection (in the Sarvam layer) already covers Indian + international scripts.
      return indic.detectLanguage(text);
    },
    async translateToEnglish(text, sourceLanguage) {
      const src = sourceLanguage ?? detectLanguageByScript(text);
      return isInternationalLanguage(src)
        ? intl.translateToEnglish(text, sourceLanguage)
        : indic.translateToEnglish(text, sourceLanguage);
    },
    async translateFromEnglish(text, targetLanguage, mode) {
      return isInternationalLanguage(targetLanguage)
        ? intl.translateFromEnglish(text, targetLanguage, mode)
        : indic.translateFromEnglish(text, targetLanguage, mode);
    },
    async translateLines(lines, targetLanguage, mode) {
      return isInternationalLanguage(targetLanguage)
        ? intl.translateLines(lines, targetLanguage, mode)
        : indic.translateLines(lines, targetLanguage, mode);
    },
    async textToSpeech(text, language) {
      return isInternationalLanguage(language)
        ? intl.textToSpeech(text, language)
        : indic.textToSpeech(text, language);
    },
  };
}

// ---------------------------------------------------------------------------
// Config-bound factory
// ---------------------------------------------------------------------------

import { type AppConfig, loadConfig } from "../config";
import { createInternationalLanguageLayer } from "./internationalLanguage";

/**
 * Build a {@link LanguageLayer} from AuthPilot's validated config. Returns `null` when the Sarvam
 * language layer is not configured (`SARVAM_API_KEY` unset) so the channel runs English-only.
 * When Sarvam IS configured, this returns a COMPOSITE layer: Sarvam handles the Indian languages +
 * English, and the Qwen-backed international layer handles the foreign languages (Spanish, French,
 * German, …, Thai). `fetch`, `baseUrl`, `timeoutMs`, and `onAudit` may be overridden (e.g. injected
 * in tests). No real key is required to CONSTRUCT — only to call.
 */
export function createLanguageLayerFromConfig(
  overrides: Partial<
    Pick<LanguageLayerDeps, "fetch" | "baseUrl" | "timeoutMs" | "onAudit">
  > & { config?: AppConfig } = {},
): LanguageLayer | null {
  const cfg = overrides.config ?? loadConfig();
  if (!cfg.SARVAM_API_KEY) return null;
  const indic = createLanguageLayer({
    apiKey: cfg.SARVAM_API_KEY,
    sttModel: cfg.SARVAM_STT_MODEL,
    ttsModel: cfg.SARVAM_TTS_MODEL,
    ttsSpeaker: cfg.SARVAM_TTS_SPEAKER,
    ttsMaxChars: cfg.SARVAM_TTS_MAX_CHARS,
    baseUrl: overrides.baseUrl ?? cfg.SARVAM_API_BASE,
    fetch: overrides.fetch,
    timeoutMs: overrides.timeoutMs,
    onAudit: overrides.onAudit,
  });
  // International languages go to the Qwen LLM (Sarvam does not cover them).
  const intl = createInternationalLanguageLayer({
    apiKey: cfg.QWEN_API_KEY,
    apiBase: cfg.QWEN_API_BASE,
    model: cfg.QWEN_MODEL,
    fetch: overrides.fetch,
    onAudit: overrides.onAudit,
  });
  return createCompositeLanguageLayer({ indic, intl });
}
