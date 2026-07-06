// =============================================================================
// lib/whatsapp/emergency.ts
//
// Deterministic, NON-LLM emergency-language short-circuit for the WhatsApp
// patient path (Requirement 42, Emergency_Language glossary term).
//
// This module provides two things and NOTHING that mutates state:
//
//   1. `detectEmergency(text)` — a pure, deterministic predicate that matches
//      inbound patient text against a FIXED set of emergency-language patterns
//      (chest pain, difficulty breathing, severe bleeding, stroke, overdose,
//      suicidal statements, and a few closely-related life-threatening phrases)
//      using plain string / regex rules with **no language-model call**
//      (Requirement 42.4). Because it is deterministic and runs FIRST on the
//      patient path, an emergency message can never fall through to case
//      creation (Requirement 42.3).
//
//   2. `buildEmergencyResponse()` / `EMERGENCY_REPLY` — the canned, PHI-free
//      emergency-care reply directing the patient to call emergency services
//      (911) or go to the emergency room (Requirement 42.1), together with the
//      urgent `Handoff_Request` descriptor the router/handoff module uses to
//      raise an **urgent** handoff (Requirements 42.2, 43.2).
//
// The actual Handoff_Request creation and the outbound send live in the handoff
// module / router; this module is detection + canned text only, so it stays
// pure and trivially unit- and property-testable with no ports.
// =============================================================================

// ─── Emergency reply text (PHI-free, deterministic) ──────────────────────────

/**
 * The canned emergency-care reply. It NEVER references case specifics or PHI and
 * always directs the patient to emergency services first (Requirement 42.1).
 */
export const EMERGENCY_REPLY =
  "This sounds like a medical emergency. Please call your local emergency " +
  "number (911 in the US) right now, or go to the nearest emergency room. " +
  "If someone is unconscious, not breathing, or seriously injured, call " +
  "emergency services immediately. We've alerted our team to follow up, but " +
  "please do not wait for us — get emergency help now.";

// ─── Emergency handoff descriptor ─────────────────────────────────────────────

/**
 * Shape describing the urgent Handoff_Request that should be raised on an
 * emergency match (Requirements 42.2, 43.2). Mirrors the router's
 * `HandoffRequestInput`; the handoff module/router performs the actual creation.
 */
export interface EmergencyHandoff {
  patientPhone: string;
  /** Linked Case where one already exists (usually none — no Case is created). */
  caseId?: string;
  /** Fixed, non-PHI reason string. */
  reason: string;
  /** Always true for emergencies (Requirement 42.2/43.2). */
  urgent: true;
}

/** The fixed, non-PHI reason recorded on an emergency handoff. */
export const EMERGENCY_HANDOFF_REASON = "emergency language detected";

/**
 * The result of the emergency short-circuit: the canned reply text plus the
 * urgent handoff descriptor for the router/handoff module to act on. Building
 * this performs NO side effects.
 */
export interface EmergencyResponse {
  /** Canned, PHI-free emergency-care reply to send to the patient (Req 42.1). */
  reply: string;
  /** Urgent Handoff_Request descriptor to raise (Req 42.2, 43.2). */
  handoff: EmergencyHandoff;
}

/**
 * Build the emergency response for a patient turn that matched
 * {@link detectEmergency}. Pure and total — it composes the canned reply and the
 * urgent handoff descriptor; it does NOT send anything or create a handoff.
 */
export function buildEmergencyResponse(
  patientPhone: string,
  caseId?: string,
): EmergencyResponse {
  return {
    reply: EMERGENCY_REPLY,
    handoff: {
      patientPhone,
      ...(caseId ? { caseId } : {}),
      reason: EMERGENCY_HANDOFF_REASON,
      urgent: true,
    },
  };
}

// ─── Deterministic detection (no language model — Requirement 42.4) ──────────

