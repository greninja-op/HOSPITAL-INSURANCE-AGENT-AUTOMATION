/**
 * AuthPilot web UI internationalization (i18next + react-i18next).
 *
 * This is the OPERATOR-FACING UI counterpart to the WhatsApp language layer: the WhatsApp channel
 * uses Sarvam AI to detect/translate a patient's language on the fly, while the dashboard UI uses
 * static, reviewed translation dictionaries (below) so operators can switch the app's language
 * instantly with no network call.
 *
 * Wiring (once the Next.js app is scaffolded):
 *   1. Add deps:  i18next  react-i18next
 *   2. Import this module once from a top-level client component (e.g. a Providers wrapper):
 *        import "@/i18n";
 *   3. Use the hook in client components:
 *        const { t } = useTranslation();  t("nav.dashboard")
 *   4. Drop <LanguageSwitcher /> (see ./LanguageSwitcher.tsx) into the app sidebar/header.
 *
 * The chosen language persists to localStorage and is applied to <html lang> for accessibility.
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import hi from "./locales/hi.json";
import ta from "./locales/ta.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import de from "./locales/de.json";
import ar from "./locales/ar.json";
import zh from "./locales/zh.json";

/** UI languages, labelled in their own script. Kept in sync with ./locales/*.json. */
export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "hi", label: "हिन्दी" },
  { code: "ta", label: "தமிழ்" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "ar", label: "العربية" },
  { code: "zh", label: "中文" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

export const STORAGE_KEY = "authpilot_lang";

/** Right-to-left UI languages (applied to <html dir> on language change). */
export const RTL_LANGUAGES: ReadonlySet<string> = new Set(["ar"]);

export const resources = {
  en: { translation: en },
  hi: { translation: hi },
  ta: { translation: ta },
  es: { translation: es },
  fr: { translation: fr },
  de: { translation: de },
  ar: { translation: ar },
  zh: { translation: zh },
} as const;

function initialLanguage(): LanguageCode {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && LANGUAGES.some((l) => l.code === stored)) {
      return stored as LanguageCode;
    }
  }
  return "en";
}

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

function applyHtmlLang(lng: string) {
  if (typeof document !== "undefined") {
    document.documentElement.lang = lng;
    document.documentElement.dir = RTL_LANGUAGES.has(lng) ? "rtl" : "ltr";
  }
}

applyHtmlLang(i18n.language);

i18n.on("languageChanged", (lng) => {
  applyHtmlLang(lng);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, lng);
  }
});

export default i18n;
