// app/api/webhooks/whatsapp/route.ts
//
// WhatsApp Cloud API webhook for AuthPilot.
// Handles:
//   - Meta's webhook verification handshake (GET)
//   - Incoming messages from patients and staff (POST)
//
// Routing logic implemented here:
//   PATIENT (role resolved by phone number NOT being in the STAFF_NUMBERS list):
//     - free text  -> create new Case, kick off agent pipeline
//     - image      -> OCR/vision extract, then same as free text
//     - "status" style question on an existing open case -> generic status reply, no pipeline re-run
//
//   STAFF (phone number IS in STAFF_NUMBERS):
//     - "Approve <caseId>"  -> same effect as clicking Approve & Send in dashboard
//     - "Reject <caseId>"   -> moves case to human-review queue
//     - "Status <caseId>"   -> one-line status summary
//     - "Show <caseId>"     -> replies with a link to the case detail page
//
// All WhatsApp-originated actions are logged as WhatsAppMessage rows AND as
// TraceStep / ExtractedField rows so the audit trail has no gap between channels.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runAgentPipeline } from "@/lib/agentRunner";
import { extractTextFromImage } from "@/lib/documentExtraction";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN!;
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN!;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID!;
const APP_BASE_URL = process.env.APP_BASE_URL!; // for "Show <id>" links

// Hardcode or pull from DB — phone numbers recognized as hospital/billing staff.
// Numbers must be in E.164 format without "+", matching how Meta sends `from`.
const STAFF_NUMBERS = new Set(
  (process.env.WHATSAPP_STAFF_NUMBERS ?? "").split(",").map((n) => n.trim()).filter(Boolean)
);

// ---------------------------------------------------------------------------
// GET — webhook verification handshake (Meta calls this once when you
// register the webhook URL in the Meta App dashboard)
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

// ---------------------------------------------------------------------------
// POST — incoming message/event payloads
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const body = await req.json();

  // Always ack fast so Meta doesn't retry-storm you; do the work, then return 200.
  try {
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) {
      // Could be a status callback (delivered/read) — nothing to do.
      return NextResponse.json({ ok: true });
    }

    for (const message of messages) {
      await handleIncomingMessage(message, value);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    // Still return 200 — returning an error causes Meta to retry the same
    // payload repeatedly, which will duplicate cases. Log and move on.
    return NextResponse.json({ ok: true });
  }
}

// ---------------------------------------------------------------------------
// Core routing
// ---------------------------------------------------------------------------

async function handleIncomingMessage(message: any, value: any) {
  const from: string = message.from; // phone number, no "+"
  const isStaff = STAFF_NUMBERS.has(from);
  const contactName = value?.contacts?.[0]?.profile?.name ?? "Unknown";

  let content = "";
  let messageType: "trigger" | "status_update" | "approval_action" | "notification" = "trigger";

  if (message.type === "text") {
    content = message.text.body.trim();
  } else if (message.type === "image") {
    const mediaId = message.image.id;
    content = await extractTextFromImage(mediaId, WHATSAPP_TOKEN); // OCR/vision on the denial letter photo
  } else {
    // Unsupported type (audio, video, location, etc.) for this prototype.
    await sendWhatsAppText(
      from,
      "Sorry, we can only process text messages and photos of documents right now. Please try again or call our office."
    );
    return;
  }

  // Log the raw inbound message immediately, before any routing decision.
  await prisma.whatsAppMessage.create({
    data: {
      direction: "inbound",
      sender: from,
      role: isStaff ? "staff" : "patient",
      content,
      messageType,
    },
  });

  if (isStaff) {
    await handleStaffMessage(from, content);
  } else {
    await handlePatientMessage(from, contactName, content);
  }
}

// ---------------------------------------------------------------------------
// Patient-side handling
// ---------------------------------------------------------------------------

