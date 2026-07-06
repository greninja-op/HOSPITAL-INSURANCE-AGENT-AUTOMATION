// ADDENDUM to app/api/webhooks/whatsapp/route.ts
//
// This adds a conversational fallback layer: when an inbound message from
// patient OR staff doesn't match a known structured pattern (approve/reject/
// status/show, or a clean new-case trigger), route it to Qwen with case
// context and a tightly scoped system prompt, instead of the generic
// "I didn't recognize that command" fallback.
//
// This turns the bot from "regex command parser" into "assistant that can
// actually answer 'what's going on with my case', 'what does X mean', 'why
// did you escalate this', etc." — while still respecting the compliance
// boundary: no dollar amounts, no specific denial codes/policy details, no
// medical advice sent over WhatsApp to patients. Staff get slightly more
// operational detail since they're internal, but still no raw PHI dump.

import { callQwen } from "@/lib/qwen";

// ---------------------------------------------------------------------------
// 1. Image quality check — runs BEFORE OCR extraction on any inbound image
// ---------------------------------------------------------------------------

interface ImageQualityResult {
  usable: boolean;
  reason?: "blurry" | "too_dark" | "cropped" | "not_a_document" | "wrong_document_type";
}

async function checkImageQuality(mediaBuffer: Buffer): Promise<ImageQualityResult> {
  // Cheap pre-check before spending an OCR/vision call: ask Qwen's vision
  // endpoint (or a lightweight heuristic) whether this looks like a usable
  // scan of a document at all.
  const result = await callQwen({
    model: "qwen-vl-plus", // vision-capable Qwen variant
    messages: [
      {
        role: "system",
        content:
          "You are checking whether an uploaded photo is usable for OCR extraction of an insurance/medical document. " +
          "Respond ONLY with JSON: {\"usable\": boolean, \"reason\": \"blurry\"|\"too_dark\"|\"cropped\"|\"not_a_document\"|\"wrong_document_type\"|null, " +
          "\"detected_document_type\": string|null}. Do not include any other text.",
      },
      {
        role: "user",
        content: [{ type: "image", image: mediaBuffer.toString("base64") }],
      },
    ],
  });

  return JSON.parse(result.text);
}

async function handleIncomingImage(from: string, mediaBuffer: Buffer, caption: string, isStaff: boolean) {
  const quality = await checkImageQuality(mediaBuffer);

  if (!quality.usable) {
    const guidance: Record<string, string> = {
      blurry:
        "That photo came through a bit blurry and I can't read the text clearly. Could you try again? Tip: hold the phone steady, tap the screen to focus on the document before taking the photo, and make sure there's good light.",
      too_dark:
        "That photo is too dark for me to read. Could you retake it somewhere brighter, or turn on your flash?",
      cropped:
        "It looks like part of the document is cut off. Could you resend a photo that shows the whole page, including all four corners?",
      not_a_document:
        "I couldn't find a document in that photo. If you meant to send a denial letter or referral, could you try again?",
      wrong_document_type:
        "That looks like it might not be the denial letter — could you double check and resend the actual letter from your insurance company? If you're not sure which document I need, just ask me and I'll explain.",
    };

    await sendWhatsAppText(from, guidance[quality.reason ?? "not_a_document"]);
    return null; // don't proceed to case creation
  }

  return quality;
}

// ---------------------------------------------------------------------------
// 2. Conversational fallback — for free text that isn't a clean trigger or
//    a clean staff command
// ---------------------------------------------------------------------------

const PATIENT_SYSTEM_PROMPT = `
You are AuthPilot's patient-facing WhatsApp assistant for a medical practice's
insurance appeals process. You are warm, plain-spoken, and brief (2-4 sentences,
WhatsApp-length, not an essay).

You CAN:
- Explain general concepts (what "prior authorization" means, what an "appeal" is,
  why a document might be needed, roughly how long appeals take in general terms)
- Acknowledge frustration with empathy
- Explain what happens next in the process, in general terms
- Ask a clarifying question if their request is ambiguous
- Offer to connect them with office staff for anything specific

You must NEVER:
- State any specific denial reason, diagnosis, procedure code, dollar amount,
  or policy detail for their case — say "that level of detail is in your
  portal / our office can walk you through it" instead
- Give medical advice, diagnose, or comment on treatment decisions — redirect
  to "that's a great question for your doctor"
- Make promises about outcomes ("your appeal will definitely be approved")
- Invent information you don't have — if you don't know, say so and offer
  to have staff follow up

If the patient seems to be describing a medical emergency, tell them to call
911 or go to the nearest ER immediately, do not continue the conversation
normally.
`.trim();

