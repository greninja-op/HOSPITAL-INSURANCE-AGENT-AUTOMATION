// =============================================================================
// lib/whatsapp/channelAudit.ts
//
// WhatsApp CHANNEL AUDIT — records every inbound and outbound WhatsApp message as
// a `WhatsAppMessage` row so the audit trail has no channel-shaped gap
// (Requirement 36.1).
//
// For every message that traverses the WhatsApp_Channel we persist its direction,
// sender, role, content, message type, provider/wa message id, timestamp, and the
// linked Case where applicable. Recording is strictly BEST-EFFORT: these helpers
// NEVER throw. A persistence failure (or a unique-constraint clash on a Meta
// redelivery) is caught and logged so it can never break inbound handling or the
// fast webhook ack.
//
// PHI boundary (Requirement 36.3): the caller passes exactly what actually crossed
// the channel — the inbound sender text and the generic, PHI-free patient template
// / staff command reply. This module adds NO case-specific detail or PHI of its
// own; it stores only what it is given.
// =============================================================================

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../db";
import type { NormalizedInbound, InboundKind } from "./parseInbound";
import type { Role } from "./router";

/** The `WhatsAppMessage.messageType` values this module can emit. */
export type ChannelMessageType =
  | "text"
  | "interactive"
  | "button"
  | "image"
  | "audio"
  | "template"
  | "conversational"
  | "notification"
  | "unsupported";

/**
 * Map a parsed {@link InboundKind} to the `WhatsAppMessage.messageType` audit
 * value. Most kinds map straight through; the `request_welcome` trigger — which
 * carries no user content — is recorded as a "notification".
 */
export function inboundMessageType(kind: InboundKind): ChannelMessageType {
  switch (kind) {
    case "text":
      return "text";
    case "interactive":
      return "interactive";
    case "button":
      return "button";
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "request_welcome":
      return "notification";
    case "unsupported":
    default:
      return "unsupported";
  }
}

/** Options for {@link recordInboundMessage}. */
export interface RecordInboundOptions {
  /** Resolved sender role for this turn (Requirement 34.7). */
  role: Role;
  /** Linked Case id when already known at inbound time (usually not). */
  caseId?: string | null;
  /** Prisma client override (defaults to the shared `lib/db` client). */
  prisma?: PrismaClient;
}

/**
 * Record an INBOUND WhatsApp message (Requirement 36.1).
 *
 * Stores `direction: "inbound"`, the sender phone, role, the message text/body,
 * the message type derived from the parsed kind, and the Meta message id as both
 * `waMessageId` and the unique `providerMessageId` (aligned with the dedupe key).
 * Best-effort — never throws.
 */
export async function recordInboundMessage(
  inbound: NormalizedInbound,
  options: RecordInboundOptions,
): Promise<void> {
  const db = options.prisma ?? defaultPrisma;
  try {
    await db.whatsAppMessage.create({
      data: {
        direction: "inbound",
        sender: inbound.phone,
        role: options.role,
        content: inbound.body,
        messageType: inboundMessageType(inbound.kind),
        waMessageId: inbound.messageId || null,
        providerMessageId: inbound.messageId || null,
        caseId: options.caseId ?? null,
      },
    });
  } catch (err) {
    // Best-effort audit: a redelivery clash on the unique providerMessageId, or
    // any transient DB error, must never break inbound handling.
    console.error(
      `[whatsapp/channelAudit] failed to record inbound message "${inbound.messageId}":`,
      err,
    );
  }
}

/** Options for {@link recordOutboundMessage}. */
export interface RecordOutboundOptions {
  /** The channel participant this reply was sent to (E.164 / wa_id). */
  phone: string;
  /** Resolved role for this turn (Requirement 34.7). */
  role: Role;
  /** The exact text/template that was sent back over the channel (Req 36.3). */
  content: string;
  /** Linked Case this reply concerns, when any. */
  caseId?: string | null;
  /**
   * Message type for the outbound row. Defaults to "template" for patient replies
   * (all patient-facing replies are generic, PHI-free templates — Req 33.3) and
   * "text" for staff replies.
   */
  messageType?: ChannelMessageType;
  /** Prisma client override (defaults to the shared `lib/db` client). */
  prisma?: PrismaClient;
}

/**
 * Record an OUTBOUND WhatsApp message (Requirement 36.1).
 *
 * Stores `direction: "outbound"`, the recipient phone as the channel participant,
 * role, the reply content, the message type, and the linked Case where applicable.
 * The content is only ever the generic patient template or the staff command
 * reply the router produced, so no PHI is introduced here (Requirement 36.3).
 * Best-effort — never throws.
 */
export async function recordOutboundMessage(
  options: RecordOutboundOptions,
): Promise<void> {
  const db = options.prisma ?? defaultPrisma;
  const messageType =
    options.messageType ?? (options.role === "patient" ? "template" : "text");
  try {
    await db.whatsAppMessage.create({
      data: {
        direction: "outbound",
        sender: options.phone,
        role: options.role,
        content: options.content,
        messageType,
        caseId: options.caseId ?? null,
      },
    });
  } catch (err) {
    console.error(
      `[whatsapp/channelAudit] failed to record outbound message to "${options.phone}":`,
      err,
    );
  }
}
