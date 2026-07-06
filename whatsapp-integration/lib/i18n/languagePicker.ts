/**
 * Language-switching UX for the AuthPilot WhatsApp channel.
 *
 * Patients pick and change their language by TAPPING, never by remembering commands:
 *
 *   1. A first-contact / "change language" interactive list ({@link buildLanguagePickerList}),
 *      paged to respect WhatsApp's 10-row interactive-list cap, with each language labelled in
 *      its OWN script plus its English name.
 *   2. Tap decoding ({@link decodeLanguageTap}) that turns an interactive reply id (`lang:hi-IN`,
 *      `lang:__more`) into a structured selection, so a tap routes deterministically.
 *   3. Register mirroring ({@link detectRegister}, {@link translateModeForMessage}) that picks the
 *      Sarvam `/translate` mode (formal vs code-mixed) so replies read the way the patient writes.
 *
 * Pure and deterministic — this module only decides WHAT to offer and HOW to interpret a tap;
 * sending goes through the Sender (`sendInteractiveList`).
 */
import { isCodeMixed } from "./language";

/** A selectable language: BCP-47 code, native-script label, and English name. */
export interface LanguageOption {
  readonly code: string;
  readonly label: string;
  /** English name, shown as the row subtitle so anyone can recognise their language. */
  readonly english: string;
}

/** The supported languages, labelled in their OWN script + English (Indian first, then intl). */
export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { code: "en-IN", label: "English", english: "English" },
  { code: "hi-IN", label: "हिन्दी", english: "Hindi" },
  { code: "bn-IN", label: "বাংলা", english: "Bengali" },
  { code: "mr-IN", label: "मराठी", english: "Marathi" },
  { code: "te-IN", label: "తెలుగు", english: "Telugu" },
  { code: "ta-IN", label: "தமிழ்", english: "Tamil" },
  { code: "gu-IN", label: "ગુજરાતી", english: "Gujarati" },
  { code: "kn-IN", label: "ಕನ್ನಡ", english: "Kannada" },
  { code: "ml-IN", label: "മലയാളം", english: "Malayalam" },
  { code: "pa-IN", label: "ਪੰਜਾਬੀ", english: "Punjabi" },
  { code: "or-IN", label: "ଓଡ଼ିଆ", english: "Odia" },
  { code: "es", label: "Español", english: "Spanish" },
  { code: "fr", label: "Français", english: "French" },
  { code: "pt", label: "Português", english: "Portuguese" },
  { code: "ar", label: "العربية", english: "Arabic" },
];

/** Stable interactive-row ids so taps are recognised deterministically. */
export const LANGUAGE_CHOICE_IDS = {
  /** Language pick row id prefix, e.g. `lang:hi-IN`. */
  prefix: "lang:",
  /** The special "show more languages" row id (next picker page). */
  more: "lang:__more",
} as const;

/** WhatsApp caps an interactive list at 10 rows; the picker pages within this cap. */
export const MAX_LIST_ROWS = 10;

/** A section of an interactive list (mirrors the Sender's list spec). */
export interface ListSection {
  readonly title?: string;
  readonly rows: Array<{ id: string; title: string; description?: string }>;
}

/** The interactive-list spec consumed by the Sender's `sendInteractiveList`. */
export interface ListSpec {
  readonly buttonLabel: string;
  readonly body: string;
  readonly sections: ListSection[];
}

/** Number of pages the language picker spans for `total` languages at the row cap. */
export function languagePickerPageCount(total = LANGUAGE_OPTIONS.length): number {
  if (total <= MAX_LIST_ROWS) return 1;
  const perPage = MAX_LIST_ROWS - 1; // reserve the last row for "More languages"
  return Math.ceil(total / perPage);
}

/**
 * Build the tappable language picker, PAGED to respect the 10-row cap. One row per language
 * (id `lang:<code>`, titled in its own script). When the languages do not fit on one page, the
 * last row of a non-final page is a "More languages" control ({@link LANGUAGE_CHOICE_IDS.more})
 * that opens the next page — so every language stays reachable with a single tap.
 */
