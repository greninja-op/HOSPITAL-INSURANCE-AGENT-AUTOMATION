/**
 * WhatsApp inbound-message parsing.
 *
 * Meta delivers webhook payloads shaped as:
 *   entry[].changes[].value.messages[]   (real messages)
 *   entry[].changes[].value.statuses[]   (delivery/read receipts — ignored here)
 *
 * `parseInbound` is a TOTAL function: it never drops a message. Anything it cannot
 * interpret becomes `kind: "unsupported"` with an empty body, so the dedupe + audit
 * trail still records that something arrived.
 */

export type InboundKind =
  | "text"
  | "interactive" // button_reply / list_reply taps
  | "button" // template quick-reply button
  | "image"
  | "audio"
  | "request_welcome"
  | "unsupported";

export interface NormalizedInbound {
  phone: string; // sender WhatsApp number (wa_id)
  body: string; // best-effort text content ("" when none)
  hasImage: boolean;
  hasAudio: boolean;
  messageId: string; // Meta message id — the dedupe key
  phoneNumberId: string; // our receiving number id (multi-number aware)
  interactiveId?: string; // deterministic id of a tapped button/list row
  kind: InboundKind;
  isWelcome: boolean;
  audioRef?: string; // Meta media id for later download + transcription
  imageRef?: string; // Meta media id for later download + OCR/vision
}

// Minimal shapes for the fields we read (Meta payloads carry much more).
interface RawMessage {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  image?: { id?: string; caption?: string };
  audio?: { id?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  request_welcome?: unknown;
}

/** Flatten a webhook payload into individual messages, dropping status-only changes. */
export function extractInboundMessages(
  payload: unknown,
): Array<{ message: RawMessage; phoneNumberId: string }> {
  const out: Array<{ message: RawMessage; phoneNumberId: string }> = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      if (!value) continue;
      const phoneNumberId =
        (value.metadata as { phone_number_id?: string })?.phone_number_id ?? "";
      const messages = value.messages;
      if (!Array.isArray(messages)) continue; // status-only change → skip
      for (const message of messages) {
        out.push({ message: message as RawMessage, phoneNumberId });
      }
    }
  }
  return out;
}

/** Normalize one raw Meta message into our internal shape. Never throws. */
export function parseInbound(m: RawMessage, phoneNumberId: string): NormalizedInbound {
  const base: NormalizedInbound = {
    phone: m.from ?? "",
    body: "",
    hasImage: false,
    hasAudio: false,
    messageId: m.id ?? "",
    phoneNumberId,
    kind: "unsupported",
    isWelcome: false,
  };

  switch (m.type) {
    case "text":
      return { ...base, kind: "text", body: m.text?.body ?? "" };

    case "interactive": {
      const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
      return {
        ...base,
        kind: "interactive",
        body: reply?.title ?? reply?.id ?? "",
        interactiveId: reply?.id,
      };
    }

    case "button":
      return { ...base, kind: "button", body: m.button?.text ?? m.button?.payload ?? "" };

    case "image":
      return {
        ...base,
        kind: "image",
        hasImage: true,
        body: m.image?.caption ?? "",
        imageRef: m.image?.id,
      };

    case "audio":
      return { ...base, kind: "audio", hasAudio: true, audioRef: m.audio?.id };

    case "request_welcome":
      return { ...base, kind: "request_welcome", isWelcome: true };

    default:
      return base; // unsupported — recorded, never dropped
  }
}
