// =============================================================================
// lib/types.ts
//
// Shared TypeScript types and enumerations for AuthPilot. These are the common
// vocabulary the whole app speaks: the API routes, the nine-stage Agent_Runner,
// the pure logic modules (Decision_Engine, SLA_Clock, Findings, Case_Status
// state machine, Audit_Chain), and the WhatsApp channel all import from here.
//
// Defining the Shared_Case_Action types here (CaseActionType / CaseActionMeta /
// CaseActionResult) lets BOTH the dashboard action route and the WhatsApp router
// reference the same contract WITHOUT importing each other, keeping the single
// shared `performCaseAction` implementation as the only place that logic lives.
// =============================================================================

// ─── Core domain enumerations ────────────────────────────────────────────────

/** Lifecycle status of a Case. Transitions are guarded by `lib/caseStatus.ts`. */
export type CaseStatus =
  | "New"
  | "Investigating"
  | "NeedsHumanInput"
  | "AwaitingApproval"
  | "AppealSent"
  | "Resolved"
  | "DeniedFinal";

/** The routing outcome the Decision_Engine maps a Case to. */
export type ResolutionPath =
  | "Auto_Draft"
  | "Draft_And_Request_Evidence"
  | "Escalate_To_Human";

/** The nine ordered stages of the Agent_Runner pipeline. */
export type PipelineStage =
  | "Intake_And_Extraction"
  | "Medical_Review"
  | "Policy_Review"
  | "Strategy"
  | "Decision_Intelligence"
  | "Appeal_Generation"
  | "Verification_QA"
  | "Human_Approval"
  | "Submission_And_Tracking";

/** How a Case entered the system. */
export type IntakeType =
  | "denial_letter"
  | "new_pa_request"
  | "phone_note"
  | "whatsapp_patient_note";

/** Provenance of an Extracted_Field value. */
export type SourceType =
  | "raw_intake"
  | "chart_note"
  | "payer_policy"
  | "code_lookup"
  | "human_provided";

/**
 * The seven — and only seven — allowed Trace_Step types (Requirements 23.3, 23.6).
 * The `createTraceStep` guard rejects any value outside this set.
 */
export type StepType =
  | "tool_call"
  | "decision"
  | "human_action"
  | "medical_review"
  | "policy_review"
  | "strategy"
  | "verification";

/** The seven allowed step types as a runtime tuple, for validation/generators. */
export const STEP_TYPES: readonly StepType[] = [
  "tool_call",
  "decision",
  "human_action",
  "medical_review",
  "policy_review",
  "strategy",
  "verification",
] as const;

// ─── Recommendation & appeal content ─────────────────────────────────────────

/** Fields used to render the appeal PDF (cites denial reason, policy, evidence). */
export interface AppealContent {
  patientName: string;
  denialReason: string;
  /** Referenced Payer_Policy clause the appeal cites. */
  policyClause: string;
  /** Supporting Chart_Note evidence lines cited by the appeal. */
  supportingEvidence: string[];
  /** The assembled appeal argument body. */
  argument: string;
}

/** The recommendation JSON stored on a Case. */
export interface Recommendation {
  headline: string;
  /** Cites the policy clause + chart evidence backing the recommendation. */
  reason: string;
  risk: "Low" | "Medium" | "High";
  resolutionPath: ResolutionPath;
  /** Present for Draft_And_Request_Evidence. */
  requestedEvidence?: string[];
  /** Fields used to render the PDF. */
  appealContent?: AppealContent;
}

// ─── Strategy options ────────────────────────────────────────────────────────

export interface StrategyOption {
  /** Candidate appeal approach. */
  approach: string;
  /** Integer win-probability, 0..100 (percent). */
  winProbability: number;
  rationale: string;
}

export interface StrategyOptions {
  /** 1..5 entries, sorted by descending winProbability. */
  options: StrategyOption[];
  /** false ⇒ fell back to payer-track-record-only (history unavailable). */
  usedPriorAuthHistory: boolean;
  payerTrackRecordSummary: string;
}

// ─── Verification_QA results ─────────────────────────────────────────────────

export type FlaggedIssueType =
  | "unsupported_citation" // citation not backed by Payer_Policy/Chart_Note (Req 22.1)
  | "reference_mismatch" // patient/policy/code ref ≠ Extracted_Field value (Req 22.2)
  | "unsupported_claim" // claim not backed by retrieved evidence (Req 22.3)
  | "unresolved_citation" // ref does not resolve to a stored in-scope record (Req 22.8/22.9)
  | "verification_error"; // checks could not complete (Req 22.7)