/**
 * Fixed set of emergency-language patterns. Each entry is a plain regular
 * expression evaluated against a normalized (lower-cased, collapsed-whitespace)
 * copy of the inbound text. The categories mirror the Emergency_Language
 * glossary examples: chest pain, difficulty breathing, severe bleeding, stroke,
 * overdose, and suicidal statements — plus a few closely-related unambiguous
 * life-threatening phrases (choking, unconscious, anaphylaxis, seizure).
 *
 * Patterns are intentionally specific to avoid false positives on ordinary
 * insurance-intake descriptions (e.g. "I had a heart procedure last year" must
 * NOT match, but "I'm having chest pain right now" must).
 */
const EMERGENCY_PATTERNS: readonly RegExp[] = [
  // Chest pain / heart attack.
  /\bchest\s+pain(s)?\b/,
  /\b(pain|pressure|tightness|tight)\s+in\s+(my|the)\s+chest\b/,
  /\bheart\s+attack\b/,
  /\bcardiac\s+arrest\b/,

  // Difficulty breathing.
  /\b(can('|’)?t|cannot|can\s+not|unable\s+to|couldn('|’)?t|struggling\s+to)\s+breathe?\b/,
  /\b(difficulty|trouble|hard(er)?)\s+breathing\b/,
  /\bshort(ness)?\s+of\s+breath\b/,
  /\bstruggling\s+to\s+breathe?\b/,
  /\bnot\s+breathing\b/,
  /\bstopped\s+breathing\b/,

  // Choking / airway.
  /\bchoking\b/,

  // Severe bleeding.
  /\b(severe|heavy|heavily|profuse|profusely|uncontrolled|won('|’)?t\s+stop|can('|’)?t\s+stop)\s+bleed(ing)?\b/,
  /\bbleeding\s+(badly|heavily|a\s+lot|everywhere|out|profusely|uncontrollably)\b/,
  /\bbleeding\s+(that\s+)?(won('|’)?t|will\s+not|wont)\s+stop\b/,
  /\blosing\s+(a\s+lot\s+of|lots\s+of|too\s+much)\s+blood\b/,
  /\bhemorrhag(e|ing)\b/,

  // Stroke.
  /\bstroke\b/,
  /\bface\s+(is\s+)?droop(ing|ed)?\b/,
  /\bslurred\s+speech\b/,
  /\bsudden\s+(numbness|weakness)\b/,

  // Seizure.
  /\bseizure(s)?\b/,
  /\bconvulsion(s)?\b/,

  // Overdose / poisoning.
  /\boverdos(e|ed|ing)\b/,
  /\bod('|’)?(d|ed)\b/, // "OD'd"
  /\btook\s+too\s+many\s+(pills|tablets|(of\s+)?my\s+(pills|meds|medication))\b/,
  /\bpoison(ed|ing)?\b/,

  // Anaphylaxis / severe allergic reaction.
  /\banaphyla(xis|ctic)\b/,
  /\bsevere\s+allergic\s+reaction\b/,
  /\b(throat|tongue)\s+(is\s+)?(closing|swelling)\b/,

  // Unconscious / unresponsive.
  /\bunconscious\b/,
  /\bunresponsive\b/,
  /\bpassed\s+out\b/,
  /\bnot\s+(waking|responding)\b/,

  // Suicidal statements / self-harm.
  /\bsuicid(e|al)\b/,
  /\bkill\s+(myself|him|her|them|someone)\b/,
  /\bend\s+(my|his|her|their)\s+life\b/,
  /\b(want|going|trying)\s+to\s+die\b/,
  /\bhurt\s+myself\b/,
  /\bharm\s+myself\b/,
  /\btake\s+my\s+(own\s+)?life\b/,
];

/** Normalize inbound text for matching: lower-case and collapse whitespace. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Deterministic, NON-LLM emergency-language detector (Requirement 42.4).
 *
 * Returns `true` when `text` matches ANY fixed emergency-language pattern.
 * Total and pure: null/undefined/non-string/empty input returns `false`, and it
 * never throws and never performs I/O or model calls.
 */
export function detectEmergency(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  const normalized = normalize(text);
  if (normalized.length === 0) return false;
  for (const pattern of EMERGENCY_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }
  return false;
}
