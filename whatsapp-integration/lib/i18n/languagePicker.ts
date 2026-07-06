/**
 * WhatsApp language picker + supported-language registry.
 *
 * A patient can change the language AuthPilot speaks to them by tapping a row in an interactive
 * WhatsApp LIST. Because Meta caps a list at 10 rows total, the picker PAGES the supported
 * languages: each page shows up to 9 languages plus a "More languages" row that requests the next
 * page. Row ids are deterministic and reversible so the router can decode a tap with
 * {@link decodeLanguageTap} without any stored state.
 *
 * The registry is intentionally curated to the languages Sarvam handles well (the Indian
 * languages + English) plus a set of common international languages, each labelled in its own
 * script so the picker is self-explanatory regardless of the patient's current language.
 *
 * Pure module — no network, no config. Safe to import from the router, the sender, and tests.
 */
import { isCodeMixed, type TranslateMode } from "./language";

/** Meta's hard cap on rows in a single interactive list (across all sections). */
export const MAX_LIST_ROWS = 10;

/** How many language rows we show per page (one row is reserved for "More languages"). */
const LANGUAGES_PER_PAGE = MAX_LIST_ROWS - 1;

/** A supported language: its BCP-47 code and its label written in its own script. */
export interface SupportedLanguage {
  /** BCP-47 code used throughout the language layer (e.g. `hi-IN`, `en-IN`, `es`). */
  readonly code: string;
  /** Human label in the language's own script. */
  readonly label: string;
}

/**
 * The languages a patient can choose. English first, then the Indian languages (Sarvam's
 * strength), then common international languages. Order defines picker paging.
 */
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  { code: "en-IN", label: "English" },
  { code: "hi-IN", label: "हिन्दी" },
  { code: "ta-IN", label: "தமிழ்" },
  { code: "te-IN", label: "తెలుగు" },
  { code: "ml-IN", label: "മലയാളം" },
  { code: "kn-IN", label: "ಕನ್ನಡ" },
  { code: "bn-IN", label: "বাংলা" },
  { code: "gu-IN", label: "ગુજરાતી" },
  { code: "mr-IN", label: "मराठी" },
  { code: "pa-IN", label: "ਪੰਜਾਬੀ" },
  { code: "or-IN", label: "ଓଡ଼ିଆ" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "ar", label: "العربية" },
  { code: "zh", label: "中文" },
] as const;

const SUPPORTED_CODES: ReadonlySet<string> = new Set(SUPPORTED_LANGUAGES.map((l) => l.code));

/** True when `code` is one of the languages the picker offers. Accepts bare or BCP-47 codes. */
export function isSupportedLanguage(code: string | undefined): boolean {
  if (typeof code !== "string" || code.trim().length === 0) return false;
  const trimmed = code.trim();
  if (SUPPORTED_CODES.has(trimmed)) return true;
  // Accept a bare Indian code like "hi" → "hi-IN".
  if (!trimmed.includes("-") && SUPPORTED_CODES.has(`${trimmed.toLowerCase()}-IN`)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Interactive list spec (transport-agnostic; the sender maps it to Meta's shape)
// ---------------------------------------------------------------------------

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export interface ListSection {
  title?: string;
  rows: ListRow[];
}

export interface ListSpec {
  /** Body prompt shown above the list. */
  body: string;
  /** The button label that opens the list (Meta caps at 20 chars). */
  buttonLabel: string;
  sections: ListSection[];
}

// ---------------------------------------------------------------------------
// Row id encoding / decoding
// ---------------------------------------------------------------------------

const LANG_PREFIX = "lang:";
const MORE_PREFIX = "lang:more:";

/** Deterministic row id for a language selection (e.g. `lang:hi-IN`). */
function languageRowId(code: string): string {
  return `${LANG_PREFIX}${code}`;
}

/** Deterministic row id that requests the next page (e.g. `lang:more:2`). */
function morePagesRowId(nextPage: number): string {
  return `${MORE_PREFIX}${nextPage}`;
}

/** The decoded meaning of a tapped picker row. */
export type LanguageTap =
  | { kind: "language"; code: string }
  | { kind: "morePages"; nextPage: number }
  | { kind: "other" };

/**
 * Decode a tapped interactive row id back into its meaning. Returns `{ kind: "other" }` for any id
 * that is not a picker row, so the router can ignore non-picker taps. Pure.
 */
export function decodeLanguageTap(interactiveId: string | undefined): LanguageTap {
  if (typeof interactiveId !== "string" || interactiveId.length === 0) return { kind: "other" };
  if (interactiveId.startsWith(MORE_PREFIX)) {
    const n = Number.parseInt(interactiveId.slice(MORE_PREFIX.length), 10);
    return { kind: "morePages", nextPage: Number.isFinite(n) && n > 0 ? n : 1 };
  }
  if (interactiveId.startsWith(LANG_PREFIX)) {
    const code = interactiveId.slice(LANG_PREFIX.length);
    return code.length > 0 ? { kind: "language", code } : { kind: "other" };
  }
  return { kind: "other" };
}

// ---------------------------------------------------------------------------
// Picker construction
// ---------------------------------------------------------------------------

/**
 * Build the interactive language picker list for a given page (1-based). Each page shows up to
 * {@link LANGUAGES_PER_PAGE} languages; when more languages remain, a final "More languages" row
 * is appended that, when tapped, requests the next page (decoded as `kind: "morePages"`). Pure.
 */
export function buildLanguagePickerList(opts: { page?: number } = {}): ListSpec {
  const totalPages = Math.max(1, Math.ceil(SUPPORTED_LANGUAGES.length / LANGUAGES_PER_PAGE));
  const page = Math.min(Math.max(1, opts.page ?? 1), totalPages);
  const start = (page - 1) * LANGUAGES_PER_PAGE;
  const slice = SUPPORTED_LANGUAGES.slice(start, start + LANGUAGES_PER_PAGE);

  const rows: ListRow[] = slice.map((l) => ({ id: languageRowId(l.code), title: l.label }));

  if (page < totalPages) {
    rows.push({
      id: morePagesRowId(page + 1),
      title: "More languages",
      description: "Show more language options",
    });
  }

  return {
    body: "Which language should we use? / किस भाषा में बात करें?",
    buttonLabel: "Choose language",
    sections: [{ title: "Languages", rows }],
  };
}

// ---------------------------------------------------------------------------
// Register mirroring
// ---------------------------------------------------------------------------

/**
 * Choose the translate register/mode for localizing a reply, mirroring the patient's own style:
 * a code-mixed inbound message (native script + Latin, e.g. "kya ye covered hai?") gets a
 * `code-mixed` reply; everything else gets `formal`. Pure.
 */
export function translateModeForMessage(source: string): TranslateMode {
  return isCodeMixed(source) ? "code-mixed" : "formal";
}
