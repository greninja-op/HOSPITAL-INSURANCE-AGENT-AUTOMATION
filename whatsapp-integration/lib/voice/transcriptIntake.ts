/**
 * Voice channel — lightweight transcript intake.
 *
 * DELIBERATELY NOT a full real-time voice/telephony media bridge — that would be a
 * separate multi-service stack far
 * too heavy for AuthPilot's single-repo Next.js demo. Instead we adopt only the *pattern*
 * the brief already lists as a nice-to-have (feature #16): a phone/voice call is captured
 * as a transcript and fed into the normal intake pipeline exactly like a "phone_note".
 *
 * If a real-time voice bridge is ever wanted, it would be a separate optional service; see
 * whatsapp-integration/README.md → "Voice channel (out of scope for the demo)".
 */

export interface VoiceTranscriptInput {
  /** Caller phone number (E.164), if known. */
  phone?: string;
  /** The transcribed call text (from any STT source, or pasted in the demo). */
  transcript: string;
  /** Optional language hint for downstream processing. */
  language?: string;
}

export interface VoiceIntake {
  intakeType: "phone_note";
  rawIntakeText: string;
  patientPhone?: string;
}

/**
 * Normalize a voice transcript into the same intake shape the web/WhatsApp channels
 * produce, so it runs through the identical nine-stage pipeline with no special-casing.
 */
export function transcriptToIntake(input: VoiceTranscriptInput): VoiceIntake {
  const text = (input.transcript ?? "").trim();
  return {
    intakeType: "phone_note",
    rawIntakeText: text,
    patientPhone: input.phone,
  };
}