const STATUS_QUERY_PATTERN = /\b(status|update|what'?s happening|any news)\b/i;

async function handlePatientMessage(from: string, contactName: string, content: string) {
  // If this looks like a status check and they already have an open case,
  // reply with a generic status update instead of creating a new case.
  if (STATUS_QUERY_PATTERN.test(content)) {
    const existingCase = await prisma.case.findFirst({
      where: { patientPhone: from, status: { notIn: ["Resolved", "DeniedFinal"] } },
      orderBy: { createdAt: "desc" },
    });

    if (existingCase) {
      await sendWhatsAppText(from, genericStatusMessage(existingCase.status));
      return;
    }
    // No open case found — fall through and treat as a new trigger.
  }

  // Otherwise: treat this as a new intake trigger.
  const newCase = await prisma.case.create({
    data: {
      intakeType: "whatsapp_patient_note",
      rawIntakeText: content,
      patientPhone: from,
      patientNameHint: contactName,
      status: "New",
    },
  });

  await prisma.whatsAppMessage.update({
    where: { id: (await mostRecentInboundId(from)) },
    data: { caseId: newCase.id },
  });

  // Acknowledge immediately — do not make the patient wait on the pipeline.
  await sendWhatsAppText(
    from,
    "We've received your message about your insurance issue and started reviewing it. We'll update you here as soon as we have next steps."
  );

  // Kick off the agent pipeline async — do not block the webhook response on this.
  runAgentPipeline(newCase.id).catch((err) =>
    console.error(`Agent pipeline failed for case ${newCase.id}:`, err)
  );

  // Notify staff a new case landed.
  await notifyStaffNewCase(newCase.id, contactName);
}

function genericStatusMessage(status: string): string {
  switch (status) {
    case "New":
    case "Investigating":
      return "We're still reviewing your case. We'll update you here as soon as we have next steps.";
    case "NeedsHumanInput":
      return "We need one more document to move your case forward. Please check your patient portal or call our office for details.";
    case "AwaitingApproval":
      return "Your case is being reviewed internally and should move forward shortly.";
    case "AppealSent":
      return "An appeal has been submitted on your behalf. This typically takes a few business days. We'll let you know as soon as we hear back.";
    default:
      return "There's an update on your case. Please check your patient portal or call our office for the details.";
  }
}

async function mostRecentInboundId(from: string) {
  const row = await prisma.whatsAppMessage.findFirst({
    where: { sender: from, direction: "inbound" },
    orderBy: { timestamp: "desc" },
  });
  return row!.id;
}

// ---------------------------------------------------------------------------
// Staff-side handling
// ---------------------------------------------------------------------------

// Matches: "Approve 114", "approve #114", "APPROVE case 114"
const APPROVE_PATTERN = /^approve\s*#?(?:case\s*)?(\w+)/i;
const REJECT_PATTERN = /^reject\s*#?(?:case\s*)?(\w+)/i;
const STATUS_PATTERN = /^status\s*#?(?:case\s*)?(\w+)/i;
const SHOW_PATTERN = /^show\s*#?(?:case\s*)?(\w+)/i;

async function handleStaffMessage(from: string, content: string) {
  const approveMatch = content.match(APPROVE_PATTERN);
  const rejectMatch = content.match(REJECT_PATTERN);
  const statusMatch = content.match(STATUS_PATTERN);
  const showMatch = content.match(SHOW_PATTERN);

  if (approveMatch) return handleStaffApprove(from, approveMatch[1]);
  if (rejectMatch) return handleStaffReject(from, rejectMatch[1]);
  if (statusMatch) return handleStaffStatus(from, statusMatch[1]);
  if (showMatch) return handleStaffShow(from, showMatch[1]);

  await sendWhatsAppText(
    from,
    "I didn't recognize that command. Try: 'Approve <case id>', 'Reject <case id>', 'Status <case id>', or 'Show <case id>'."
  );
}

async function handleStaffApprove(from: string, caseId: string) {
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c) return sendWhatsAppText(from, `No case found with id ${caseId}.`);

  // Reuse the exact same action endpoint logic the dashboard button calls,
  // so behavior (PDF generation, status transition, audit logging) is identical
  // regardless of channel.
  await performCaseAction(caseId, "approve", { source: "whatsapp", actor: from });

  await prisma.traceStep.create({
    data: {
      caseId,
      stepType: "human_action",
      reasoning: `Approved via WhatsApp by staff number ${from}`,
    },
  });

  await sendWhatsAppText(from, `✅ Case ${caseId} approved. Appeal is being sent now.`);
}

