# AuthPilot i18n (web UI language switching)

Operator-facing UI translations for the AuthPilot dashboard. This is the **UI counterpart** to the
WhatsApp language layer:

- **WhatsApp channel** (`whatsapp-integration/lib/i18n/`): uses **Sarvam AI** to detect a patient's
  language, translate their inbound message to English for the pipeline, and localize the generic
  reply back into their language (plus optional voice-note STT/TTS).
- **Web UI** (this folder): uses **i18next** with static, reviewed dictionaries so an operator can
  switch the app language instantly, offline, with no API call.

## Contents

| File | Purpose |
|---|---|
| `index.ts` | i18next + react-i18next bootstrap, `LANGUAGES` registry, localStorage persistence, `<html lang>` sync. |
| `LanguageSwitcher.tsx` | Client component `<select>` that changes the active language. |
| `locales/*.json` | Translation dictionaries (`en`, `hi`, `ta`). English is the fallback. |

## Wiring (after the Next.js app is scaffolded — task 1)

1. Install deps:

   ```bash
   npm install i18next react-i18next
   ```

2. Import the bootstrap once from a top-level **client** provider (App Router):

   ```tsx
   "use client";
   import "@/i18n"; // side-effect init
   export function Providers({ children }: { children: React.ReactNode }) {
     return <>{children}</>;
   }
   ```

3. Translate in client components:

   ```tsx
   "use client";
   import { useTranslation } from "react-i18next";
   const { t } = useTranslation();
   return <h1>{t("nav.dashboard")}</h1>;
   ```

4. Add the switcher to the sidebar/header:

   ```tsx
   import { LanguageSwitcher } from "@/i18n/LanguageSwitcher";
   <LanguageSwitcher />
   ```

## Adding a language

1. Add `locales/<code>.json` (copy `en.json`, translate the values).
2. Register it in `index.ts` (`resources` + `LANGUAGES`).

## Keys / configuration

The UI switcher needs **no API keys** — it is fully local. The Sarvam-powered WhatsApp language
layer is configured separately via `SARVAM_API_KEY` and the `SARVAM_*` variables in `.env`
(see `.env.example`).
