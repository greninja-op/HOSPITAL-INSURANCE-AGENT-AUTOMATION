/**
 * Property test — WhatsApp signature verification.
 *
 * // Feature: authpilot-whatsapp, Property W1: signature verification is exact and safe
 * Validates: a correctly computed sha256= header verifies true; any tampering with the
 * body, secret, or signature bytes verifies false; malformed headers verify false.
 *
 * Uses fast-check, aligning with AuthPilot's property-based testing discipline.
 * Run with the app's test runner (Vitest) once the package is merged in.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  computeSignatureHeader,
  verifySignatureWithSecret,
  SIGNATURE_PREFIX,
} from "./signature";

describe("WhatsApp signature", () => {
  it("verifies a correctly signed body and rejects tampering", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string({ minLength: 1 }),
        (body, secret) => {
          const header = computeSignatureHeader(body, secret);
          // Correct signature verifies.
          expect(verifySignatureWithSecret(body, header, secret)).toBe(true);
          // Wrong secret fails.
          expect(verifySignatureWithSecret(body, header, `${secret}x`)).toBe(false);
          // Tampered body fails.
          expect(verifySignatureWithSecret(`${body}x`, header, secret)).toBe(false);
          // Missing prefix fails.
          expect(
            verifySignatureWithSecret(body, header.slice(SIGNATURE_PREFIX.length), secret),
          ).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects malformed headers", () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ minLength: 1 }), (body, secret) => {
        for (const bad of [null, undefined, "", "sha256=", "sha256=zz", "abcd"]) {
          expect(verifySignatureWithSecret(body, bad as string | null, secret)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
