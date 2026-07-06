/**
 * WhatsApp intent router — maps a normalized inbound message to an AuthPilot action.
 *
 * Two roles, decided by whether the sender's number is a registered staff member:
 *
 *  PATIENT:
 *   - free text / image  -> create a Case (intakeType "whatsapp_patient_note"), run the
 *                           normal nine-stage pipeline; reply with a generic ack template.
 *   - "status" question  -> look up the sender's most recent open Case, reply with a
 *                           GENERIC status template (no PHI). Does NOT re-run the pipeline.
 *
 *  STAFF (the differentiator — approve-from-anywhere):
 *   - "Approve <id>"  -> same effect as the dashboard Approve & Send (Human_Action),
 *                        audit trail records source "whatsapp".
 *   - "Reject <id>"   -> move Case to NeedsHumanInput, log rejection.
 *   - "Status <id|name>" -> one-line status summary (status + confidence + SLA days left).
 *   - "Show <id>"     -> reply with a deep link to the Case Detail page.
 *
 * Every WhatsApp-originated action still writes the same Trace_Step / audit entries as
 * the in-app flow, so the tamper-evident audit chain has no channel-shaped gap.
 *
 * This module is transport-agnostic: it takes ports (actions + sender + lookups) so it
 * can be unit/property-tested with in-memory fakes and no network.
 *
 * LANGUAGE SWITCHING (Sarvam AI): when a language layer + language store are supplied, the
 * router detects/stores the patient's language, translates inbound patient text to English
 * before it enters the pipeline, localizes the generic outbound reply back into the patient's
 * language, and handles an explicit "language"/change-language request by offering the tappable
 * language picker. All localization is best-effort: if Sarvam fails, the English base text is
 * sent as-is so a patient never gets silence. Staff commands stay English-only (operational).
 */
import type { NormalizedInbound } from "./parseInbound";
import type { LanguageLayer, TranslateMode } from "../i18n/language";
import {
  buildLanguagePickerList,
  decodeLanguageTap,
  isSupportedLanguage,
  type ListSpec,
  translateModeForMessage,
} from "../i18n/languagePicker";

export type Role = "patient" | "staff";

export interface RouterPorts {
  /** Resolve the role of a WhatsApp sender by phone number. */
  resolveRole(phone: string): Promise<Role>;
  /** Create a Case from an inbound message; returns the new case id. */
  createCaseFromIntake(input: {
    phone: string;
    text: string;
    imageMediaId?: string;
  }): Promise<{ caseId: string }>;
  /** Most recent open Case for a patient phone, or null. */
  latestOpenCaseForPhone(phone: string): Promise<{ caseId: string; status: string } | null>;
  /** Perform a staff Human_Action on a case (source recorded as "whatsapp"). */
  humanAction(input: {
    caseId: string;
    action: "approve" | "reject";
    actorPhone: string;
    idempotencyKey: string;
  }): Promise<{ ok: boolean; message: string }>;
  /** One-line status summary for a case id or patient name. */
  statusSummary(query: string): Promise<string | null>;
  /** Absolute URL to a Case Detail page. */
  caseDetailUrl(caseId: string): string;
}

/**
 * Optional language-switching ports. When supplied to {@link routeInbound}, the router detects,
 * stores, and applies the patient's language. Omit them to run the channel English-only.
 */
export interface LanguagePorts {
  /** The Sarvam-backed language layer (detect / translate / localize). */
  layer: LanguageLayer;
  /** Read the patient's stored language (BCP-47), or null if not yet chosen. */
  getLanguage(phone: string): Promise<string | null>;
  /** Persist the patient's chosen/detected language (BCP-47). */
  setLanguage(phone: string, language: string): Promise<void>;
}

/** A structured reply the caller sends: either localized text or an interactive list. */
export interface OutboundReply {
  /** Localized reply text (already in the patient's language when a layer is present). */
  text?: string;
  /** An interactive list to send instead of text (the language picker). */
  list?: ListSpec;
}

export interface StaffCommand {
  verb: "approve" | "reject" | "status" | "show";
  arg: string;
}

/** Parse a free-text staff reply like "Approve 114" / "status Jane Doe". Case-insensitive. */
export function parseStaffCommand(body: string): StaffCommand | null {
  const m = /^\s*(approve|reject|status|show)\s+(.+?)\s*$/i.exec(body ?? "");
  if (!m) return null;
  return { verb: m[1].toLowerCase() as StaffCommand["verb"], arg: m[2].trim() };
}

// Generic, PHI-free patient templates (must be pre-approved WhatsApp templates in prod).
export const PATIENT_TEMPLATES = {
  received:
    "We've received your message about your insurance issue and started reviewing it. We'll update you here as soon as we have next steps.",
  statusGeneric:
    "There's an update on your case. Please check your patient portal or call our office for the details.",
  noOpenCase:
    "We don't have an open case for this number right now. If you have a new insurance issue, just describe it here and we'll start one.",
  languageSet:
    "Done — I'll message you in this language from now on. Go ahead and tell me about your insurance issue.",
} as const;

export interface RouteResult {
  reply?: string;
  /** An interactive list reply (the language picker), when applicable. */
  replyList?: ListSpec;
  caseId?: string;
  /** The patient's language after this turn (BCP-47), when known. */
  language?: string;
  handled: boolean;
}