export function buildLanguagePickerList(
  options: { page?: number; body?: string; buttonLabel?: string } = {},
): ListSpec {
  const total = LANGUAGE_OPTIONS.length;
  const body = options.body ?? "Please choose your language / अपनी भाषा चुनें.";
  const buttonLabel = options.buttonLabel ?? "Choose language";
  const paged = total > MAX_LIST_ROWS;
  const perPage = paged ? MAX_LIST_ROWS - 1 : MAX_LIST_ROWS;
  const pageCount = languagePickerPageCount(total);
  const page = Math.min(Math.max(options.page ?? 0, 0), pageCount - 1);

  const start = page * perPage;
  const slice = LANGUAGE_OPTIONS.slice(start, start + perPage);
  const rows = slice.map((opt) => ({
    id: `${LANGUAGE_CHOICE_IDS.prefix}${opt.code}`,
    title: opt.label,
    // Show the English name only when it differs from the native label, to avoid duplication.
    ...(opt.english !== opt.label ? { description: opt.english } : {}),
  }));
  if (start + perPage < total) {
    rows.push({ id: LANGUAGE_CHOICE_IDS.more, title: "More languages ▸", description: "" });
  }

  return { buttonLabel, body, sections: [{ title: "Languages", rows }] };
}

/** A decoded language-picker tap. */
export type LanguageTap =
  | { readonly kind: "language"; readonly code: string }
  | { readonly kind: "morePages" }
  | { readonly kind: "other" };

/** Decode an interactive reply id into a structured language selection. */
export function decodeLanguageTap(id: string | undefined): LanguageTap {
  if (typeof id !== "string" || id.length === 0) return { kind: "other" };
  if (id === LANGUAGE_CHOICE_IDS.more) return { kind: "morePages" };
  if (id.startsWith(LANGUAGE_CHOICE_IDS.prefix)) {
    return { kind: "language", code: id.slice(LANGUAGE_CHOICE_IDS.prefix.length) };
  }
  return { kind: "other" };
}

/** True when `code` is one AuthPilot lists in the picker. */
export function isSupportedLanguage(code: string | undefined): boolean {
  if (typeof code !== "string") return false;
  return LANGUAGE_OPTIONS.some((o) => o.code === code);
}

// ---------------------------------------------------------------------------
// Register mirroring
// ---------------------------------------------------------------------------

/** The patient's writing register, mirrored back in replies. */
export type Register = "formal" | "casual";

/** Casual markers: chat-speak, common SMS contractions, and emoji. */
const CASUAL_PATTERNS: readonly RegExp[] = [
  /\b(u|ur|r|pls|plz|thx|thnx|ty|k|kk|lol|omg|btw|idk|imo|gonna|wanna|gotta|yeah|yep|nope|hey|hiya|sup)\b/i,
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, // emoji
  /(.)\1{2,}/, // elongated letters (e.g. "soooo")
  /!{2,}/, // multiple exclamation marks
];

/** Formal markers: polite forms and full, capitalised sentence structure. */
const FORMAL_PATTERNS: readonly RegExp[] = [
  /\b(please|kindly|thank you|regards|sir|madam|could you|would you|i would like|i am writing)\b/i,
];

/**
 * Detect whether the patient wrote formally or casually. Heuristic and deterministic: casual
 * markers win when present; otherwise an explicit polite/long-form message reads formal; the
 * neutral default is casual (warm and plain). Pure.
 */
export function detectRegister(text: string): Register {
  if (typeof text !== "string" || text.trim().length === 0) return "casual";
  for (const re of CASUAL_PATTERNS) if (re.test(text)) return "casual";
  for (const re of FORMAL_PATTERNS) if (re.test(text)) return "formal";
  const trimmed = text.trim();
  const looksComposed = /^[A-Z\u0900-\u0DFF].*[.?]$/.test(trimmed) && trimmed.length > 40;
  return looksComposed ? "formal" : "casual";
}

/** The Sarvam `/translate` mode used for replies (subset of the layer's TranslateMode). */
export type ReplyTranslateMode = "formal" | "code-mixed";

/**
 * Choose the reply translate mode, mirroring the patient's message: code-mixed input (native
 * script + English) replies `code-mixed`; a casual register also reads `code-mixed`; a formal,
 * pure-script message replies `formal`. Pure.
 */
export function translateModeForMessage(memberText: string): ReplyTranslateMode {
  if (isCodeMixed(memberText)) return "code-mixed";
  return detectRegister(memberText) === "formal" ? "formal" : "code-mixed";
}