async function handleStaffReject(from: string, caseId: string) {
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c) return sendWhatsAppText(from, `No case found with id ${caseId}.`);

  await performCaseAction(caseId, "reject", { source: "whatsapp", actor: from });

  await prisma.traceStep.create({
    data: {
      caseId,
      stepType: "human_action",
      reasoning: `Rejected via WhatsApp by staff number ${from}`,
    },
  });

  await sendWhatsAppText(from, `❌ Case ${caseId} rejected and moved to the manual review queue.`);
}

async function handleStaffStatus(from: string, caseId: string) {
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c) return sendWhatsAppText(from, `No case found with id ${caseId}.`);

  const daysLeft = Math.ceil((c.slaDeadline.getTime() - Date.now()) / 86_400_000);
  const confidence = (c.recommendation as any)?.confidence ?? "n/a";

  await sendWhatsAppText(
    from,
    `Case ${caseId}: ${c.status} | Confidence: ${confidence} | ${daysLeft} day(s) left on deadline.`
  );
}

async function handleStaffShow(from: string, caseId: string) {
  await sendWhatsAppText(from, `View case ${caseId} here: ${APP_BASE_URL}/case/${caseId}`);
}

// ---------------------------------------------------------------------------
// Staff notifications (outbound, triggered by pipeline events elsewhere in
// the app — e.g. called from agentRunner.ts when a case reaches
// AwaitingApproval, or from a cron checking SLA deadlines)
// ---------------------------------------------------------------------------

export async function notifyStaffNewCase(caseId: string, patientNameHint: string) {
  const text = `New case ${caseId} created from patient message: ${patientNameHint}. Reply 'Show ${caseId}' to view.`;
  await broadcastToStaff(text, caseId, "notification");
}

export async function notifyStaffApprovalNeeded(caseId: string, oneLineSummary: string, confidence: number) {
  const text = `Case ${caseId} ready for approval: ${oneLineSummary}. Confidence ${confidence}%. Reply 'Approve ${caseId}' or 'Reject ${caseId}', or open the dashboard.`;
  await broadcastToStaff(text, caseId, "notification");
}

export async function notifyStaffSlaWarning(caseId: string, daysLeft: number) {
  const text = `⚠️ Case ${caseId} has ${daysLeft} day(s) left before the appeal deadline and is still awaiting approval.`;
  await broadcastToStaff(text, caseId, "notification");
}

export async function notifyStaffVerificationFlag(caseId: string, issue: string) {
  const text = `Case ${caseId} flagged by verification: ${issue}. Needs manual review before approval.`;
  await broadcastToStaff(text, caseId, "notification");
}

async function broadcastToStaff(text: string, caseId: string, messageType: string) {
  for (const number of STAFF_NUMBERS) {
    await sendWhatsAppText(number, text);
    await prisma.whatsAppMessage.create({
      data: { caseId, direction: "outbound", sender: number, role: "staff", content: text, messageType },
    });
  }
}

// ---------------------------------------------------------------------------
// Outbound send helper (WhatsApp Cloud API)
// ---------------------------------------------------------------------------

export async function sendWhatsAppText(to: string, body: string) {
  await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });

  await prisma.whatsAppMessage.create({
    data: { direction: "outbound", sender: to, role: "unknown", content: body, messageType: "status_update" },
  });
}

// ---------------------------------------------------------------------------
// Placeholder tying into your existing /api/cases/[id]/action logic.
// Replace this with a direct import + call of that handler's core function
// so WhatsApp and dashboard approvals share one code path exactly.
// ---------------------------------------------------------------------------

async function performCaseAction(
  caseId: string,
  action: "approve" | "reject" | "edit" | "request_more_evidence",
  meta: { source: string; actor: string }
) {
  // TODO: import and call the same function used by
  // POST /api/cases/[id]/action so there is exactly one implementation
  // of "what happens when a case is approved/rejected", regardless of channel.
  throw new Error("Wire this up to your existing case-action handler.");
}