const STAFF_SYSTEM_PROMPT = `
You are AuthPilot's internal assistant for hospital billing/appeals staff on
WhatsApp. You are concise and operational — staff are busy, answer in 2-4
sentences unless they ask for detail.

You CAN:
- Explain why the agent made a particular decision on a case, using the
  case's trace/reasoning data provided to you
- Summarize a case's current status, confidence, and open issues
- Explain AuthPilot's own decision logic/thresholds if asked
- Acknowledge when something needs a real fix in the dashboard rather than
  over WhatsApp, and say so plainly

You must NEVER:
- Take an action (approve/reject/change a case) based on conversational
  free text alone — if staff seem to be requesting an action, tell them to
  use the exact command format ("Approve <id>" / "Reject <id>") or the
  dashboard, since actions need an unambiguous, auditable trigger
- Guess at a case ID if one wasn't clearly provided — ask which case they mean
`.trim();

interface ConversationalContext {
  role: "patient" | "staff";
  from: string;
  message: string;
  relatedCase?: {
    id: string;
    status: string;
    confidence?: number;
    lastReasoningSummary?: string; // short, non-PHI summary of the latest decision/trace step
  } | null;
}

async function handleConversationalFallback(ctx: ConversationalContext) {
  const systemPrompt = ctx.role === "patient" ? PATIENT_SYSTEM_PROMPT : STAFF_SYSTEM_PROMPT;

  const caseContextBlock = ctx.relatedCase
    ? `Relevant case: id=${ctx.relatedCase.id}, status=${ctx.relatedCase.status}, ` +
      `confidence=${ctx.relatedCase.confidence ?? "n/a"}, ` +
      `latest reasoning summary="${ctx.relatedCase.lastReasoningSummary ?? "none available"}"`
    : "No open case found linked to this phone number.";

  const result = await callQwen({
    model: "qwen-max",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "system", content: caseContextBlock },
      { role: "user", content: ctx.message },
    ],
  });

  await sendWhatsAppText(ctx.from, result.text.trim());

  await prisma.whatsAppMessage.create({
    data: {
      caseId: ctx.relatedCase?.id,
      direction: "outbound",
      sender: ctx.from,
      role: ctx.role,
      content: result.text.trim(),
      messageType: "conversational",
    },
  });
}

// ---------------------------------------------------------------------------
// 3. Wiring: where this plugs into the original handlePatientMessage /
//    handleStaffMessage functions
// ---------------------------------------------------------------------------

// In handlePatientMessage(), AFTER checking STATUS_QUERY_PATTERN and BEFORE
// falling through to "treat as new intake trigger" — add an intent check:
// if the message doesn't look like a denial/appeal description at all (e.g.
// it's a question, or too short/ambiguous), route to the conversational
// fallback instead of blindly creating a new case out of it.
//
// Simple heuristic + LLM combo (cheap heuristic first, avoids a wasted call):
//
//   const looksLikeAQuestion = /\?$/.test(content.trim()) || content.trim().split(" ").length < 4;
//   if (looksLikeAQuestion) {
//     const existingCase = await findMostRecentOpenCase(from);
//     await handleConversationalFallback({
//       role: "patient", from, message: content,
//       relatedCase: existingCase ? toContext(existingCase) : null,
//     });
//     return;
//   }
//
// In handleStaffMessage(), AFTER checking all four command patterns and
// finding no match — replace the generic "I didn't recognize that command"
// reply with the conversational fallback, passing along whichever case ID
// (if any) can be parsed loosely from the message so the assistant has
// context to explain reasoning, status, etc.
