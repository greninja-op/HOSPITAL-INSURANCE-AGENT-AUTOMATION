/**
 * Property tests for the AuthPilot language layer's pure helpers and the language picker.
 *
 * These cover the deterministic, network-free parts of language switching:
 *   - script-based detection is total and only ever returns a known code,
 *   - code-mixing requires BOTH a native script and Latin letters,
 *   - BCP-47 / Sarvam code normalization is idempotent and maps Odia correctly,
 *   - the picker pages within WhatsApp's 10-row cap and keeps every language reachable,
 *   - tap decoding round-trips a language code, and register/mode selection is total.
 *
 * Run under Vitest + fast-check (≥100 runs), consistent with the rest of the suite.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  detectLanguageByScript,
  isCodeMixed,
  toBcp47,
  toSarvamCode,
} from "./language";
import {
  LANGUAGE_CHOICE_IDS,
  LANGUAGE_OPTIONS,
  MAX_LIST_ROWS,
  buildLanguagePickerList,
  decodeLanguageTap,
  isSupportedLanguage,
  languagePickerPageCount,
  translateModeForMessage,
} from "./languagePicker";

const RUNS = { numRuns: 100 };

const KNOWN_CODES = new Set<string>([
  "en-IN", "hi-IN", "ta-IN", "te-IN", "kn-IN", "ml-IN", "bn-IN", "gu-IN", "pa-IN", "or-IN",
  "ja", "ko", "zh", "ar", "th", "ru",
]);

const DEVANAGARI = "नमस्ते मुझे मदद चाहिए";
const TAMIL = "எனக்கு உதவி வேண்டும்";

describe("detectLanguageByScript", () => {
  it("is total and only ever returns a known code", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const code = detectLanguageByScript(s);
        expect(KNOWN_CODES.has(code)).toBe(true);
      }),
      RUNS,
    );
  });

  it("returns en-IN for pure Latin / empty / whitespace input", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9 .,!?]*$/), (s) => {
        expect(detectLanguageByScript(s)).toBe("en-IN");
      }),
      RUNS,
    );
  });

  it("detects the script when a script sample is embedded anywhere", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(detectLanguageByScript(`${a}${DEVANAGARI}${b}`)).toBe("hi-IN");
        expect(detectLanguageByScript(`${a}${TAMIL}${b}`)).toBe("ta-IN");
      }),
      RUNS,
    );
  });
});

describe("isCodeMixed", () => {
  it("requires both a native script and a Latin letter", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z ]+$/), (latinOnly) => {
        expect(isCodeMixed(latinOnly)).toBe(false); // Latin only is never code-mixed
      }),
      RUNS,
    );
    expect(isCodeMixed(DEVANAGARI)).toBe(false); // pure script, no Latin
    expect(isCodeMixed(`${DEVANAGARI} please help`)).toBe(true); // script + Latin
  });
});

describe("toBcp47 / toSarvamCode", () => {
  it("toBcp47 is idempotent and never empty", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = toBcp47(s);
        expect(once.length).toBeGreaterThan(0);
        expect(toBcp47(once)).toBe(once);
      }),
      RUNS,
    );
  });

  it("maps bare 'en' to en-IN and remaps Odia or-IN → od-IN for Sarvam", () => {
    expect(toBcp47("en")).toBe("en-IN");
    expect(toBcp47("hi")).toBe("hi-IN");
    expect(toSarvamCode("or-IN")).toBe("od-IN");
    expect(toSarvamCode("or")).toBe("od-IN");
    expect(toSarvamCode("hi-IN")).toBe("hi-IN");
  });
});

describe("language picker", () => {
  it("never emits a page exceeding the 10-row WhatsApp cap", () => {
    const pages = languagePickerPageCount();
    fc.assert(
      fc.property(fc.integer({ min: -5, max: pages + 5 }), (page) => {
        const list = buildLanguagePickerList({ page });
        const rowCount = list.sections.reduce((n, s) => n + s.rows.length, 0);
        expect(rowCount).toBeLessThanOrEqual(MAX_LIST_ROWS);
      }),
      RUNS,
    );
  });

  it("keeps every supported language reachable across pages", () => {
    const pages = languagePickerPageCount();
    const seen = new Set<string>();
    for (let p = 0; p < pages; p++) {
      for (const row of buildLanguagePickerList({ page: p }).sections[0].rows) {
        if (row.id.startsWith(LANGUAGE_CHOICE_IDS.prefix) && row.id !== LANGUAGE_CHOICE_IDS.more) {
          seen.add(row.id.slice(LANGUAGE_CHOICE_IDS.prefix.length));
        }
      }
    }
    for (const opt of LANGUAGE_OPTIONS) expect(seen.has(opt.code)).toBe(true);
  });

  it("decodeLanguageTap round-trips a supported language code", () => {
    fc.assert(
      fc.property(fc.constantFrom(...LANGUAGE_OPTIONS.map((o) => o.code)), (code) => {
        const tap = decodeLanguageTap(`${LANGUAGE_CHOICE_IDS.prefix}${code}`);
        expect(tap).toEqual({ kind: "language", code });
        expect(isSupportedLanguage(code)).toBe(true);
      }),
      RUNS,
    );
  });

  it("decodes the more-pages control and treats unknown ids as 'other'", () => {
    expect(decodeLanguageTap(LANGUAGE_CHOICE_IDS.more)).toEqual({ kind: "morePages" });
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.startsWith("lang:")),
        (id) => {
          expect(decodeLanguageTap(id).kind).toBe("other");
        },
      ),
      RUNS,
    );
  });
});

describe("translateModeForMessage", () => {
  it("is total and only returns 'formal' or 'code-mixed'", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(["formal", "code-mixed"]).toContain(translateModeForMessage(s));
      }),
      RUNS,
    );
  });

  it("mirrors code-mixed input as code-mixed", () => {
    expect(translateModeForMessage(`${DEVANAGARI} thanks`)).toBe("code-mixed");
  });
});
