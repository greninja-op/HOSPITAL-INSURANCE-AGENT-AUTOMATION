// =============================================================================
// lib/voice/transcriptIntake.ts
//
// Voice channel — transcript intake ONLY (Requirement 37).
//
// AuthPilot's "voice" channel is DELIBERATELY not a real-time media / telephony
// bridge. A phone call reaches AuthPilot as a Voice_Transcript: the text of the
// call (from any STT source, or pasted in the demo). This module normalizes that
// transcript into the exact same intake shape the web and WhatsApp channels
// produce, so a submitted transcript becomes a "phone_note" Intake and runs the
// identical nine-stage agent pipeline with NO special-casing (Req 37.1, 37.2).
//
// This module is intentionally self-contained: pure, deterministic, and free of
// Prisma and LLM dependencies. It performs no I/O and never throws.
//
// ── Transcript entrypoint (how this feeds POST /api/cases) ───────────────────
// A transcript entrypoint (e.g. a small POST /api/voice/transcript handler, or a
// direct dashboard form) calls `transcriptToIntake({ phone, transcript, language })`
// and forwards the returned object to the SAME case-creation logic that backs
// POST /api/cases:
//
//     const intake = transcriptToIntake({ phone, transcript, language });
//     // POST /api/cases with { intakeType, rawIntakeText, patientPhone }
//     // → creates a Case with status "New" and runs the normal pipeline.
//
// The POST /api/cases route itself is built in task 13.1 — this module only
// produces the normalized payload it accepts and adds no route of its own.
// =============================================================================

import type { IntakeType } from "@/lib/types";

/** Input accepted by the transcript entrypoint. */
export interface VoiceTranscriptInput {
  /** Caller phone number (E.164), if known. */
  phone?: string;
  /** The transcribed call text (from any STT source, or pasted in the demo). */
  transcript: string;
  /** Optional language hint for downstream processing. */
  language?: string;
}

/**
 * The normalized intake shape the case-creation logic (POST /api/cases) accepts.
 * `intakeType` is pinned to the shared `IntakeType` "phone_note" so a transcript
 * is indistinguishable from any other phone-note intake downstream.
 */
export interface VoiceIntake {
  intakeType: Extract<IntakeType, "phone_note">;
  rawIntakeText: string;
  patientPhone?: string;
}

/**
 * Normalize a Voice_Transcript into the same intake shape the web/WhatsApp
 * channels produce, so it runs through the identical pipeline with no
 * special-casing (Req 37.1). Pure and deterministic — no I/O, never throws.
 *
 * - `rawIntakeText` is the trimmed transcript text.
 * - `patientPhone` is carried through only when a caller number is provided;
 *   it is omitted entirely (rather than set to undefined-as-empty) when absent.
 */
export function transcriptToIntake(input: VoiceTranscriptInput): VoiceIntake {
  const rawIntakeText = (input.transcript ?? "").trim();

  const intake: VoiceIntake = {
    intakeType: "phone_note",
    rawIntakeText,
  };

  const phone = input.phone?.trim();
  if (phone) {
    intake.patientPhone = phone;
  }

  return intake;
}
