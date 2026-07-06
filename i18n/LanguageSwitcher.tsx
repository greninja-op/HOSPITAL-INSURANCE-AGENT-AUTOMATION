"use client";

/**
 * A compact language switcher for the AuthPilot web UI. Drop it into the sidebar or header.
 * Changing the selection updates i18next live, persists to localStorage, and sets <html lang>.
 */
import { useTranslation } from "react-i18next";

import { LANGUAGES, type LanguageCode } from "./index";

export function LanguageSwitcher({ className }: { className?: string }) {
  const { i18n } = useTranslation();

  return (
    <label className={className}>
      <span className="sr-only">Language</span>
      <select
        value={i18n.language as LanguageCode}
        onChange={(e) => void i18n.changeLanguage(e.target.value)}
        className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
