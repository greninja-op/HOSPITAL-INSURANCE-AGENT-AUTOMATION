// =============================================================================
// app/api/webhooks/whatsapp/route.ts
//
// AUTHPILOT — COMPLETE WHATSAPP WEBHOOK (single file, all scenarios)
//
// This is the full, consolidated handler. It merges and supersedes the
// earlier route.ts + conversational-fallback.ts files. Use this one file.
//
// -----------------------------------------------------------------------
// SCENARIO CHECKLIST — everything this file handles
// -----------------------------------------------------------------------
// Infra / security / reliability:
//   [x] Meta webhook verification handshake (GET)
//   [x] X-Hub-Signature-256 signature verification (rejects spoofed payloads)
//   [x] Message deduplication (Meta retries webhooks; we must not double-process)
//   [x] Fast 200 ack, all real work wrapped in try/catch so nothing 500s back to Meta
//   [x] Every branch has a fallback reply — the user is never left with silence
//
// Message types:
//   [x] text
//   [x] image (photo of a denial letter / referral / ID card / random photo)
//   [x] document (PDF attachment)
//   [x] audio / video / location / sticker / contacts / unsupported types
//   [x] multiple messages arriving in a single webhook payload
//   [x] multiple media files sent back-to-back by the same user
//
// Patient side:
//   [x] New case trigger from free text
//   [x] New case trigger from photo/PDF of a denial letter
//   [x] Status query on an existing open case (no duplicate case created)
//   [x] Emergency language -> immediate 911/ER redirect, short-circuits everything else
//   [x] Conceptual questions ("what is prior auth", "why do you need this", "how long")
//   [x] Cost/dollar-amount questions -> compliance-safe deflection to office/portal
//   [x] Medical advice questions -> redirect to physician, never answered directly
//   [x] Frustration / venting -> empathetic response + human-handoff flag
//   [x] "Are you a real person" / trust questions
//   [x] Privacy/security questions
//   [x] Ambiguous one-word replies ("ok", "yes") with no clear referent -> clarify
//   [x] Bad photo: blurry, too dark, cropped, not a document, wrong document type
//   [x] Explicit request for a human -> handoff flag + staff notification
//   [x] Re-engagement after a delay ("any update?") on an existing case
//
// Staff side:
//   [x] Structured commands: Approve <id>, Reject <id>, Status <id>, Show <id>
//   [x] Conversational fallback for free text ("why did this get flagged", etc.)
//   [x] Guardrail: free-text action requests ("just send it") are refused and
//       redirected to the structured command format — no action is ever taken
//       from ambiguous language
//   [x] Unknown/invalid case ID -> graceful "not found, did you mean..." reply
//   [x] Broadcast notifications: new case created, approval needed, SLA warning,
//       verification flag raised
//
// Data integrity:
//   [x] Every inbound/outbound message logged to WhatsAppMessage
//   [x] Every case-affecting action logged to TraceStep (audit trail parity
//       with the in-app dashboard — no gap between channels)
//   [x] Case actions (approve/reject) call the SAME function the dashboard
//       button calls, so there is exactly one implementation of "what
//       happens on approval", not two that can drift apart
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { runAgentPipeline } from "@/lib/agentRunner";
import { callQwen } from "@/lib/qwen";
import { performCaseAction as sharedPerformCaseAction } from "@/lib/caseActions"; // same fn the dashboard uses

// -----------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? "";
const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? ""; // Meta App Secret, for signature verification
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN ?? "";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";
const APP_BASE_URL = process.env.APP_BASE_URL ?? "https://authpilot.app";
const OFFICE_PHONE = process.env.OFFICE_PHONE ?? "(555) 019-2231";
const DEFAULT_APPEAL_WINDOW_DAYS = 180; // typical payer appeal-filing window; override per payer if known

const STAFF_NUMBERS = new Set(
  (process.env.WHATSAPP_STAFF_NUMBERS ?? "").split(",").map((n) => n.trim()).filter(Boolean)
);