export interface FlaggedIssue {
  type: FlaggedIssueType;
  /** The offending citation / reference / claim text. */
  reference: string;
  detail: string;
  /** Grounding failures and contradictions are blocking (Req 22.9, 29.2, 29.3). */
  severity: FindingSeverity;
}

export interface VerificationResult {
  /** pass iff flaggedIssues.length === 0, else fail (Req 22.4). */
  status: "pass" | "fail";
  flaggedIssues: FlaggedIssue[];
}

// ─── Structured findings (Requirement 29) ────────────────────────────────────

export type FindingSeverity = "warning" | "blocking";

export type FindingKind = "contradiction" | "gap" | "policy" | "verification";

export interface Finding {
  /** Stable id, e.g. "contradiction:dx-mismatch:<caseId>". */
  findingId: string;
  kind: FindingKind;
  /** Contradictions are always "blocking" (Req 29.2). */
  severity: FindingSeverity;
  expected?: string;
  actual?: string;
  /** Precise phrasing for the audit/technical view. */
  technicalMessage: string;
  /** Patient/operator-friendly phrasing (Req 29.1). */
  friendlyMessage: string;
}

// ─── Qwen_Client outcomes (Requirements 6.5–6.9) ─────────────────────────────

export interface QwenToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface QwenResponse {
  /** Empty when the model returns a final answer. */
  toolCalls: QwenToolCall[];
  /** Final text when there are no tool calls. */
  content: string | null;
}

export type QwenFailureKind =
  | "network" // transport/connection error          → transient
  | "timeout" // per-attempt bounded timeout elapsed   → transient (Req 6.6)
  | "http_429" // rate limited                          → transient
  | "http_5xx" // 500 / 502 / 503 / 504                 → transient
  | "http_4xx" // 4xx other than 429                    → permanent
  | "malformed" // unparseable / schema-invalid response → permanent
  | "empty"; // no content and no tool calls          → permanent

export interface QwenFailure {
  ok: false;
  kind: QwenFailureKind;
  /** true ⇒ eligible for backoff+retry (Req 6.7). */
  transient: boolean;
  /** Total attempts made (1..3). */
  attempts: number;
  detail: string;
}

/** Never-throwing result reported to the Agent_Runner. */
export type QwenOutcome = ({ ok: true } & QwenResponse) | QwenFailure;

// ─── Audit_Chain (Requirement 25) ────────────────────────────────────────────

export interface AuditVerifyResult {
  intact: boolean;
  /** Stored hash of the most recent event (Req 25.4). */
  headHash: string;
  /** Set when intact === false (Req 25.5, 25.6). */
  firstBrokenEventId?: string;
  reason?: "hash_mismatch" | "prevhash_mismatch";
}

// ─── Case_Status state machine (Requirement 28) ──────────────────────────────

/** A requested status change, evaluated by `assertTransition`. */
export interface StatusTransition {
  from: CaseStatus;
  to: CaseStatus;
}

export interface TransitionResult {
  ok: boolean;
  /** The resulting status (unchanged on rejection/no-op). */
  status: CaseStatus;
  /** true for a same-state idempotent transition (Req 28.3). */
  noop?: boolean;
  /** Identifies the illegal transition on rejection (Req 28.2). */
  message?: string;
}

// ─── Shared Case Action (Requirement 40) ─────────────────────────────────────
// Defined here so the dashboard `/api/cases/[id]/action` route and the WhatsApp
// router (`lib/whatsapp/router.ts`) can both reference the `performCaseAction`
// contract without importing each other.

export type CaseActionType =
  | "approve"
  | "reject"
  | "edit"
  | "request_more_evidence";

export interface CaseActionMeta {
  /** Invoking channel. */
  source: "dashboard" | "whatsapp";
  /** Operator id / staff phone that acted. */
  actor: string;
  /** Rejection reason / edit note. */
  reason?: string;
  /** Revised recommendation content (edit, dashboard only). */
  editedRecommendation?: unknown;
  /** Supplied evidence text (request_more_evidence). */
  additionalEvidence?: string;
  /** Idempotency_Key for the mutation (Req 26, 40.10). */
  idempotencyKey: string;
}

export interface CaseActionResult {
  /** false on any refusal or failure — never throws (Req 40.4). */
  success: boolean;
  /** Resulting status (unchanged on refusal/failure/no-op). */
  newStatus: CaseStatus;
  /** Human-readable outcome / refusal / failure reason. */
  message: string;
  /** Appeal_Packet location reference (approve only, Req 40.5). */
  pdfUrl?: string;
}