/** Matches an explicit request to pick/change language, in several languages/spellings. */
const CHANGE_LANGUAGE_RE =
  /\b(language|change language|lang|भाषा|भाषा बदल|மொழி|భాష|ভাষা|idioma|langue)\b/i;

/**
 * Localize an English base reply into `language` with register mirroring, best-effort. Returns the
 * original text unchanged when there is no layer, the target is English, or Sarvam fails.
 */
async function localize(
  language: LanguagePorts | undefined,
  targetLanguage: string | null,
  englishText: string,
  mirrorSource: string,
): Promise<string> {
  if (!language || !targetLanguage || targetLanguage.startsWith("en")) return englishText;
  const mode: TranslateMode = translateModeForMessage(mirrorSource);
  const out = await language.layer.translateFromEnglish(englishText, targetLanguage, mode);
  return out ?? englishText;
}

/**
 * Route one inbound message. The caller (the webhook route) is responsible for dedupe
 * before invoking this, and for actually sending `reply`/`replyList` via the Sender.
 *
 * When `language` ports are supplied, the patient path becomes multilingual: a language-picker
 * tap or a change-language request is handled first; otherwise the patient's language is resolved
 * (stored, else detected from this message and stored), the inbound text is translated to English
 * before entering the pipeline, and the outbound reply is localized back.
 */
export async function routeInbound(
  inbound: NormalizedInbound,
  ports: RouterPorts,
  language?: LanguagePorts,
): Promise<RouteResult> {
  const role = await ports.resolveRole(inbound.phone);

  if (role === "staff") {
    const cmd = parseStaffCommand(inbound.body);
    if (!cmd) {
      return { handled: true, reply: "Commands: Approve <id> | Reject <id> | Status <id|name> | Show <id>" };
    }
    switch (cmd.verb) {
      case "approve":
      case "reject": {
        const res = await ports.humanAction({
          caseId: cmd.arg,
          action: cmd.verb,
          actorPhone: inbound.phone,
          // Idempotency key derived from the inbound message id so a redelivery is a no-op.
          idempotencyKey: `wa:${inbound.messageId}`,
        });
        return { handled: true, reply: res.message, caseId: cmd.arg };
      }
      case "status": {
        const summary = await ports.statusSummary(cmd.arg);
        return { handled: true, reply: summary ?? `No case found for "${cmd.arg}".` };
      }
      case "show":
        return { handled: true, reply: ports.caseDetailUrl(cmd.arg) };
    }
  }

  // PATIENT — language switching (only when language ports are supplied).

  // 1) A language-picker tap selects/persists the language immediately.
  if (language && inbound.interactiveId) {
    const tap = decodeLanguageTap(inbound.interactiveId);
    if (tap.kind === "morePages") {
      return { handled: true, replyList: buildLanguagePickerList({ page: 1 }) };
    }
    if (tap.kind === "language" && isSupportedLanguage(tap.code)) {
      await language.setLanguage(inbound.phone, tap.code);
      const confirm = await localize(language, tap.code, PATIENT_TEMPLATES.languageSet, "");
      return { handled: true, language: tap.code, reply: confirm };
    }
  }

  // 2) An explicit "change language" request opens the picker.
  if (language && CHANGE_LANGUAGE_RE.test(inbound.body) && !inbound.hasImage) {
    return { handled: true, replyList: buildLanguagePickerList() };
  }

  // 3) Resolve the patient's working language: stored, else detect from this message + store.
  let lang: string | null = null;
  if (language) {
    lang = await language.getLanguage(inbound.phone);
    if (!lang && inbound.body.trim().length > 0) {
      lang = await language.layer.detectLanguage(inbound.body);
      await language.setLanguage(inbound.phone, lang);
    }
  }

  // 4) Translate inbound patient text to English so the deterministic router + pipeline
  //    understand it. Best-effort: fall back to the original words on any failure.
  let englishBody = inbound.body;
  if (language && lang && !lang.startsWith("en") && inbound.body.trim().length > 0) {
    const translated = await language.layer.translateToEnglish(inbound.body, lang);
    if (translated) englishBody = translated;
  }

  const asksStatus = /\b(status|what('| i)?s happening|update|any news)\b/i.test(englishBody);
  if (asksStatus && !inbound.hasImage) {
    const open = await ports.latestOpenCaseForPhone(inbound.phone);
    const base = open ? PATIENT_TEMPLATES.statusGeneric : PATIENT_TEMPLATES.noOpenCase;
    const reply = await localize(language, lang, base, inbound.body);
    return { handled: true, caseId: open?.caseId, language: lang ?? undefined, reply };
  }

  // New intake (text and/or image). The English-translated text enters the pipeline.
  if (englishBody.trim().length > 0 || inbound.hasImage) {
    const { caseId } = await ports.createCaseFromIntake({
      phone: inbound.phone,
      text: englishBody,
      imageMediaId: inbound.imageRef,
    });
    const reply = await localize(language, lang, PATIENT_TEMPLATES.received, inbound.body);
    return { handled: true, caseId, language: lang ?? undefined, reply };
  }

  // First contact with no usable content and a language layer present: offer the picker.
  if (language && !lang) {
    return { handled: true, replyList: buildLanguagePickerList() };
  }

  return { handled: false };
}
