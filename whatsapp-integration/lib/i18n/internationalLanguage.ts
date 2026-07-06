/**
 * International-language layer (Qwen-backed).
 *
 * Sarvam covers the Indian languages + English extremely well, but not the common INTERNATIONAL
 * languages (Spanish, French, German, Portuguese, Japanese, Korean, Italian, Dutch, Russian,
 * Chinese, Arabic, Turkish, Vietnamese, Indonesian, Polish, Thai). This layer fills that gap using
 * AuthPilot's existing Qwen LLM over its OpenAI-compatible chat-completions endpoint, exposing the
 * EXACT SAME {@link LanguageLayer} surface so it is a drop-in half of the composite layer
 * ({@link createCompositeLanguageLayer}).
 *
 * It handles TRANSLATION only (both directions + line-preserving). Speech in/out for these
 * languages is out of scope for the demo, so `speechToText`/`textToSpeech` return `null` (the
 * caller keeps the already-sent text reply). Like the Sarvam layer, every method fails safe to
 * `null`/`undefined` — never a silent wrong result — and the API key is never logged.
 */
import {
  detectLanguageByScript,
  type LanguageAuditEntry,
  type LanguageLayer,
  type SarvamFetchLike,
  type SynthesizedSpeech,
  type SttResult,
  type TranslateMode,
} from "./language";

/** Default per-request timeout for a translation call. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Base-code → human language name, used to instruct the model precisely. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
  ru: "Russian",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese (Simplified)",
  ar: "Arabic",
  tr: "Turkish",
  vi: "Vietnamese",
  id: "Indonesian",
  pl: "Polish",
  th: "Thai",
};

/** Map any BCP-47 / bare code to a human language name for the prompt (falls back to the code). */
export function languageName(code: string | undefined): string {
  if (typeof code !== "string" || code.trim().length === 0) return "English";
  const base = code.trim().toLowerCase().split("-")[0] ?? code;
  return LANGUAGE_NAMES[base] ?? code;
}

/** How the register/mode maps to a short tone instruction for the model. */
function toneForMode(mode: TranslateMode): string {
  switch (mode) {
    case "code-mixed":
      return "Keep the casual, conversational, code-mixed register the user used.";
    case "modern-colloquial":
      return "Use a modern, colloquial register.";
    case "classic-colloquial":
      return "Use a classic, colloquial register.";
    default:
      return "Use a clear, respectful, formal register.";
  }
}

export interface IntlLanguageDeps {
  /** Qwen API key (Bearer). Never logged. */
  readonly apiKey: string;
  /** OpenAI-compatible base URL, e.g. `https://…/compatible-mode/v1`. */
  readonly apiBase: string;
  /** Chat-completions model name, e.g. `qwen-plus`. */
  readonly model: string;
  /** HTTP port (default: global `fetch`). Injected in tests. */
  readonly fetch?: SarvamFetchLike;
  /** Per-request timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** Audit sink invoked on every failure path. Default: no-op. */
  readonly onAudit?: (entry: LanguageAuditEntry) => void | Promise<void>;
}

/**
 * Build an international {@link LanguageLayer} over Qwen. Pure construction — no network happens
 * until a method is called.
 */
export function createInternationalLanguageLayer(deps: IntlLanguageDeps): LanguageLayer {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as SarvamFetchLike);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const onAudit = deps.onAudit ?? (() => {});
  const endpoint = `${deps.apiBase.replace(/\/$/, "")}/chat/completions`;

  async function audit(entry: LanguageAuditEntry): Promise<void> {
    try {
      await onAudit(entry);
    } catch {
      // Auditing must never break the fail-safe path.
    }
  }

  /** One chat-completion translating `text` into `targetName`. Returns the text or `null`. */
  async function chatTranslate(text: string, targetName: string, tone: string): Promise<string | null> {
    const system =
      `You are a professional translator. Translate the user's message into ${targetName}. ` +
      `${tone} Preserve all numbers, dates, codes, and names exactly. ` +
      `Output ONLY the translation with no quotes, labels, or commentary.`;
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: deps.model,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: text },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        await audit({ op: "translate", reason: `qwen intl translate status ${res.status}` });
        return null;
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      } | null;
      const out = json?.choices?.[0]?.message?.content;
      const trimmed = typeof out === "string" ? out.trim() : "";
      return trimmed.length > 0 ? trimmed : null;
    } catch (error) {
      const reason =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? "timeout"
          : "network";
      await audit({ op: "translate", reason: `qwen intl translate failed: ${reason}` });
      return null;
    }
  }

  return {
    // No international STT/TTS in scope — fail safe so the caller keeps the text reply.
    async speechToText(): Promise<SttResult | null> {
      return null;
    },
    async detectLanguage(text: string): Promise<string> {
      return detectLanguageByScript(text);
    },
    async translateToEnglish(text: string): Promise<string | null> {
      if (typeof text !== "string" || text.trim().length === 0) return text;
      return chatTranslate(text, "English", toneForMode("formal"));
    },
    async translateFromEnglish(
      text: string,
      targetLanguage: string,
      mode: TranslateMode = "formal",
    ): Promise<string | null> {
      if (typeof text !== "string" || text.length === 0) return text;
      const targetName = languageName(targetLanguage);
      if (targetName === "English") return text;
      return chatTranslate(text, targetName, toneForMode(mode));
    },
    async translateLines(
      lines: readonly string[],
      targetLanguage: string,
      mode: TranslateMode = "formal",
    ): Promise<string[] | null> {
      const targetName = languageName(targetLanguage);
      if (targetName === "English") return [...lines];
      const tone = toneForMode(mode);
      const out: string[] = [];
      for (const line of lines) {
        if (line.trim().length === 0) {
          out.push(line);
          continue;
        }
        const translated = await chatTranslate(line, targetName, tone);
        if (translated === null) return null; // A failed line fails the batch (no fallback).
        out.push(translated);
      }
      return out;
    },
    async textToSpeech(): Promise<SynthesizedSpeech | null> {
      return null;
    },
  };
}
