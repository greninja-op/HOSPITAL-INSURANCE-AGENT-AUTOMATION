// =============================================================================
// lib/findings.ts
//
// Findings — the structured representation of every contradiction, gap, policy
// issue, and verification issue AuthPilot produces (Requirement 29).
//
// Each issue is expressed uniformly as a `Finding` carrying a STABLE
// identifier, a `FindingSeverity` ("warning" | "blocking"), optional
// expected/actual values, a precise technical message (for the audit view),
// and a patient/operator-friendly message (Req 29.1). Only genuinely blocking
// problems force escalation; warnings stay visible without escalating
// (Reqs 29.4, 29.5).
//
// This module is intentionally PURE: no I/O, no database access, and no LLM
// calls. It only builds and inspects plain `Finding` objects. The `Finding`,
// `FindingKind`, and `FindingSeverity` types live in `lib/types.ts` and are
// imported (never redefined) here.
//
// Severity rules encoded here:
//   • Contradictions are ALWAYS "blocking" (Req 29.2) — the contradiction
//     builder ignores any caller-supplied severity.
//   • Verification_QA flagged issues map to "blocking" or "warning" by their
//     effect on appeal validity (Req 29.3): grounding/support failures that
//     invalidate the appeal (including `unresolved_citation`) are blocking;
//     softer advisories are warnings.
//   • Gaps and policy issues carry a caller-chosen severity (default
//     "blocking"), so the caller decides whether a given gap/policy issue is
//     appeal-invalidating or merely advisory.
//
// The count of BLOCKING findings (`blockingCount`) is the value fed to the
// Decision_Engine as `contradictionCount`, so routing depends ONLY on blocking
// findings (Req 29.4).
// =============================================================================

import type {
  Finding,
  FindingSeverity,
  FlaggedIssue,
  FlaggedIssueType,
} from "@/lib/types";

// ─── Stable identifier helpers ───────────────────────────────────────────────

/**
 * Normalise an arbitrary label into a stable, id-safe slug fragment.
 *
 * Lower-cases, replaces any run of non-alphanumeric characters with a single
 * hyphen, and trims leading/trailing hyphens. Deterministic for a given input,
 * so ids remain stable across runs (Req 29.1).
 */
function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build a stable Finding identifier of the form `<kind>:<slug>:<caseId>`,
 * e.g. `"contradiction:dx-mismatch:<caseId>"` (matches the design shape).
 */
function makeFindingId(
  kind: Finding["kind"],
  slug: string,
  caseId: string,
): string {
  return `${kind}:${slugify(slug)}:${caseId}`;
}

// ─── Builder inputs ──────────────────────────────────────────────────────────

/** Common fields every Finding builder accepts. */
export interface FindingInput {
  /** The Case the Finding belongs to; used to make the id stable + scoped. */
  caseId: string;
  /**
   * Short, stable slug identifying the specific issue (e.g. "dx-mismatch").
   * Combined with kind + caseId into a stable `findingId`.
   */
  slug: string;
  /** Expected value, where applicable (Req 29.1). */
  expected?: string;
  /** Actual value, where applicable (Req 29.1). */
  actual?: string;
  /** Precise phrasing for the audit/technical view (Req 29.1). */
  technicalMessage: string;
  /** Patient/operator-friendly phrasing (Req 29.1). */
  friendlyMessage: string;
}

/** Builder input that also carries a caller-chosen severity. */
export interface SeveredFindingInput extends FindingInput {
  /** Severity for this issue; defaults to "blocking" when omitted. */
  severity?: FindingSeverity;
}

/**
 * Attach the optional expected/actual fields only when provided, so the
 * resulting object matches the `Finding` shape without carrying `undefined`
 * keys.
 */
function withOptional(
  base: Omit<Finding, "expected" | "actual">,
  expected?: string,
  actual?: string,
): Finding {
  const finding: Finding = { ...base };
  if (expected !== undefined) finding.expected = expected;
  if (actual !== undefined) finding.actual = actual;
  return finding;
}

// ─── Finding builders ─────────────────────────────────────────────────────────

/**
 * Build a contradiction Finding. Contradictions are ALWAYS "blocking"
 * (Req 29.2) — this builder does not accept a severity and cannot produce a
 * warning-severity contradiction.
 */
export function contradictionFinding(input: FindingInput): Finding {
  return withOptional(
    {
      findingId: makeFindingId("contradiction", input.slug, input.caseId),
      kind: "contradiction",
      severity: "blocking",
      technicalMessage: input.technicalMessage,
      friendlyMessage: input.friendlyMessage,
    },
    input.expected,
    input.actual,
  );
}

/**
 * Build a gap Finding (missing/insufficient evidence). Severity is
 * caller-chosen and defaults to "blocking".
 */
export function gapFinding(input: SeveredFindingInput): Finding {
  return withOptional(
    {
      findingId: makeFindingId("gap", input.slug, input.caseId),
      kind: "gap",
      severity: input.severity ?? "blocking",
      technicalMessage: input.technicalMessage,
      friendlyMessage: input.friendlyMessage,
    },
    input.expected,
    input.actual,
  );
}

