/**
 * WhatsApp webhook — Next.js App Router handler.
 *
 * GET  = Meta verification handshake (hub.mode/hub.verify_token/hub.challenge).
 * POST = inbound messages. Order is critical:
 *   1. read the RAW body first (await req.text()) — signature is over exact bytes,
 *   2. verify X-Hub-Signature-256 with the app secret (constant-time),
 *   3. ACK 200 fast, then do the work (dedupe → parse → route → reply).
 *
 * runtime must be "nodejs" (Edge lacks the Node crypto used by the verifier).
 *
 * NOTE: this is the reference route for the whatsapp-integration package. Once the
 * Next.js app is scaffolded (tasks.md task 1), move it to `app/api/whatsapp/webhook/route.ts`
 * and wire the ports in `buildRouterPorts()` to the real Prisma-backed services.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifySignatureWithSecret } from "@/lib/whatsapp/signature";
import { extractInboundMessages, parseInbound } from "@/lib/whatsapp/parseInbound";
import { routeInbound } from "@/lib/whatsapp/router";
// import { loadConfig, whatsappEnabled } from "@/lib/config";
// import { buildRouterPorts, buildSender, buildDedupe } from "@/lib/whatsapp/wiring";

export const runtime = "nodejs";

// --- GET: verification handshake ---------------------------------------------
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!verifyToken) return new NextResponse(null, { status: 403 });
  if (mode !== "subscribe" || token !== verifyToken) {
    return new NextResponse(null, { status: 403 });
  }
  if (!challenge || challenge.length < 1 || challenge.length > 4096) {
    return new NextResponse(null, { status: 400 });
  }
  return new NextResponse(challenge, { status: 200 });
}

// --- POST: inbound messages --------------------------------------------------
export async function POST(req: NextRequest) {
  // 1. RAW body first — do not JSON.parse before verifying.
  const raw = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  // 2. Signature gate. If a secret is configured it MUST match; if unconfigured we
  //    proceed (dev/simulator) — production always sets WHATSAPP_APP_SECRET.
  if (appSecret) {
    if (!verifySignatureWithSecret(raw, signature, appSecret)) {
      return new NextResponse(null, { status: 403 });
    }
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  // 3. ACK fast; run work after. On Vercel serverless the reliable pattern is to await
  //    the bounded routing here (it only creates a Case + kicks the async agent, which
  //    the Case Detail page then polls — mirroring AuthPilot's existing case flow).
  await handleInbound(payload).catch((err) => {
    console.error("[whatsapp] inbound handling failed", err);
  });

  return new NextResponse(null, { status: 200 });
}

async function handleInbound(payload: unknown): Promise<void> {
  // const cfg = loadConfig();
  // if (!whatsappEnabled(cfg)) return;
  // const ports = buildRouterPorts(cfg);
  // const sender = buildSender(cfg);
  // const dedupe = buildDedupe();

  for (const { message, phoneNumberId } of extractInboundMessages(payload)) {
    const inbound = parseInbound(message, phoneNumberId);

    // Dedupe (Meta redelivers): const claimed = await dedupe.claim(inbound.messageId);
    // if (!claimed) continue;

    // const result = await routeInbound(inbound, ports);
    // if (result.reply) await sender.sendText(inbound.phone, result.reply);
    // await dedupe.markProcessed(inbound.messageId);

    void routeInbound; // referenced; wiring is filled in when the app is scaffolded
    void inbound;
  }
}
