# WhatsApp Integration Spec — AuthPilot

> **Status:** Draft / parked for later. This document is a captured specification only.
> No requirements, design, tasks, or code have been generated from it yet.
>
> **Safety boundary:** PHI-adjacent detail stays in the app / PDF. WhatsApp carries
> triggers, generic status, and staff approvals only.

## 1. Patient side — what they can send (inbound triggers)

| Patient sends | Agent behavior |
|---|---|
| Free-text message like "insurance denied my MRI again" or "they said no to my surgery" | Creates a new Case with `intakeType: "whatsapp_patient_note"`, raw message stored as `rawIntakeText`, kicks off the normal agent pipeline (Intake & Extraction → Medical Review → Policy Review → Strategy → Decision) |
| A photo of a denial letter (image attachment) | Agent runs OCR/vision extraction on the image, treats output as the raw intake text, same pipeline as above |
| A reply to a status update (e.g. "what's happening with my case?") | Agent looks up their most recent open Case by phone number, replies with a templated generic status update (see below) — does **not** re-run the pipeline |

## 2. Patient side — what they receive (outbound, generic only, no PHI/case specifics)

| Trigger | Message sent to patient (template) |
|---|---|
| Case created | "We've received your message about your insurance issue and started reviewing it. We'll update you here as soon as we have next steps." |
| Agent needs more info (Case → Needs Human Input due to missing document) | "We need one more document to move your case forward. Please check your patient portal or call our office at [X] for details." (never states what's missing; that detail lives in-app only) |
| Appeal filed | "An appeal has been submitted on your behalf. This typically takes [X] business days. We'll let you know as soon as we hear back." |
| Resolved | "There's an update on your case. Please check your patient portal or call our office for the details." |

**Note:** all outbound patient messages must be pre-approved WhatsApp templates (required outside the 24-hour session window) — keep them generic and static precisely so they don't need per-case regeneration or re-approval.

## 3. Staff side — what they can do via WhatsApp (this is the differentiator)

| Staff sends | Agent behavior |
|---|---|
| Reply "Approve [case-id]" to a pending-approval notification | Triggers the same action as clicking "Approve & Send" in the dashboard — moves case to Appeal Sent, generates/sends the PDF, logs `human_action` in the audit trail with source "whatsapp" |
| Reply "Reject [case-id]" | Moves case to a human-review queue in the dashboard, logs the rejection reason if provided |
| Reply "Status [case-id]" or "Status [patient name]" | Agent replies with a one-line status summary (status + confidence + days remaining on SLA) |
| Reply "Show [case-id]" | Agent replies with a link to open the full Case Detail page in the app |

This is the part worth demoing live: a case reaches "Awaiting Approval," a WhatsApp notification pings a staff member's phone, they approve it from their phone, and the dashboard updates in real time. That's a strong visual beat for judges — approve-from-anywhere is a real operational win, not a gimmick.

## 4. Staff side — what they receive (outbound notifications)

| Trigger | Message sent to staff |
|---|---|
| New case created from a patient WhatsApp message | "New case #[id] created from patient message: [patient name], [payer]. Reply 'Show [id]' to view." |
| Agent recommendation ready (Awaiting Approval) | "Case #[id] ready for approval: [Decision Intelligence summary — 1 line]. Confidence [X]%. Reply 'Approve [id]' or 'Reject [id]', or open the dashboard." |
| SLA deadline approaching (e.g. 2 days left) | "⚠️ Case #[id] has [X] days left before the appeal deadline and is still awaiting approval." |
| Verification stage flags an issue | "Case #[id] flagged by verification: [1-line issue]. Needs manual review before approval." |

## 5. Data model addition needed

```prisma
model WhatsAppMessage {
  id          String   @id @default(cuid())
  caseId      String?
  direction   String   // "inbound" | "outbound"
  sender      String   // phone number
  role        String   // "patient" | "staff"
  content     String
  messageType String   // "trigger" | "status_update" | "approval_action" | "notification"
  timestamp   DateTime @default(now())
}
```

Every WhatsApp-originated action should still write a `TraceStep` / `ExtractedField` / audit entry exactly like the in-app flow does — the audit trail shouldn't have a gap just because the action came in over a different channel.

## 6. Open scope call (to decide before speccing)

Do you want **staff-side approval (Section 3)** included, or just **patient-side intake (Sections 1–2)**?

- Approval-from-WhatsApp is the more impressive feature, but it's the one that needs the webhook to reliably parse free-text replies like "Approve 114".
- Confirm the setup handles that reliably before committing to demoing it live.
