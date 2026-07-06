/**
 * WhatsApp webhook signature verification.
 *
 * Meta signs each webhook POST with an `X-Hub-Signature-256` header:
 *   sha256=<hex HMAC-SHA256 of the EXACT raw request body, keyed by the app secret>
 *
 * Verification MUST run against the raw bytes, before any JSON parsing, and use a
 * constant-time comparison. In a Next.js App Router route this means calling
 * `await req.text()` first and setting `export const runtime = "nodejs"` (the Edge
 * runtime does not expose the Node `crypto` primitives used here).
 *
 * Adapted for AuthPilot (Next.js 14 + TypeScript). Framework-agnostic — no imports
 * beyond Node's built-in `crypto`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_PREFIX = "sha256=";
const DIGEST_BYTE_LENGTH = 32; // SHA-256 => 32 bytes => 64 hex chars
const HEX_RE = /^[0-9a-f]+$/i;

/** Compute the hex signature for a raw body + secret (used by the dev simulator/tests). */
export function computeSignatureHex(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/** Full header value we would expect Meta to send, e.g. "sha256=abcd...". */
export function computeSignatureHeader(rawBody: string, secret: string): string {
  return SIGNATURE_PREFIX + computeSignatureHex(rawBody, secret);
}

/**
 * Verify an `X-Hub-Signature-256` header against the raw body using the app secret.
 * Returns false (never throws) for a missing/malformed/odd-length/non-hex/wrong-length
 * header, or on any mismatch. Uses a constant-time comparison.
 */
export function verifySignatureWithSecret(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
): boolean {
  if (!secret) return false;
  if (typeof header !== "string" || !header.startsWith(SIGNATURE_PREFIX)) return false;

  const providedHex = header.slice(SIGNATURE_PREFIX.length).trim();
  if (providedHex.length !== DIGEST_BYTE_LENGTH * 2) return false;
  if (!HEX_RE.test(providedHex)) return false;

  const expectedHex = computeSignatureHex(rawBody, secret);
  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(providedHex, "hex");
  if (expected.length !== provided.length) return false;

  return timingSafeEqual(expected, provided);
}
