/**
 * WhatsApp webhook — Next.js App Router handler.
 *
 * GET  = Meta verification handshake (hub.mode / hub.verify_token / hub.challenge).
 *        Compare the presented verify token against the configured verify token and
 *        echo back the presented challenge ONLY when they match (Req 31.1); reject
 *        without completing the handshake otherwise (Req 31.2). When the WhatsApp
 *        channel is not configured, reject as well — never throw.
 *
 * POST = inbound messages. Implemented later (tasks.md task 26.15): read the RAW body
 *        first, HMAC-verify X-Hub-Signature-256, ACK 200 fast, then dedupe → parse →
 *        route → reply.
 *
 * runtime must be "nodejs" (Edge lacks the Node crypto used by signature verification,
 * and config loading reads process.env).
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getConfig, whatsappEnabled } from "@/lib/config";

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

// TODO(task 26.15): implement the POST inbound pipeline in this file —
// read raw body → HMAC-verify X-Hub-Signature-256 over exact bytes (when an app
// secret is configured) → ACK 200 fast → dedupe → parse → route → reply.
