/**
 * Property test — Escalation is driven only by blocking findings.
 *
 * // Feature: authpilot, Property 64: Escalation is driven only by blocking findings
 * Validates: Requirements 29.2, 29.4, 29.5
 *
 * For any generated list of Findings (a mix of "blocking" and "warning"
 * severities):
 *   • `shouldEscalate(findings) === (blockingCount(findings) > 0)` — escalation
 *     is gated exactly on the presence of at least one blocking finding
 *     (Req 29.4).
 *   • `blockingCount(findings)` equals the number of findings whose
 *     severity === "blocking" — this is the value fed to the Decision_Engine as
 *     `contradictionCount`, so routing depends ONLY on blocking findings
 *     (Req 29.2, 29.4).
 *   • A list containing only "warning" findings never escalates — warnings are
 *     surfaced without forcing escalation (Req 29.5).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Finding, FindingKind, FindingSeverity } from "./types";
import { blockingCount, shouldEscalate } from "./findings";

const FINDING_KINDS: readonly FindingKind[] = [
  "contradiction",
  "gap",
  "policy",
  "verification",
];

const SEVERITIES: readonly FindingSeverity[] = ["warning", "blocking"];

/**
 * Generate a single Finding across both severities and all kinds. The message
 * fields are non-empty arbitrary strings so the shape matches a real Finding;
 * only `severity` matters for the escalation logic under test.
 */
const arbFinding: fc.Arbitrary<Finding> = fc.record({
  findingId: fc.string(),
  kind: fc.constantFrom<FindingKind>(...FINDING_KINDS),
  severity: fc.constantFrom<FindingSeverity>(...SEVERITIES),
  technicalMessage: fc.string(),
  friendlyMessage: fc.string(),
});

/** Warning-only Finding generator, for the "warnings never escalate" invariant. */
const arbWarningFinding: fc.Arbitrary<Finding> = fc.record({
  findingId: fc.string(),
  kind: fc.constantFrom<FindingKind>(...FINDING_KINDS),
  severity: fc.constant<FindingSeverity>("warning"),
  technicalMessage: fc.string(),
  friendlyMessage: fc.string(),
});

const arbFindings = fc.array(arbFinding, { maxLength: 20 });

describe("Findings-driven escalation (Property 64)", () => {
  it("shouldEscalate is true iff at least one blocking finding exists", () => {
    fc.assert(
      fc.property(arbFindings, (findings) => {
        // Req 29.4 — escalation is gated exactly on blockingCount > 0.
        expect(shouldEscalate(findings)).toBe(blockingCount(findings) > 0);
      }),
      { numRuns: 100 },
    );
  });

  it("blockingCount equals the number of blocking-severity findings (contradictionCount fed to the Decision_Engine)", () => {
    fc.assert(
      fc.property(arbFindings, (findings) => {
        const expected = findings.filter(
          (f) => f.severity === "blocking",
        ).length;
        // Req 29.2/29.4 — only blocking findings contribute to the count.
        expect(blockingCount(findings)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("a list containing only warnings never escalates and has a zero blocking count", () => {
    fc.assert(
      fc.property(
        fc.array(arbWarningFinding, { maxLength: 20 }),
        (warnings) => {
          // Req 29.5 — warnings are surfaced without forcing escalation.
          expect(shouldEscalate(warnings)).toBe(false);
          expect(blockingCount(warnings)).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
