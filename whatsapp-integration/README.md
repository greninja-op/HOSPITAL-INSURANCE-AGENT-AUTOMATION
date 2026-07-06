# AuthPilot — WhatsApp Integration Package

A self-contained, ready-to-wire WhatsApp channel for AuthPilot, adapted to our stack
(Next.js 14 App Router + TypeScript + Prisma). It adds a **patient intake** channel,
**generic status** replies, and **staff approve-from-anywhere** — while keeping PHI out of
WhatsApp entirely (detail lives in the app / PDF).

> The base Next.js app isn't scaffolded yet, so the files here are organized to mirror where
> they land in the app. Once the app exists (tasks.md task 1), move `lib/**` → `lib/**`,
> `app/**` → `app/**`, merge `prisma/whatsapp.prisma` into `prisma/schema.prisma`, and fill in
> the wiring noted in the webhook route.

## What each file is (the hooks)

| File | Role |
|---|---|
| `app/api/whatsapp/webhook/route.ts` | Next.js route. `GET` = Meta verify handshake; `POST` = inbound (raw-body capture → HMAC verify → fast 200 → dedupe → parse → route → reply). `runtime = "nodejs"`. |
| `lib/whatsapp/signature.ts` | Constant-time `X-Hub-Signature-256` verification over the exact raw bytes. |
| `lib/whatsapp/parseInbound.ts` | Total parser: flattens Meta payloads and normalizes text / interactive / button / image / audio into `NormalizedInbound` (never drops a message). |
| `lib/whatsapp/sender.ts` | Outbound via Graph: text, templates, interactive buttons, and 24-hour-window fallback (one approved-template retry, no resend loop). |
| `lib/whatsapp/dedupe.ts` | Two-layer (in-memory ring + Prisma `ProcessedMessage`) at-most-once claim; fails open. |
| `lib/whatsapp/router.ts` | Maps an inbound message to an AuthPilot action by sender role (patient vs staff). |
| `lib/config.ts` | Fail-fast Zod env validation + presence-only `redactedSummary()`; WhatsApp keys are all-or-nothing. |
| `lib/voice/transcriptIntake.ts` | Light voice channel: a call transcript becomes a `phone_note` intake (no media bridge). |
| `scripts/setup-whatsapp.ts` | One-off Meta-side ice-breakers + commands. |
| `prisma/whatsapp.prisma` | `ProcessedMessage` (dedupe) + `WhatsAppMessage` (channel audit) models to merge. |
| `*.property.test.ts` | fast-check property tests (signature exactness, dedupe idempotency), matching AuthPilot's PBT discipline. |

## Behavior (safety boundary)

- **Patient → sends:** free text or a denial-letter photo → creates a Case
  (`intakeType: "whatsapp_patient_note"`) and runs the normal nine-stage pipeline; a
  "status" question gets a **generic** templated reply (no PHI), no pipeline re-run.
- **Patient → receives:** only generic, pre-approved templates (received / need-more-info /
  appeal-filed / resolved) — never case specifics.
- **Staff → sends:** `Approve <id>` / `Reject <id>` / `Status <id|name>` / `Show <id>`.
  Approve/Reject perform the same `Human_Action` as the dashboard, recorded in the
  tamper-evident audit chain with source `whatsapp`.
- **Staff → receives:** new-case, ready-for-approval, SLA-at-risk, and verification-flagged
  notifications.

Every WhatsApp-originated action writes the same Trace_Step / audit-chain entries as the
in-app flow, so the audit trail has no channel-shaped gap. Inbound text is also screened by
the untrusted-content Safety Guard before it reaches Qwen.

## Wiring checklist (when the app exists)

1. Merge `prisma/whatsapp.prisma` models; add `whatsappMessages` + `patientPhone` to `Case`;
   extend `intakeType` with `whatsapp_patient_note`; `npx prisma migrate dev`.
2. Implement `buildRouterPorts()` in `lib/whatsapp/wiring.ts` binding the router ports to the
   real services (create-case = the `/api/cases` logic in-process; humanAction = the
   `/api/cases/[id]/action` logic; status/lookup = Prisma queries).
3. Set the `WHATSAPP_*` env vars and register the webhook with Meta.
4. Run `scripts/setup-whatsapp.ts` once.

## Voice channel (out of scope for the demo)

A full real-time WhatsApp voice/calling bridge is deliberately **not** built here —
it's a multi-service media stack that doesn't fit AuthPilot's single-repo demo. We adopt only
the light pattern the brief already lists (feature #16): capture a call transcript and feed it
through the normal intake pipeline via `lib/voice/transcriptIntake.ts`. If a real-time voice
bridge is ever needed, it would be a separate optional service.
