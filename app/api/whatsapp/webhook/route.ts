/**
 * WhatsApp webhook — Next.js App Router handler.
 *
 * GET  = Meta verification handshake (hub.mode / hub.verify_token / hub.challenge).
 *        Compare the presented verify token against the configured verify token and
 *        echo back the presented challenge ONLY when they match (Req 31.1); reject
 *        without completing the handshake otherwise (Req 31.2). When the WhatsApp
 *        channel is not configured, reject as well — never throw.
 *
 * POST = inbound messages (tasks.md task 26.15). Order is critical:
 *   1. read the RAW body first (await req.text()) — the signature is over the exact
 *      bytes, so it must be verified BEFORE any JSON parsing (Req 31.1, 31.3, 31.4),
 *   2. HMAC-verify X-Hub-Signature-256 with the app secret (constant-time); reject an
 *      invalid/absent signature with 401 (Req 31.3, 31.4),
 *   3. ACK 200 fast, then process asynchronously — dedupe (at-most-once, Req 31.6) →
 *      parse → route via routeInbound(buildWhatsAppPorts()) (Req 31.5). A processing
 *      error is caught so it can never affect the 200 ack.
 *
 * runtime must be "nodejs" (Edge lacks the Node crypto used by signature verification,
 * and config loading reads process.env).
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getConfig, whatsappEnabled } from "@/lib/config";
import { verifySignature } from "@/lib/whatsapp/signature";
import { extractInboundMessages, parseInbound } from "@/lib/whatsapp/parseInbound";
import { resolveRole, routeInbound } from "@/lib/whatsapp/router";
import { buildWhatsAppPorts } from "@/lib/whatsapp/wiring";
import { createDedupe, type Dedupe } from "@/lib/whatsapp/dedupe";
import {
  recordInboundMessage,
  recordOutboundMessage,
} from "@/lib/whatsapp/channelAudit";

export const runtime = "nodejs";

/** Constant-time string comparison that never throws on length mismatch. */
function tokensMatch(presented: string, configured: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(configured, "utf8");
  // timingSafeEqual requires equal lengths; a length difference is already a mismatch.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// --- GET: verification handshake ---------------------------------------------
export async function GET(req: NextRequest) {
  // Resolve the configured verify token via the validated App_Configuration.
  // Never throw out of the handler: treat any config problem as "not configured".
  let verifyToken: string | undefined;
  try {
    const cfg = getConfig();
    if (whatsappEnabled(cfg)) {
      verifyToken = cfg.whatsapp!.verifyToken;
    }
  } catch {
    verifyToken = undefined;
  }

  // WhatsApp channel not configured → reject, do not complete the handshake.
  if (!verifyToken) {
    return new NextResponse(null, { status: 403 });
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  // Complete the handshake only when the subscribe intent and the tokens match.
  if (mode === "subscribe" && token !== null && tokensMatch(token, verifyToken)) {
    // Echo the raw challenge back as text/plain, exactly as Meta sent it.
    return new NextResponse(challenge ?? "", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Token mismatch / wrong mode → reject without completing the handshake.
  return new NextResponse(null, { status: 403 });
}

// --- POST: inbound messages --------------------------------------------------
// Process-local dedupe singleton (Req 31.6). Its in-memory ring buffer must be
// shared across requests to reject immediate Meta redeliveries without a DB round
// trip; the durable ProcessedMessage layer coordinates across restarts/workers.
// Constructed lazily so importing this route does no I/O and reads no config.
let dedupeSingleton: Dedupe | undefined;
function getDedupe(): Dedupe {
  if (dedupeSingleton === undefined) {
    dedupeSingleton = createDedupe();
  }
  return dedupeSingleton;
}

/**
 * Handle a verified inbound webhook payload: for each message, claim it at most
 * once (Req 31.6), route it through the shared in-process case logic, and mark it
 * processed. Runs AFTER the 200 ack (fire-and-forget), so a redelivery is a no-op
 * and no per-message failure can affect the acknowledgement (Req 31.5).
 */
async function handleInbound(payload: unknown): Promise<void> {
  const messages = extractInboundMessages(payload);
  if (messages.length === 0) return;

  const dedupe = getDedupe();
  // Build the wired ports once for this batch (shared in-process case logic).
  const ports = buildWhatsAppPorts();

  for (const { message, phoneNumberId } of messages) {
    const inbound = parseInbound(message, phoneNumberId);

    // At-most-once: a duplicate (Meta redelivery) is silently skipped (Req 31.6).
    const claimed = await dedupe.claim(inbound.messageId);
    if (!claimed) continue;

    try {
      // Channel audit (Req 36.1): record the inbound message as it actually
      // arrived, tagged with the resolved sender role (Req 34.7). Best-effort —
      // never throws, so it cannot affect routing or the ack.
      const role = resolveRole(inbound.phone, ports.staffNumbers);
      await recordInboundMessage(inbound, { role });

      const result = await routeInbound(inbound, ports);

      // Channel audit (Req 36.1): record the outbound reply that traversed the
      // channel — the generic PHI-free patient template or the staff command
      // reply — linked to the Case the turn touched where known (Req 36.3).
      if (result.reply) {
        await recordOutboundMessage({
          phone: inbound.phone,
          role: result.role,
          content: result.reply,
          caseId: result.caseId ?? null,
        });
      }

      await dedupe.markProcessed(inbound.messageId);
    } catch (err) {
      // Release the claim so a later redelivery can retry, then swallow — a
      // per-message failure must never surface (the ack has already been sent).
      await dedupe.release(inbound.messageId).catch(() => undefined);
      console.error(
        `[whatsapp/webhook] routing failed for message "${inbound.messageId}":`,
        err,
      );
    }
  }
}

/**
 * Inbound messages. The signature is verified over the EXACT raw bytes BEFORE any
 * parsing (Req 31.1, 31.3, 31.4); then we ACK 200 fast and process asynchronously
 * (Req 31.5). Never throws out of the handler.
 */
export async function POST(req: NextRequest) {
  // 1. RAW body first — the HMAC is over these exact bytes, so read before parsing.
  const raw = await req.text();
  const signature = req.headers.get("x-hub-signature-256");

  // Resolve the app secret via the validated App_Configuration. Never throw out of
  // the handler: treat any config problem as "channel not configured".
  let appSecret: string | undefined;
  try {
    const cfg = getConfig();
    if (whatsappEnabled(cfg)) {
      appSecret = cfg.whatsapp!.appSecret;
    }
  } catch {
    appSecret = undefined;
  }

  // 2. Signature gate (Req 31.1, 31.3, 31.4). When the channel is configured the
  //    signature MUST verify against the raw bytes; reject otherwise. When the
  //    channel is not configured, reject too — an unsigned inbound cannot be trusted.
  if (!appSecret || !verifySignature(raw, signature, appSecret)) {
    return new NextResponse(null, { status: 401 });
  }

  // 3. Parse the (now-verified) JSON payload.
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  // 4. FAST-ACK (Req 31.5): kick off processing fire-and-forget and return 200
  //    immediately. The catch guarantees a processing error never affects the ack.
  void handleInbound(payload).catch((err) => {
    console.error("[whatsapp/webhook] inbound handling failed:", err);
  });

  return new NextResponse(null, { status: 200 });
}