/**
 * Build a policy Finding (payer-policy conflict / requirement). Severity is
 * caller-chosen and defaults to "blocking".
 */
export function policyFinding(input: SeveredFindingInput): Finding {
  return withOptional(
    {
      findingId: makeFindingId("policy", input.slug, input.caseId),
      kind: "policy",
      severity: input.severity ?? "blocking",
      technicalMessage: input.technicalMessage,
      friendlyMessage: input.friendlyMessage,
    },
    input.expected,
    input.actual,
  );
}

// ─── Verification_QA issue mapping (Req 29.3) ─────────────────────────────────

/**
 * Default severity for each Verification_QA flagged-issue type, by its effect
 * on appeal validity (Req 29.3, Req 22.9):
 *   • Grounding / support failures that make the appeal unsupportable are
 *     BLOCKING (`unsupported_citation`, `reference_mismatch`,
 *     `unsupported_claim`, `unresolved_citation`).
 *   • A verification error (checks could not complete) is a WARNING advisory:
 *     it does not itself invalidate the appeal's content, but is surfaced to
 *     the reviewer.
 */
export const DEFAULT_VERIFICATION_SEVERITY: Readonly<
  Record<FlaggedIssueType, FindingSeverity>
> = {
  unsupported_citation: "blocking",
  reference_mismatch: "blocking",
  unsupported_claim: "blocking",
  unresolved_citation: "blocking",
  verification_error: "warning",
} as const;

/** Default patient/operator-friendly phrasing per flagged-issue type (Req 29.1). */
const VERIFICATION_FRIENDLY: Readonly<Record<FlaggedIssueType, string>> = {
  unsupported_citation:
    "A citation in the appeal could not be backed by the payer policy or chart notes, so it was flagged for review.",
  reference_mismatch:
    "A patient, policy, or code reference in the appeal did not match the case details, so it was flagged for review.",
  unsupported_claim:
    "A claim in the appeal was not supported by the retrieved evidence, so it was flagged for review.",
  unresolved_citation:
    "A reference in the appeal did not resolve to a record on file for this case, so the appeal was held for review.",
  verification_error:
    "The appeal's automated checks could not fully complete, so a reviewer should confirm it before it is sent.",
};

/**
 * Resolve the severity for a flagged issue by its effect on appeal validity
 * (Req 29.3). Honours an explicit severity carried on the issue (as set by
 * Verification_QA — e.g. grounding failures forced to "blocking" per Req 22.9),
 * falling back to the type-based default.
 */
export function severityForFlaggedIssue(issue: FlaggedIssue): FindingSeverity {
  return issue.severity ?? DEFAULT_VERIFICATION_SEVERITY[issue.type];
}

/**
 * Build a verification Finding from a Verification_QA `FlaggedIssue`
 * (Req 29.1, 29.3).
 *
 * The stable id is scoped by the issue type and the offending reference. The
 * severity follows the issue's effect on appeal validity (see
 * `severityForFlaggedIssue`). A friendly message may be supplied; otherwise a
 * sensible default for the issue type is used.
 */
export function verificationFinding(
  caseId: string,
  issue: FlaggedIssue,
  friendlyMessage?: string,
): Finding {
  const slug = `${issue.type}:${issue.reference}`;
  return {
    findingId: makeFindingId("verification", slug, caseId),
    kind: "verification",
    severity: severityForFlaggedIssue(issue),
    actual: issue.reference,
    technicalMessage: issue.detail,
    friendlyMessage: friendlyMessage ?? VERIFICATION_FRIENDLY[issue.type],
  };
}

/**
 * Convenience: map every flagged issue on a `VerificationResult`-style list
 * into verification Findings for a Case (Req 29.1, 29.3).
 */
export function verificationFindings(
  caseId: string,
  issues: readonly FlaggedIssue[],
): Finding[] {
  return issues.map((issue) => verificationFinding(caseId, issue));
}

// ─── Severity inspection (Reqs 29.4, 29.5) ────────────────────────────────────

/** True iff the Finding forces escalation (its severity is "blocking"). */
export function isBlocking(finding: Finding): boolean {
  return finding.severity === "blocking";
}

/**
 * Count of BLOCKING findings. This is the value fed to the Decision_Engine as
 * `contradictionCount`, so routing depends ONLY on blocking findings
 * (Req 29.4). `warning` findings never contribute to this count.
 */
export function blockingCount(findings: readonly Finding[]): number {
  let count = 0;
  for (const finding of findings) {
    if (finding.severity === "blocking") count += 1;
  }
  return count;
}

/**
 * Escalation gate: true iff at least one blocking finding exists (Req 29.4).
 * A set containing only `warning` findings never forces escalation (Req 29.5).
 */
export function shouldEscalate(findings: readonly Finding[]): boolean {
  return findings.some((finding) => finding.severity === "blocking");
}

/**
 * The `warning`-severity findings, surfaced to the reviewer WITHOUT forcing
 * escalation (Req 29.5).
 */
export function warningFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => finding.severity === "warning");
}