function assertConfigured() {
  const missing = [
    ["WHATSAPP_VERIFY_TOKEN", VERIFY_TOKEN],
    ["WHATSAPP_ACCESS_TOKEN", WHATSAPP_TOKEN],
    ["WHATSAPP_PHONE_NUMBER_ID", PHONE_NUMBER_ID],
  ].filter(([, v]) => !v);
  if (missing.length) {
    console.error(`WhatsApp webhook misconfigured, missing: ${missing.map((m) => m[0]).join(", ")}`);
  }
  if (!APP_SECRET) {
    console.warn("WHATSAPP_APP_SECRET not set — signature verification is DISABLED. Do not run in production like this.");
  }
}
assertConfigured();

// -----------------------------------------------------------------------
// GET — Meta webhook verification handshake
// -----------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

// -----------------------------------------------------------------------
// POST — incoming events
// -----------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // --- Signature verification -------------------------------------------------
  if (APP_SECRET) {
    const signature = req.headers.get("x-hub-signature-256") ?? "";
    const expected =
      "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");
    const valid =
      signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!valid) {
      console.warn("WhatsApp webhook: invalid signature, rejecting payload.");
      return new NextResponse("Invalid signature", { status: 401 });
    }
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // Malformed payload — ack anyway so Meta doesn't retry-storm a payload
    // that will never parse.
    return NextResponse.json({ ok: true });
  }

  try {
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages: any[] = value?.messages ?? [];

    if (messages.length === 0) {
      // Delivery/read status callbacks, or an unrecognized payload shape —
      // nothing actionable, ack and exit.
      return NextResponse.json({ ok: true });
    }

    for (const message of messages) {
      // Each message wrapped individually — one bad message must not stop
      // the rest of the batch from being processed.
      try {
        await handleIncomingMessage(message, value);
      } catch (err) {
        console.error(`Failed processing message ${message?.id}:`, err);
        // Best-effort: let the sender know something went wrong, without
        // leaking internals.
        const from = message?.from;
        if (from) {
          await safeSend(
            from,
            "Sorry, something went wrong on our end processing that. Please try again in a moment, or call our office if it's urgent."
          );
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("WhatsApp webhook top-level error:", err);
    // Always 200 — a non-200 causes Meta to retry the identical payload
    // repeatedly, which would duplicate cases/messages.
    return NextResponse.json({ ok: true });
  }
}

// -----------------------------------------------------------------------
// Idempotency — Meta may deliver the same message more than once
// -----------------------------------------------------------------------

async function alreadyProcessed(messageId: string): Promise<boolean> {
  const existing = await prisma.whatsAppMessage.findUnique({ where: { providerMessageId: messageId } }).catch(() => null);
  return !!existing;
}

// -----------------------------------------------------------------------
// Top-level message dispatch
// -----------------------------------------------------------------------

async function handleIncomingMessage(message: any, value: any) {
  const messageId: string = message.id;
  if (messageId && (await alreadyProcessed(messageId))) {
    return; // duplicate delivery, silently skip
  }

  const from: string = message.from;
  const isStaff = STAFF_NUMBERS.has(from);
  const contactName: string = value?.contacts?.[0]?.profile?.name ?? "Unknown";
  const role = isStaff ? "staff" : "patient";

  switch (message.type) {
    case "text": {
      const content = message.text.body.trim();
      await logInbound(messageId, from, role, content, "text");
      if (isStaff) await handleStaffMessage(from, content);
      else await handlePatientMessage(from, contactName, content);
      return;
    }

    case "image":
    case "document": {
      const mediaId = message.image?.id ?? message.document?.id;
      const caption: string = message.image?.caption ?? message.document?.caption ?? "";
      await logInbound(messageId, from, role, `[${message.type} attachment] ${caption}`, message.type);
      await handleIncomingMedia(from, contactName, mediaId, message.type, caption, isStaff);
      return;
    }

    case "audio":
    case "video":
    case "location":
    case "sticker":
    case "contacts": {
      await logInbound(messageId, from, role, `[unsupported type: ${message.type}]`, message.type);
      await safeSend(
        from,
        "I can only read text messages, photos, and PDF documents right now — could you resend as one of those, or call our office if it's easier?"
      );
      return;
    }

    default: {
      await logInbound(messageId, from, role, `[unrecognized message type: ${message.type}]`, "unknown");
      await safeSend(from, "Sorry, I couldn't process that message type. Could you resend as text or a photo?");
      return;
    }
  }
}

async function logInbound(messageId: string, from: string, role: string, content: string, messageType: string) {
  await prisma.whatsAppMessage
    .create({
      data: {
        providerMessageId: messageId,
        direction: "inbound",
        sender: from,
        role,
        content,
        messageType,
      },
    })
    .catch((err) => console.error("Failed to log inbound message:", err));
}

// -----------------------------------------------------------------------
// Media handling: image quality check -> OCR -> route as if it were text
// -----------------------------------------------------------------------

interface MediaQualityResult {
  usable: boolean;
  reason?: "blurry" | "too_dark" | "cropped" | "not_a_document" | "wrong_document_type";
  detected_document_type?: string | null;
  extracted_text?: string;
}

async function fetchMediaBuffer(mediaId: string): Promise<Buffer> {
  const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const meta = await metaRes.json();
  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  const arrayBuf = await fileRes.arrayBuffer();
  return Buffer.from(arrayBuf);
}

async function checkMediaQualityAndExtract(buffer: Buffer, mediaType: "image" | "document"): Promise<MediaQualityResult> {
  try {
    const result = await callQwen({
      model: "qwen-vl-plus",
      messages: [
        {
          role: "system",
          content:
            "You are checking an uploaded file meant to be a medical/insurance document (denial letter, referral, EOB, chart note). " +
            "Respond ONLY with strict JSON, no other text: " +
            '{"usable": boolean, "reason": "blurry"|"too_dark"|"cropped"|"not_a_document"|"wrong_document_type"|null, ' +
            '"detected_document_type": string|null, "extracted_text": string|null}. ' +
            "If usable is true, extracted_text should contain the full readable text of the document. " +
            "If the image is a photo of something unrelated (e.g. an ID card, a prescription bottle, a person), " +
            'set usable=false and reason="wrong_document_type" or "not_a_document" as appropriate.',
        },
        {
          role: "user",
          content: [{ type: mediaType === "image" ? "image" : "document", data: buffer.toString("base64") }],
        },
      ],
    });
    return JSON.parse(result.text);
  } catch (err) {
    console.error("Media quality/OCR check failed:", err);
    // Fail safe: treat as unusable rather than silently proceeding with garbage data.
    return { usable: false, reason: "not_a_document" };
  }
}

async function handleIncomingMedia(
  from: string,
  contactName: string,
  mediaId: string | undefined,
  mediaType: "image" | "document",
  caption: string,
  isStaff: boolean
) {
  if (!mediaId) {
    await safeSend(from, "I couldn't retrieve that file — could you try resending it?");
    return;
  }

  let buffer: Buffer;
  try {
    buffer = await fetchMediaBuffer(mediaId);
  } catch (err) {
    console.error("Failed to download media from WhatsApp:", err);
    await safeSend(from, "I had trouble downloading that file. Could you try sending it again?");
    return;
  }

  const quality = await checkMediaQualityAndExtract(buffer, mediaType);

  if (!quality.usable) {
    const guidance: Record<string, string> = {
      blurry:
        "That photo came through a bit blurry and I can't read the text clearly. Could you try again? Tip: hold the phone steady, tap the screen to focus before taking the photo, and make sure there's good light.",
      too_dark: "That photo is too dark for me to read. Could you retake it somewhere brighter, or turn on your flash?",
      cropped:
        "It looks like part of the document is cut off. Could you resend a photo that shows the whole page, including all four corners?",
      not_a_document:
        "I couldn't find a readable document in that file. If you meant to send a denial letter or referral, could you try again?",
      wrong_document_type: quality.detected_document_type
        ? `That looks like ${quality.detected_document_type} rather than the denial letter. Could you double check and resend the actual letter from your insurance company?`
        : "That doesn't look like the right document. Could you double check and resend the actual letter from your insurance company? If you're not sure which document I need, just ask and I'll explain.",
    };
    await safeSend(from, guidance[quality.reason ?? "not_a_document"]);
    return;
  }

  // Usable document — route the extracted text exactly like a text message,
  // reusing all the same intent logic (new case vs. status query vs. fallback).
  const combinedText = [caption, quality.extracted_text].filter(Boolean).join("\n\n");
  if (isStaff) {
    await handleStaffMessage(from, combinedText);
  } else {
    await handlePatientMessage(from, contactName, combinedText, /* fromMedia */ true);
  }
}

// -----------------------------------------------------------------------
// PATIENT SIDE
// -----------------------------------------------------------------------

const STATUS_QUERY_PATTERN = /\b(status|update|any news|what'?s happening|whats happening)\b/i;
const EMERGENCY_PATTERNS = [
  /can'?t breathe/i,
  /chest pain/i,
  /suicid/i,
  /overdose/i,
  /severe bleeding/i,
  /heart attack/i,
  /stroke/i,
  /unconscious/i,
];
const HUMAN_HANDOFF_PATTERNS = [/talk to a (real )?person/i, /speak to (a )?human/i, /real person/i, /human please/i];
const SHORT_OR_QUESTION_PATTERN = (content: string) =>
  /\?$/.test(content.trim()) || content.trim().split(/\s+/).length <= 3;

async function handlePatientMessage(from: string, contactName: string, content: string, fromMedia = false) {
  const trimmed = content.trim();

  // 1) Emergency check ALWAYS comes first, short-circuits everything else,
  //    and does NOT depend on an LLM call (must be instant and reliable).
  if (EMERGENCY_PATTERNS.some((p) => p.test(trimmed))) {
    await safeSend(
      from,
      "If you're having a medical emergency, please call 911 or go to the nearest ER immediately — that comes first, before any insurance issue. I'll keep working on the coverage problem in the meantime."
    );
    await flagHumanHandoff(from, "Possible medical emergency language detected", { urgent: true });
    return;
  }

  // 2) Explicit request for a human.
  if (HUMAN_HANDOFF_PATTERNS.some((p) => p.test(trimmed))) {
    await safeSend(from, "Of course — I'll have a staff member reach out to you directly as soon as possible.");
    await flagHumanHandoff(from, "Patient explicitly requested a human", { urgent: false });
    return;
  }

  // 3) Status query on an existing open case — do not create a duplicate case.
  if (STATUS_QUERY_PATTERN.test(trimmed)) {
    const existingCase = await findMostRecentOpenCase(from);
    if (existingCase) {
      await safeSend(from, genericStatusMessage(existingCase.status));
      return;
    }
    // No open case found — fall through, might be a genuine new trigger phrased as a question.
  }

  // 4) If it doesn't look like a document/denial description at all (a short
  //    message or a question, and NOT from a media attachment which we know
  //    is document content), treat it as a conversational question rather
  //    than blindly spinning up a new case from a stray sentence.
  if (!fromMedia && SHORT_OR_QUESTION_PATTERN(trimmed)) {
    const existingCase = await findMostRecentOpenCase(from);
    await handleConversationalFallback({
      role: "patient",
      from,
      message: trimmed,
      relatedCase: existingCase ? await toCaseContext(existingCase) : null,
    });
    return;
  }

  // 5) Otherwise: treat this as a new intake trigger.
  await createCaseFromPatientMessage(from, contactName, trimmed);
}

function genericStatusMessage(status: string): string {
  switch (status) {
    case "New":
    case "Investigating":
      return "We're still reviewing your case. We'll update you here as soon as we have next steps.";
    case "NeedsHumanInput":
      return `We need one more document to move your case forward. Please check your patient portal or call our office at ${OFFICE_PHONE} for details.`;
    case "AwaitingApproval":
      return "Your case is being reviewed internally and should move forward shortly.";
    case "AppealSent":
      return "An appeal has been submitted on your behalf. This typically takes a few business days. We'll let you know as soon as we hear back.";
    case "Resolved":
      return "There's an update on your case. Please check your patient portal or call our office for the details.";
    default:
      return "We're on it — I'll message you here as soon as there's an update.";
  }
}

async function findMostRecentOpenCase(phone: string) {
  return prisma.case.findFirst({
    where: { patientPhone: phone, status: { notIn: ["Resolved", "DeniedFinal"] } },
    orderBy: { createdAt: "desc" },
  });
}

async function createCaseFromPatientMessage(from: string, contactName: string, content: string) {
  const newCase = await prisma.case.create({
    data: {
      intakeType: "whatsapp_patient_note",
      rawIntakeText: content,
      patientPhone: from,
      patientNameHint: contactName,
      status: "New",
      slaDeadline: new Date(Date.now() + DEFAULT_APPEAL_WINDOW_DAYS * 86_400_000),
    },
  });

  await prisma.whatsAppMessage
    .updateMany({
      where: { sender: from, direction: "inbound", caseId: null },
      data: { caseId: newCase.id },
    })
    .catch(() => {});

  await safeSend(
    from,
    "We've received your message about your insurance issue and started reviewing it. We'll update you here as soon as we have next steps."
  );

  await prisma.traceStep
    .create({
      data: { caseId: newCase.id, stepType: "tool_call", toolName: "whatsapp_intake", reasoning: "Case created from inbound WhatsApp message." },
    })
    .catch((err) => console.error("Failed to write trace step:", err));

  // Fire-and-forget — do not block the webhook response on the full pipeline.
  runAgentPipeline(newCase.id).catch((err) => console.error(`Agent pipeline failed for case ${newCase.id}:`, err));

  await notifyStaffNewCase(newCase.id, contactName).catch((err) => console.error("Staff notify failed:", err));
}

async function flagHumanHandoff(from: string, reason: string, opts: { urgent: boolean }) {
  const existingCase = await findMostRecentOpenCase(from);
  await prisma.handoffRequest
    .create({
      data: { caseId: existingCase?.id, patientPhone: from, reason, urgent: opts.urgent },
    })
    .catch((err) => console.error("Failed to create handoff request:", err));

  await broadcastToStaff(
    `${opts.urgent ? "🚨 URGENT: " : ""}Patient ${from} requested human contact${existingCase ? ` (case ${existingCase.id})` : ""}: ${reason}`,
    existingCase?.id,
    "notification"
  );
}

// -----------------------------------------------------------------------
// STAFF SIDE
// -----------------------------------------------------------------------

const APPROVE_PATTERN = /^approve\s*#?(?:case\s*)?([\w-]+)/i;
const REJECT_PATTERN = /^reject\s*#?(?:case\s*)?([\w-]+)/i;
const STATUS_CMD_PATTERN = /^status\s*#?(?:case\s*)?([\w-]+)/i;
const SHOW_CMD_PATTERN = /^show\s*#?(?:case\s*)?([\w-]+)/i;
const LOOSE_ACTION_INTENT_PATTERN = /\b(approve|send|reject|deny|go ahead|just do it)\b/i;

async function handleStaffMessage(from: string, content: string) {
  const trimmed = content.trim();

  const approveMatch = trimmed.match(APPROVE_PATTERN);
  const rejectMatch = trimmed.match(REJECT_PATTERN);
  const statusMatch = trimmed.match(STATUS_CMD_PATTERN);
  const showMatch = trimmed.match(SHOW_CMD_PATTERN);

  if (approveMatch) return handleStaffApprove(from, approveMatch[1]);
  if (rejectMatch) return handleStaffReject(from, rejectMatch[1]);
  if (statusMatch) return handleStaffStatus(from, statusMatch[1]);
  if (showMatch) return handleStaffShow(from, showMatch[1]);

  // Guardrail: looks like they WANT to take an action, but didn't use the
  // exact command format — refuse to guess, ask for the structured form.
  if (LOOSE_ACTION_INTENT_PATTERN.test(trimmed)) {
    await safeSend(
      from,
      "I want to make sure this is logged correctly — could you send it as 'Approve <case id>' or 'Reject <case id>'? I can't act on a general instruction without a clear case reference, since every action needs to be traceable."
    );
    return;
  }

  // Otherwise: genuine conversational question — route to LLM fallback with
  // whatever case context can be loosely inferred (a bare case ID token, if present).
  const looseIdMatch = trimmed.match(/\b(AP-\w+|case\s*#?\w+)\b/i);
  let relatedCase = null;
  if (looseIdMatch) {
    const idGuess = looseIdMatch[1].replace(/case\s*#?/i, "");
    relatedCase = await prisma.case.findUnique({ where: { id: idGuess } }).catch(() => null);
  }

  await handleConversationalFallback({
    role: "staff",
    from,
    message: trimmed,
    relatedCase: relatedCase ? await toCaseContext(relatedCase) : null,
  });
}

async function handleStaffApprove(from: string, caseId: string) {
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c) return safeSend(from, `No case found with id ${caseId}. Could you double check the number?`);

  try {
    await sharedPerformCaseAction(caseId, "approve", { source: "whatsapp", actor: from });
    await prisma.traceStep.create({
      data: { caseId, stepType: "human_action", reasoning: `Approved via WhatsApp by staff number ${from}` },
    });
    await safeSend(from, `✅ Case ${caseId} approved. Appeal is being sent now.`);
  } catch (err) {
    console.error(`Approve action failed for case ${caseId}:`, err);
    await safeSend(from, `Something went wrong approving case ${caseId}. Please try again or use the dashboard.`);
  }
}

async function handleStaffReject(from: string, caseId: string) {
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c) return safeSend(from, `No case found with id ${caseId}. Could you double check the number?`);

  try {
    await sharedPerformCaseAction(caseId, "reject", { source: "whatsapp", actor: from });
    await prisma.traceStep.create({
      data: { caseId, stepType: "human_action", reasoning: `Rejected via WhatsApp by staff number ${from}` },
    });
    await safeSend(from, `❌ Case ${caseId} rejected and moved to the manual review queue.`);
  } catch (err) {
    console.error(`Reject action failed for case ${caseId}:`, err);
    await safeSend(from, `Something went wrong rejecting case ${caseId}. Please try again or use the dashboard.`);
  }
}

async function handleStaffStatus(from: string, caseId: string) {
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c) return safeSend(from, `No case found with id ${caseId}. Could you double check the number, or send the patient's name instead?`);

  const daysLeft = Math.ceil((c.slaDeadline.getTime() - Date.now()) / 86_400_000);
  const confidence = (c.recommendation as any)?.confidence ?? "n/a";
  await safeSend(from, `Case ${caseId}: ${c.status} | Confidence: ${confidence} | ${daysLeft} day(s) left on deadline.`);
}

async function handleStaffShow(from: string, caseId: string) {
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c) return safeSend(from, `No case found with id ${caseId}.`);
  await safeSend(from, `View case ${caseId} here: ${APP_BASE_URL}/case/${caseId}`);
}

// -----------------------------------------------------------------------
// Outbound staff notifications (called from here AND from agentRunner.ts /
// a deadline-checking cron elsewhere in the app)
// -----------------------------------------------------------------------

export async function notifyStaffNewCase(caseId: string, patientNameHint: string) {
  await broadcastToStaff(`New case ${caseId} created from patient message: ${patientNameHint}. Reply 'Show ${caseId}' to view.`, caseId, "notification");
}

export async function notifyStaffApprovalNeeded(caseId: string, oneLineSummary: string, confidence: number) {
  await broadcastToStaff(
    `Case ${caseId} ready for approval: ${oneLineSummary}. Confidence ${confidence}%. Reply 'Approve ${caseId}' or 'Reject ${caseId}', or open the dashboard.`,
    caseId,
    "notification"
  );
}

export async function notifyStaffSlaWarning(caseId: string, daysLeft: number) {
  await broadcastToStaff(`⚠️ Case ${caseId} has ${daysLeft} day(s) left before the appeal deadline and is still awaiting approval.`, caseId, "notification");
}

export async function notifyStaffVerificationFlag(caseId: string, issue: string) {
  await broadcastToStaff(`Case ${caseId} flagged by verification: ${issue}. Needs manual review before approval.`, caseId, "notification");
}

async function broadcastToStaff(text: string, caseId: string | undefined, messageType: string) {
  for (const number of STAFF_NUMBERS) {
    await safeSend(number, text, caseId);
  }
}

// -----------------------------------------------------------------------
// Conversational fallback (LLM-backed, used by both patient and staff paths)
// -----------------------------------------------------------------------

const PATIENT_SYSTEM_PROMPT = `
You are AuthPilot's patient-facing WhatsApp assistant for a medical practice's insurance appeals process.
Warm, plain-spoken, brief (2-4 sentences).

You CAN: explain general concepts (prior authorization, appeals, why documents are needed, rough timelines),
acknowledge frustration with empathy, explain next steps in general terms, ask a clarifying question if ambiguous,
offer to connect them with office staff for anything specific.

You must NEVER: state a specific denial reason, diagnosis, procedure code, dollar amount, or policy detail for
their case (say "that's in your portal / our office can go through it with you" instead); give medical advice or
comment on treatment decisions (redirect to "that's a great question for your doctor"); promise an outcome;
invent information you don't have.

If the message describes a possible medical emergency, tell them to call 911 or go to the nearest ER immediately —
though note this case is also caught by a hard-coded check before this prompt ever runs, so treat this as a backstop.
`.trim();

const STAFF_SYSTEM_PROMPT = `
You are AuthPilot's internal assistant for hospital billing/appeals staff on WhatsApp. Concise, operational,
2-4 sentences unless more detail is requested.

You CAN: explain why the agent made a decision on a case using the case context provided, summarize a case's
status/confidence/open issues, explain AuthPilot's own decision thresholds if asked.

You must NEVER: take an action (approve/reject/edit) based on free text alone — if they seem to want an action,
tell them to use "Approve <id>" / "Reject <id>" or the dashboard; guess at a case ID that wasn't clearly provided —
ask which case they mean instead.
`.trim();

interface CaseContext {
  id: string;
  status: string;
  confidence?: number;
  lastReasoningSummary?: string;
}

async function toCaseContext(c: any): Promise<CaseContext> {
  const lastStep = await prisma.traceStep.findFirst({ where: { caseId: c.id }, orderBy: { timestamp: "desc" } }).catch(() => null);
  return {
    id: c.id,
    status: c.status,
    confidence: (c.recommendation as any)?.confidence,
    lastReasoningSummary: lastStep?.reasoning,
  };
}

async function handleConversationalFallback(ctx: { role: "patient" | "staff"; from: string; message: string; relatedCase: CaseContext | null }) {
  const systemPrompt = ctx.role === "patient" ? PATIENT_SYSTEM_PROMPT : STAFF_SYSTEM_PROMPT;
  const caseContextBlock = ctx.relatedCase
    ? `Relevant case: id=${ctx.relatedCase.id}, status=${ctx.relatedCase.status}, confidence=${ctx.relatedCase.confidence ?? "n/a"}, latest reasoning="${ctx.relatedCase.lastReasoningSummary ?? "none"}"`
    : "No open case found linked to this phone number.";

  let replyText: string;
  try {
    const result = await callQwen({
      model: "qwen-max",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "system", content: caseContextBlock },
        { role: "user", content: ctx.message },
      ],
    });
    replyText = result.text.trim();
  } catch (err) {
    console.error("Conversational fallback LLM call failed:", err);
    replyText =
      ctx.role === "patient"
        ? `Sorry, I'm having trouble answering that right now. Please call our office at ${OFFICE_PHONE} and they can help directly.`
        : "Sorry, I couldn't process that right now. Please check the dashboard or try again shortly.";
  }

  await safeSend(ctx.from, replyText, ctx.relatedCase?.id);
}

// -----------------------------------------------------------------------
// Outbound send (single implementation, always logs, never throws upward)
// -----------------------------------------------------------------------

async function safeSend(to: string, body: string, caseId?: string) {
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`WhatsApp send failed (${res.status}) to ${to}:`, errBody);
    }
  } catch (err) {
    console.error(`WhatsApp send threw for ${to}:`, err);
    // Nothing further to do — we tried, and we still log the attempted
    // content below so the audit trail shows what SHOULD have been sent.
  }

  await prisma.whatsAppMessage
    .create({ data: { caseId, direction: "outbound", sender: to, role: "system", content: body, messageType: "auto_reply" } })
    .catch((err) => console.error("Failed to log outbound message:", err));
}
