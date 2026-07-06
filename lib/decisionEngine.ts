// =============================================================================
// lib/decisionEngine.ts
//
// Decision_Engine — the deterministic, rule-based core of AuthPilot's routing.
//
// This module is intentionally PURE: no I/O, no database access, and no calls
// to the LLM. The Qwen-powered pipeline proposes facts and a confidence score;
// the mapping from (confidence + contradiction state) to a Resolution_Path is
// plain code so it is predictable, testable, and auditable.
//
// Rules (evaluated strictly in order — see `decide` below):
//   1. iterationsExhausted OR contradictionCount > 0 → Escalate_To_Human
//      (contradictions always dominate confidence — Requirement 4.4)
//   2. confidence > 85                               → Auto_Draft
//   3. 60 <= confidence <= 85                        → Draft_And_Request_Evidence
//   4. confidence < 60                               → Escalate_To_Human
//
// The `status` in the returned DecisionResult is derived solely from `path`
// (Requirements 5.7, 5.8, 5.9).
// =============================================================================

import type { CaseStatus, ResolutionPath } from "@/lib/types";

/**
 * Inputs to the Decision_Engine.
 *
 * `contradictionCount` is the number of BLOCKING Findings supplied by the
 * caller (see `lib/findings.ts` — `blockingCount(findings)`). Routing to
 * Escalate_To_Human is therefore driven only by blocking findings, so
 * `warning`-severity findings never, on their own, force escalation
 * (Requirement 29.4).
 */
export interface DecisionInput {
  /** Overall Confidence_Score for the resolution decision, 0..100. */
  overallConfidence: number;
  /** Count of blocking Findings for the Case; >= 0 (Req 29.4). */
  contradictionCount: number;
  /** True when the agent loop hit its iteration cap without a decision. */
  iterationsExhausted: boolean;
}

/** The Decision_Engine outcome: a Resolution_Path and its derived Case_Status. */
export interface DecisionResult {
  path: ResolutionPath;
  /** Derived from `path` (Requirements 5.7, 5.8, 5.9). */
  status: CaseStatus;
}

/** Confidence threshold above which a Case is eligible for Auto_Draft. */
const AUTO_DRAFT_MIN_EXCLUSIVE = 85;
/** Lower (inclusive) bound of the Draft_And_Request_Evidence band. */
const DRAFT_AND_REQUEST_EVIDENCE_MIN_INCLUSIVE = 60;

/**
 * Map a Resolution_Path to the Case_Status the Decision_Engine assigns.
 *
 * Both drafting paths await human sign-off (`AwaitingApproval`, Req 5.7/5.8);
 * escalation needs a human before proceeding (`NeedsHumanInput`, Req 5.9).
 */
function statusForPath(path: ResolutionPath): CaseStatus {
  switch (path) {
    case "Auto_Draft":
    case "Draft_And_Request_Evidence":
      return "AwaitingApproval";
    case "Escalate_To_Human":
      return "NeedsHumanInput";
  }
}

/**
 * Deterministically map decision inputs to a routing outcome.
 *
 * Rules are evaluated in order; the first match wins. Contradictions (blocking
 * findings) and an exhausted loop dominate confidence and short-circuit to
 * Escalate_To_Human before any confidence band is considered (Req 4.4).
 */
export function decide(input: DecisionInput): DecisionResult {
  const { overallConfidence, contradictionCount, iterationsExhausted } = input;

  // Rule 1 — contradictions or an exhausted loop always escalate (Req 4.4, 6.4).
  if (iterationsExhausted || contradictionCount > 0) {
    return { path: "Escalate_To_Human", status: statusForPath("Escalate_To_Human") };
  }

  // Rule 2 — high confidence, no contradictions → Auto_Draft (Req 5.3).
  if (overallConfidence > AUTO_DRAFT_MIN_EXCLUSIVE) {
    return { path: "Auto_Draft", status: statusForPath("Auto_Draft") };
  }

  // Rule 3 — medium confidence band [60, 85] → Draft_And_Request_Evidence (Req 5.4).
  if (overallConfidence >= DRAFT_AND_REQUEST_EVIDENCE_MIN_INCLUSIVE) {
    return {
      path: "Draft_And_Request_Evidence",
      status: statusForPath("Draft_And_Request_Evidence"),
    };
  }

  // Rule 4 — low confidence (< 60) → Escalate_To_Human (Req 5.5).
  return { path: "Escalate_To_Human", status: statusForPath("Escalate_To_Human") };
}
