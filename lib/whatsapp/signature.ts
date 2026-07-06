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
 * Framework-agnostic — no imports beyond Node's built-in `crypto`. Pure and
 * deterministic: no network, no I/O. All functions return `false` (never throw)
 * on malformed input (Requirements 31.3, 31.4).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_PREFIX = "sha256=";
const DIGEST_BYTE_LENGTH = 32; // SHA-256 => 32 bytes => 64 hex chars
const HEX_RE = /^[0-9a-f]+$/i;

/** Compute the hex HMAC-SHA256 signature for a raw body + secret. */
export function computeSignatureHex(rawBody: string | Buffer, secret: string): string {
  const hmac = createHmac("sha256", secret);
  if (typeof rawBody === "string") {
    hmac.update(rawBody, "utf8");
  } else {
    hmac.update(rawBody);
  }
  return hmac.digest("hex");
}

/** Full header value we expect Meta to send, e.g. "sha256=abcd...". */
export function computeSignatureHeader(rawBody: string | Buffer, appSecret: string): string {
  return SIGNATURE_PREFIX + computeSignatureHex(rawBody, appSecret);
}

/**
 * Verify an `X-Hub-Signature-256` header against the raw body using the app secret.
 *
 * Returns `false` (never throws) for a missing/empty secret, a
 * missing/malformed/odd-length/non-hex/wrong-length header, or on any mismatch.
 * Uses a constant-time comparison over the recomputed digest bytes.
 */
export function verifySignatureWithSecret(
  rawBody: string | Buffer,
  presentedHeader: string | null | undefined,
  appSecret: string,
): boolean {
  if (!appSecret) return false;
  if (typeof presentedHeader !== "string" || !presentedHeader.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const providedHex = presentedHeader.slice(SIGNATURE_PREFIX.length).trim();
  if (providedHex.length !== DIGEST_BYTE_LENGTH * 2) return false;
  if (!HEX_RE.test(providedHex)) return false;

  const expectedHex = computeSignatureHex(rawBody, appSecret);
  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(providedHex, "hex");
  // Length guard before the constant-time comparison (timingSafeEqual throws on
  // length mismatch). Both are 32 bytes here, but keep the guard defensive.
  if (expected.length !== provided.length) return false;

  return timingSafeEqual(expected, provided);
}

/**
 * Convenience alias matching the requested public API. Verifies that
 * `signatureHeader` is the `sha256=<hex>` HMAC-SHA256 of `rawBody` keyed by
 * `appSecret`. Pure, deterministic, and never throws.
 */
export function verifySignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  appSecret: string,
): boolean {
  return verifySignatureWithSecret(rawBody, signatureHeader, appSecret);
}
