# Implementation Plan: AuthPilot

## Overview

This plan builds AuthPilot as a single Next.js 14 (App Router) + TypeScript repository backed by SQLite via Prisma. Work proceeds bottom-up: project scaffolding and data layer first, then the pure/near-pure logic modules (Decision_Engine, SLA_Clock) that carry most of the correctness properties, then the Qwen client and agent tools, then the ordered nine-stage `Agent_Runner` pipeline (Intake_And_Extraction → parallel Medical_Review/Policy_Review → Strategy → Decision_Intelligence → Appeal_Generation → Verification_QA → Human_Approval → Submission_And_Tracking), then the API routes, and finally the frontend pages and seed/demo data. Each step builds on the previous one and ends by wiring the new code into the running app. Property-based tests (fast-check, Vitest, ≥100 iterations) sit next to the logic they validate; example, integration, and smoke tests cover UI, library-bound, one-shot setup, and architectural-wiring behavior.

## Tasks

- [x] 1. Scaffold project and shared foundations
  - Initialize a Next.js 14 (App Router) + TypeScript project with Tailwind, shadcn/ui, Recharts, and Framer Motion
  - Add Vitest and fast-check; configure a test script and a shared fast-check config (`{ numRuns: 100 }`)
  - Create the `lib/` directory and define shared TypeScript types/enums: `CaseStatus`, `ResolutionPath`, `PipelineStage`, `intakeType`, `sourceType`, `stepType` (the seven allowed values), `Recommendation`, `AppealContent`, `StrategyOption`/`StrategyOptions`, `FlaggedIssue`/`VerificationResult`, plus the hardening types `Finding`/`FindingKind`/`FindingSeverity`, `QwenOutcome`/`QwenFailure`/`QwenFailureKind`, `AuditVerifyResult`, the status-transition types used by the case-status state machine, and the Shared_Case_Action types `CaseActionType`/`CaseActionMeta`/`CaseActionResult` (mirroring the `performCaseAction` interface in the design) so both the action route and the WhatsApp router can reference them without importing each other
  - _Requirements: 5.7, 5.8, 5.9, 23.3, 40.1_

- [ ] 2. Define the data layer with Prisma
  - [x] 2.1 Author the Prisma schema and generate the client
    - Define `Patient`, `ChartNote`, `Payer`, `PayerPolicy`, `Case`, `ExtractedField`, `TraceStep` models per the design, including `Case.isUrgent`, `resolutionPath`, `denialReason`, `requestedEvidence`, `plainEnglishExplanation`, `recommendation`, `appealPdfUrl`, `resolvedAt`, and the multi-stage pipeline fields `Case.strategyOptions` (Json?) and `Case.verificationResult` (Json?)
    - Add the Case payer reference to the schema: `Case.payerId` (String?, optional relation to `Payer`) and the `Case.payerName` (String?) convenience field used as the denials-by-payer analytics grouping key, plus the corresponding `Payer.cases Case[]` reverse relation
    - Extend `TraceStep.stepType` to allow the seven values `tool_call`, `decision`, `human_action`, `medical_review`, `policy_review`, `strategy`, `verification`
    - Add the audit-chain fields to `TraceStep` (each Trace_Step and each `human_action` audit event): `prevHash` (String), `hash` (String), and the mutating-change capture fields `beforeState` (Json?) and `afterState` (Json?), so each audit event stores its own hash and the hash of the immediately preceding event
    - Add an `IdempotencyKey` model (`key` unique, `caseId`, `operation`, `result` Json, `createdAt`) that records a client-supplied Idempotency_Key with the stored result of the mutating operation it guarded
    - Add the WhatsApp channel models: `ProcessedMessage` (`messageId` @id, `status`, `reservedAt`, `createdAt`) as the durable at-most-once dedupe/idempotency claim keyed by the inbound WhatsApp message id, and `WhatsAppMessage` (`id`, `caseId?`, `direction`, `sender`, `role`, `content`, `messageType`, `waMessageId?`, `providerMessageId?` (`@unique`, the inbound provider message id used for dedupe, aligning with `ProcessedMessage.messageId`/`waMessageId`), `timestamp`) with a `Case` relation (and the `Case.whatsappMessages WhatsAppMessage[]` reverse relation) recording every inbound/outbound channel message; note the `messageType` set also covers `"conversational"` (fallback replies) and `"notification"` (staff notifications) in addition to `text`/`interactive`/`button`/`image`/`audio`/`template`/`unsupported`
    - Add the `HandoffRequest` model (`id`, `caseId?` optional linked Case, `patientPhone`, `reason`, `urgent` Boolean default false, `createdAt`) recording a request for a staff member to contact a patient directly — raised on an explicit patient request (non-urgent) or automatically on an emergency (urgent)
    - Add `Case.patientPhone` (String?) — an opt-in number stored only to support generic, PHI-free status lookups (carries no medical detail) — and `Case.patientNameHint` (String?) — a free-text patient name from intake used only for status-by-name lookup (no PHI-bearing linkage) — and extend the allowed `intakeType` values with `"whatsapp_patient_note"`
    - Extend the `ExtractedField.sourceType` values to include `"human_provided"` so the full set is `raw_intake | chart_note | payer_policy | code_lookup | human_provided`, carrying evidence appended by the request_more_evidence action
    - Configure the SQLite datasource by default (`datasource db { provider = "sqlite"; url = env("DATABASE_URL") }`) and add a shared Prisma client module in `lib/db.ts`
    - Add a test helper that spins up an in-memory/temporary SQLite instance for tests
    - _Requirements: 2.2, 2.7, 2.8, 9.1, 14.1, 23.1, 23.2, 23.3, 25.1, 25.3, 26.2, 31.6, 32.4, 36.1, 40.9, 43.1_

  - [-] 2.2 Implement the stepType validation guard
    - Add a `createTraceStep` persistence guard in `lib/db.ts` that accepts a Trace_Step only when its step type is one of the seven allowed values; reject any other step type and record/return an error indication identifying the invalid step type
    - _Requirements: 23.3, 23.6_

  - [ ]* 2.3 Write property test for trace step type restriction
    - **Property 51: Trace step type restriction**
    - **Validates: Requirements 23.3, 23.6**
    - Use the stepType generator (values inside and outside the seven allowed values)

  - [ ] 2.4 Configure data-store portability (SQLite default, single-switch PostgreSQL)
    - Keep a single Prisma `datasource db` with `provider = "sqlite"` by default and `url = env("DATABASE_URL")`; ensure no model uses a SQLite-only construct and that `Json` columns map transparently to `TEXT`/`JSONB`, so switching to PostgreSQL is a single configuration change (set the datasource `provider` to `"postgresql"` and point `DATABASE_URL` at Postgres) with no change to application logic
    - _Requirements: 39.1, 39.2_

  - [ ]* 2.5 Write smoke/architectural test for data-store portability
    - Assert the schema declares one datasource whose provider is the only thing that changes between SQLite and PostgreSQL and that no model relies on a provider-specific construct, so a provider + `DATABASE_URL` switch requires no code change (Requirement 39 is smoke-tested, not a numbered property)
    - _Requirements: 39.1, 39.2_

- [ ] 3. Implement the Decision_Engine (pure logic)
  - [x] 3.1 Implement `decide()` in `lib/decisionEngine.ts`
    - Evaluate rules in order: iterations-exhausted OR contradictionCount > 0 → Escalate_To_Human (NeedsHumanInput); confidence > 85 → Auto_Draft (AwaitingApproval); 60 ≤ confidence ≤ 85 → Draft_And_Request_Evidence (AwaitingApproval); confidence < 60 → Escalate_To_Human (NeedsHumanInput)
    - Return `{ path, status }` with status derived from path
    - Treat the `contradictionCount` input as the number of blocking Findings supplied by the caller (see `lib/findings.ts`), so escalation-by-findings depends only on blocking findings
    - _Requirements: 4.4, 5.3, 5.4, 5.5, 5.7, 5.8, 5.9, 29.4_

  - [ ]* 3.2 Write property test for the Decision_Engine mapping
    - **Property 14: Decision engine mapping**
    - **Validates: Requirements 4.4, 5.3, 5.4, 5.5, 5.7, 5.8, 5.9**
    - Use the decision-input generator with emphasis on the 60 and 85 boundaries

  - [-] 3.3 Implement `computeOverallConfidence()` in `lib/decisionEngine.ts`
    - Aggregate extracted-field confidences into an overall score clamped to [0, 100]
    - _Requirements: 5.1_

  - [ ]* 3.4 Write property test for overall confidence range
    - **Property 15: Overall confidence stays in range**
    - **Validates: Requirements 5.1**

- [x] 4. Implement the SLA_Clock (pure logic)
  - [x] 4.1 Implement `slaDeadline()`, `remainingMs()`, and `isAtRisk()` in `lib/sla.ts`
    - `slaDeadline`: +7 days standard, +72 hours urgent; `remainingMs`: deadline minus now (may be negative); `isAtRisk`: remaining < 24h including overdue
    - _Requirements: 12.1, 12.2, 12.3_

  - [ ]* 4.2 Write property test for SLA deadline computation
    - **Property 30: SLA deadline computation**
    - Cover the `isUrgent`-driven deadline: `slaDeadline(createdAt, urgent)` returns `createdAt + 72h` when urgent and `createdAt + 7d` when standard, and a Case created without the urgent flag has `isUrgent` false with the 7-day deadline
    - **Validates: Requirements 1.8, 1.9, 12.1, 12.2**

  - [ ]* 4.3 Write property test for the at-risk boundary
    - **Property 31: At-risk boundary**
    - **Validates: Requirements 12.3**

- [ ] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement the Qwen_Client
  - [x] 6.1 Implement resilient `callQwen()` in `lib/qwen.ts`
    - Typed wrapper over the DashScope/OpenRouter chat-completions endpoint with `tools` (function-calling) support; parse `toolCalls`/`content`; read `QWEN_API_KEY`/`QWEN_API_BASE` and a per-attempt timeout (`QWEN_ATTEMPT_TIMEOUT_MS`)
    - Wrap each attempt in a bounded per-attempt timeout; retry only transient failures (network error, per-attempt timeout, or HTTP 429/500/502/503/504) using exponential backoff up to the 3-attempt total (original + 2); on a permanent failure (HTTP 4xx other than 429, or a malformed/empty response) stop immediately without a further retry
    - Add the pure, table-driven `classifyQwenFailure(err)` classifier mapping an error shape (`{ status?, timedOut?, body? }`) to `{ kind, transient }`, and use it inside `callQwen`
    - Never throw: resolve to a structured `QwenOutcome` — `{ ok: true, ... }` on success or a `QwenFailure { ok: false, kind, transient, attempts, detail }` on exhaustion or permanent failure — reported to the Agent_Runner
    - _Requirements: 6.5, 6.6, 6.7, 6.8_

  - [ ]* 6.2 Write property test for the retry bound
    - **Property 18: Qwen client retry bound**
    - **Validates: Requirements 6.5**
    - Use a deterministic fake that fails a configurable number of consecutive times

  - [ ]* 6.3 Write property test for transient-vs-permanent retry classification
    - **Property 57: Qwen transient-vs-permanent retry classification**
    - **Validates: Requirements 6.6, 6.7, 6.8**
    - Drive `classifyQwenFailure` and `callQwen` with generated failure sequences; assert transient runs make at most 3 attempts with exponential backoff and permanent failures return a structured `QwenFailure` on the first-failure attempt with no further retry

- [ ] 7. Implement the Agent_Tools
  - [-] 7.1 Implement Prisma-backed tools in `lib/agentTools.ts`
    - `fetchPatientRecord(patientId)` → patient + associated chart notes; `fetchPayerPolicy(payerId, procedureCode)` → matching policy or null; `checkPriorAuthHistory(patientId)` → that patient's cases
    - _Requirements: 3.1, 3.2, 3.4_

  - [ ]* 7.2 Write property test for patient record fetch round trip
    - **Property 6: Patient record fetch round trip**
    - **Validates: Requirements 3.1**

  - [ ]* 7.3 Write property test for payer policy fetch matching
    - **Property 7: Payer policy fetch matches**
    - **Validates: Requirements 3.2**

  - [ ]* 7.4 Write property test for prior-auth history isolation
    - **Property 8: Prior-auth history isolation**
    - **Validates: Requirements 3.4**

  - [ ] 7.5 Implement the NIH diagnosis-code lookup tool with graceful degradation
    - `lookupDiagnosisCode(code)` → `{ code, name, validated }`; treat network errors/non-200 as `{ validated: false }` rather than throwing
    - _Requirements: 3.3, 3.7_

  - [ ]* 7.6 Write unit tests for the diagnosis-code lookup
    - Happy-path integration example against the NIH shape (3.3) and the service-unavailable edge case returning `validated: false` (3.7)
    - _Requirements: 3.3, 3.7_

  - [ ] 7.7 Implement `dispatchTool()` centralized dispatch and tracing
    - Map Qwen tool name → implementation; wrap every tool in try/catch; record a `tool_call` Trace_Step (tool name, input, output, reasoning, timestamp) on success and on failure; return an error observation instead of throwing
    - _Requirements: 3.5, 3.6_

  - [ ]* 7.8 Write property test for resilient, always-traced dispatch
    - **Property 9: Tool dispatch is resilient and always traced**
    - **Validates: Requirements 3.5, 3.6**

  - [ ]* 7.9 Write property test for trace step completeness
    - **Property 10: Trace step completeness**
    - **Validates: Requirements 9.2**

- [x] 8. Implement the appeal PDF generator
  - [x] 8.1 Implement `generateAppealPdf()` in `lib/appealPdf.ts`
    - Use pdf-lib to render an appeal citing the denial reason, referenced Payer_Policy clause, and supporting Chart_Note evidence; persist the file and return `{ url }`
    - _Requirements: 7.3, 7.4_

  - [ ]* 8.2 Write property test for appeal citation completeness
    - **Property 20: Appeal packet cites required evidence**
    - **Validates: Requirements 7.3**

  - [ ]* 8.3 Write integration test for appeal PDF generation and storage
    - Generate a PDF for a sample case and assert a non-empty stored location reference
    - _Requirements: 7.4_

- [ ] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Implement entity extraction and detection helpers
  - [ ] 10.1 Implement extracted-field construction in the agent layer
    - Build Extracted_Field records for patient, payer, procedure code, diagnosis code, and denial reason with field name, value, confidence, source type, reasoning, timestamp, and originating step reference; mark undeterminable entities value "unknown" and confidence 0
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 9.1_

  - [ ]* 10.2 Write property test for required entity extraction
    - **Property 3: Required entities are extracted**
    - **Validates: Requirements 2.1**

  - [ ]* 10.3 Write property test for extracted-field completeness
    - **Property 4: Extracted field completeness**
    - **Validates: Requirements 2.2, 2.4, 9.1**

  - [ ]* 10.4 Write property test for undetermined-entity marking
    - **Property 5: Undetermined entities are marked unknown**
    - **Validates: Requirements 2.3**

  - [ ] 10.5 Implement contradiction, gap, and stale-note detection
    - Record a `Trace_Step` describing contradictions (with both conflicting sources), missing policy-required evidence gaps, and chart notes dated more than 90 days before case creation (including the note date)
    - _Requirements: 4.1, 4.2, 4.3_

  - [ ]* 10.6 Write property test for contradiction recording
    - **Property 11: Contradictions are recorded with both sources**
    - **Validates: Requirements 4.1**

  - [ ]* 10.7 Write property test for missing-evidence flagging
    - **Property 12: Missing policy-required evidence is flagged**
    - **Validates: Requirements 4.2**

  - [ ]* 10.8 Write property test for stale-note boundary flagging
    - **Property 13: Stale chart notes are flagged at the 90-day boundary**
    - **Validates: Requirements 4.3**

  - [ ] 10.9 Implement the structured Findings module in `lib/findings.ts`
    - Define `Finding` (`findingId`, `kind`, `severity`, optional `expected`/`actual`, `technicalMessage`, `friendlyMessage`); emit a Finding for every contradiction, gap, policy, and verification issue; always assign contradictions `severity: "blocking"`, and map Verification_QA flagged issues to `blocking` or `warning` according to their effect on appeal validity
    - Implement `blockingCount(findings)` (the value fed to the Decision_Engine as `contradictionCount`) and `shouldEscalate(findings)` (true iff at least one blocking finding exists); surface `warning` findings without forcing escalation
    - _Requirements: 29.1, 29.2, 29.3_

  - [ ]* 10.10 Write property test for findings-driven escalation
    - **Property 64: Escalation is driven only by blocking findings**
    - **Validates: Requirements 29.2, 29.4, 29.5**

- [ ] 11. Implement the Agent_Runner nine-stage pipeline
  - [ ] 11.1 Implement pipeline scaffolding and stage orchestration in `lib/agentRunner.ts`
    - Define the `PipelineStage` union and a `runStage(caseId, stage, ...)` helper that runs a bounded (≤ 8 iteration) plan→tool_call→observe cycle under a stage-specific system prompt and the stage's tool allow-list, tagging every Trace_Step it writes with the stage; sequence the stages in order (Intake_And_Extraction → Medical_Review/Policy_Review → Strategy → Decision_Intelligence → Appeal_Generation → Verification_QA), persisting each iteration's Trace_Steps/Extracted_Fields before the next call
    - On loop exhaustion without a decision, force Escalate_To_Human and record a Trace_Step with reasoning "needs manual review"; when `callQwen` reports a structured `QwenFailure`, degrade the calling stage gracefully by setting the Resolution_Path to Escalate_To_Human (NeedsHumanInput) rather than terminating the run abnormally; if any stage throws, record a failure Trace_Step naming the affected stage, set Escalate_To_Human, and do not run subsequent stages
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.9, 20.1, 20.5, 20.6_

  - [ ]* 11.2 Write property test for the loop cap forcing escalation
    - **Property 17: Loop cap forces escalation**
    - **Validates: Requirements 6.4**

  - [ ] 11.3 Implement stage-scoped tool allow-lists in `dispatchTool`
    - Add the `STAGE_TOOLS` map and extend `dispatchTool(name, args, stage)` to permit a tool only when it is in the active stage's allow-list, recording a failure `Trace_Step` for any refused tool; restrict Medical_Review to `fetchPatientRecord` only and Policy_Review to `fetchPayerPolicy` only
    - _Requirements: 3.8, 3.9_

  - [ ]* 11.4 Write property test for stage-scoped tool access
    - **Property 42: Stage-scoped tool access**
    - **Validates: Requirements 3.8, 3.9**

  - [ ] 11.5 Implement the Intake_And_Extraction stage
    - In a single Qwen call, resolve the patient, payer, procedure code, diagnosis code, and denial reason as Extracted_Fields (merging the former document + entity steps into one call); for any of the five that cannot be resolved, record a Trace_Step naming each unresolved field and continue the pipeline without terminating the Case
    - When the extracted patient matches a known `Patient` record, set `Case.patientId` to that record's id; when it does not match, leave `Case.patientId` unset and record the patient as an unresolved field
    - When the extracted payer resolves to a known `Payer`, set the Case payer reference (`Case.payerId` and `Case.payerName`) to that Payer; when it does not resolve, leave both unset and record the payer as an unresolved field
    - Before the raw Intake text (or any extracted document text) is placed into the extraction prompt, screen it through the Safety_Guard (`screenUntrusted`, `lib/guard.ts`): supply the content to Qwen strictly as fenced, labeled data (never as instructions), and on injection detection record a Trace_Step flagging the attempt
    - _Requirements: 2.5, 2.6, 2.7, 2.8, 20.3, 20.4, 20.12, 27.1, 27.4, 27.5_

  - [ ]* 11.6 Write property test for unresolved intake fields traced without terminating
    - **Property 38: Unresolved intake fields are traced without terminating**
    - **Validates: Requirements 20.4**

  - [ ] 11.7 Implement the parallel Medical_Review and Policy_Review stages
    - Run `Promise.all([runStage(..., "Medical_Review"), runStage(..., "Policy_Review")])` so each begins before the other completes; Medical_Review is scoped to `fetchPatientRecord` and writes `stepType: "medical_review"`, Policy_Review is scoped to `fetchPayerPolicy` and writes `stepType: "policy_review"`; each produces a summary consumed downstream
    - _Requirements: 20.2, 20.7, 20.8_

  - [ ]* 11.8 Write property test for Medical and Policy review overlap
    - **Property 37: Medical and Policy reviews overlap**
    - **Validates: Requirements 20.2**

  - [ ] 11.9 Implement the Strategy stage
    - Invoke `checkPriorAuthHistory(patientId)` and use payer-specific track record plus multi-payer policy diffing as an input; compute 1–5 candidate approaches each with an integer win-probability (0–100); when history is empty or the tool fails, fall back to payer track record only and set `usedPriorAuthHistory: false`; store `strategyOptions` ordered by descending win-probability; write `stepType: "strategy"`; provide the Strategy_Options summary to Decision_Intelligence
    - _Requirements: 17.3, 20.9, 21.1, 21.2, 21.3, 21.4, 21.5, 23.1_

  - [ ]* 11.10 Write property test for win-probability count and range
    - **Property 43: Win-probability count and range**
    - **Validates: Requirements 21.2**

  - [ ]* 11.11 Write property test for strategy options ordered by descending win-probability
    - **Property 44: Strategy options ordered by descending win-probability**
    - **Validates: Requirements 21.4**

  - [ ]* 11.12 Write property test for the strategy fallback when history is unavailable
    - **Property 45: Strategy fallback when history is unavailable**
    - **Validates: Requirements 21.3**

  - [ ] 11.13 Implement the Decision_Intelligence stage
    - Call the pure `decide()` over the Medical_Review, Policy_Review, and Strategy summaries (not raw documents), passing `contradictionCount = blockingCount(findings)` so routing is driven only by blocking Findings while `warning` findings are surfaced to the reviewer without forcing escalation; persist a `decision` Trace_Step storing overall confidence, path, and reasoning; on Auto_Draft/Draft_And_Request_Evidence set AwaitingApproval (recording requested evidence for the medium path) and on Escalate_To_Human set NeedsHumanInput, performing each Case_Status change through `assertTransition` (`lib/caseStatus.ts`)
    - _Requirements: 5.2, 5.6, 5.7, 5.8, 5.9, 28.1, 29.4, 29.5_

  - [ ]* 11.14 Write property test for decision tracing
    - **Property 16: Decisions are traced**
    - **Validates: Requirements 5.6**

  - [ ] 11.15 Implement the Appeal_Generation stage
    - For Auto_Draft / Draft_And_Request_Evidence, generate the appeal PDF from the Decision_Intelligence stage output and store `appealPdfUrl`; skip generation on Escalate_To_Human
    - _Requirements: 7.1, 7.2_

  - [ ]* 11.16 Write property test for conditional appeal generation
    - **Property 19: Appeal PDF generated only on drafting paths**
    - **Validates: Requirements 7.1**

  - [ ]* 11.17 Write property test for appeal location storage
    - **Property 21: Appeal location is stored**
    - **Validates: Requirements 7.4**

  - [ ] 11.18 Implement the Verification_QA stage
    - Independently check every citation against retrieved Payer_Policy/Chart_Note data, every patient/policy/code reference against the Case Extracted_Field values, and every claim against the retrieved evidence; collect all flagged issues; derive `status` as `pass` iff the list is empty else `fail`; on a processing error store `{ status: "fail", flaggedIssues: [{ type: "verification_error", ... }] }`; store `verificationResult`, write `stepType: "verification"`, and only set the verified AwaitingApproval state after the result is stored
    - Add the grounding check: every citation and reference in the Appeal_Packet (payer-policy clause/identifier, chart-note evidence, diagnosis/procedure code, and patient) must resolve to an actual stored record in scope for the Case; for each that does not, add an `unresolved_citation` flagged issue with `severity: "blocking"`, which forces `status: "fail"` so the appeal is never presented as verified
    - Record each flagged issue as a `Finding` (`lib/findings.ts`) so blocking issues drive routing while warnings stay visible
    - _Requirements: 20.10, 22.1, 22.2, 22.3, 22.4, 22.5, 22.7, 22.8, 22.9, 23.2, 29.1, 29.3_

  - [ ]* 11.19 Write property test for verification flagging all discrepancies
    - **Property 46: Verification flags all discrepancies**
    - **Validates: Requirements 22.1, 22.2, 22.3**

  - [ ]* 11.20 Write property test for the verification pass/fail definition
    - **Property 47: Verification pass/fail definition**
    - **Validates: Requirements 22.4**

  - [ ]* 11.21 Write property test for verification gating human approval
    - **Property 48: Verification gates human approval**
    - **Validates: Requirements 22.5**

  - [ ]* 11.22 Write property test for verification processing error yielding a fail result
    - **Property 49: Verification processing error yields a fail result**
    - **Validates: Requirements 22.7**

  - [ ] 11.23 Produce the plain-English explanation and store the recommendation
    - Generate a non-empty plain-English explanation of the denial reason and next steps; store the recommendation JSON and explanation on the Case
    - _Requirements: 15.1_

  - [ ]* 11.24 Write property test for plain-English explanation production
    - **Property 33: Plain-English explanation is always produced**
    - **Validates: Requirements 15.1**

  - [ ] 11.25 Wire failure-safe persistence of strategyOptions and verificationResult
    - Persist `strategyOptions` and `verificationResult` through the guarded persistence path; if either persistence fails, record a failure `Trace_Step` and retain the existing Case `recommendation` unchanged (never overwrite it)
    - _Requirements: 23.5_

  - [ ]* 11.26 Write property test for persistence failure preserving the recommendation
    - **Property 52: Persistence failure preserves the recommendation**
    - **Validates: Requirements 23.5**

  - [ ]* 11.27 Write property test for pipeline stage ordering
    - **Property 36: Pipeline stage ordering**
    - **Validates: Requirements 20.1**

  - [ ]* 11.28 Write property test for every executed stage emitting a labeled trace step
    - **Property 39: Every executed stage emits a labeled trace step**
    - **Validates: Requirements 20.5**

  - [ ]* 11.29 Write property test for stage failure escalating and halting the pipeline
    - **Property 40: Stage failure escalates and halts the pipeline**
    - **Validates: Requirements 20.6**

  - [ ]* 11.30 Write property test for per-stage trace labeling
    - **Property 41: Per-stage trace labeling**
    - **Validates: Requirements 20.7, 20.8, 20.9, 20.10**

  - [ ]* 11.31 Write smoke/architectural tests for pipeline wiring guarantees
    - Assert the tool registry contains only the five existing tools (20.11); the pipeline defines exactly the nine named stages with no separate Learning/Memory/Document/Entity/Orchestrator Qwen call (20.12); Decision_Intelligence and Appeal_Generation receive summary/decision objects rather than raw documents (5.2, 7.2); Intake_And_Extraction resolves the five fields in one stage (20.3); and the Strategy stage invokes `checkPriorAuthHistory` and consumes the multi-payer policy diff (21.1, 17.3)
    - _Requirements: 5.2, 7.2, 17.3, 20.3, 20.11, 20.12, 21.1_

  - [ ]* 11.32 Write property test for patient and payer linkage
    - **Property 53: Patient and payer linkage set on resolve, unset otherwise**
    - Assert `Case.patientId` is set to a matched Patient's id when the patient matches and left unset otherwise; the Case payer reference (`payerId`/`payerName`) is set to a resolved Payer and left unset otherwise; and in each unresolved case a Trace_Step identifying that field as unresolved is recorded
    - **Validates: Requirements 2.5, 2.6, 2.7, 2.8**

  - [ ]* 11.33 Write property test for the citation grounding check
    - **Property 58: Unresolved citations force a blocking verification fail**
    - **Validates: Requirements 22.8, 22.9**
    - Assert an `unresolved_citation` blocking issue is added for exactly the citations/references that do not resolve to an in-scope stored record (and none for those that do), and that any unresolved reference forces the stored `verificationResult.status` to `fail`

- [ ] 12. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. Implement intake and case creation API
  - [ ] 13.1 Implement `POST /api/cases` with zod validation and async kickoff
    - Validate intake (reject empty/whitespace text with no file and missing/invalid intake type with a field-identifying 400); accept an optional `urgent` boolean that defaults to `false` when omitted; on PDF upload extract text via pdf-lib and store as raw intake; create Case status New, setting `Case.isUrgent` from the `urgent` flag and computing `slaDeadline` via `slaDeadline(createdAt, urgent)`; kick off `runAgent` async and return the caseId immediately
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 1.8, 1.9, 12.1_

  - [ ]* 13.2 Write property test for case creation preserving intake
    - **Property 1: Case creation preserves intake**
    - **Validates: Requirements 1.1**

  - [ ]* 13.3 Write property test for invalid intake rejection
    - **Property 2: Invalid intake is rejected**
    - **Validates: Requirements 1.3, 1.4**

  - [ ]* 13.4 Write unit/integration tests for intake edge behaviors
    - Assert immediate caseId return without waiting for the run (1.5) and PDF text extraction on upload (1.2)
    - _Requirements: 1.2, 1.5_

- [ ] 14. Implement case read, trace, and analytics APIs
  - [ ] 14.1 Implement `GET /api/cases` and `GET /api/cases/[id]`
    - List all cases for the Dashboard; return full case detail (fields, trace steps, recommendation, appeal); 404 on unknown id
    - _Requirements: 10.1, 13.1_

  - [ ]* 14.2 Write property test for dashboard grouping partition
    - **Property 28: Dashboard grouping partitions all cases**
    - **Validates: Requirements 10.1**

  - [ ] 14.3 Implement `GET /api/cases/[id]/trace` with since-timestamp filtering
    - Return only Trace_Steps whose timestamp is strictly after the `since` value
    - _Requirements: 11.3_

  - [ ]* 14.4 Write property test for trace-since filtering
    - **Property 29: Trace-since returns only newer steps**
    - **Validates: Requirements 11.3**

  - [ ] 14.5 Implement the audit merge and `GET /api/cases/[id]/audit/export`
    - Merge Extracted_Field and Trace_Step records chronologically (non-decreasing by timestamp, lossless); return the persisted `strategyOptions` and `verificationResult` for the Case unchanged from what the Strategy and Verification_QA stages stored, retrievable independently of the recommendation; generate an audit-trail PDF for export
    - _Requirements: 9.3, 9.4, 23.4_

  - [ ]* 14.6 Write property test for chronological, lossless audit merge
    - **Property 27: Audit trail is chronological and lossless**
    - **Validates: Requirements 9.3**

  - [ ]* 14.7 Write integration test for audit PDF export
    - Generate an audit PDF for a case and assert it contains the full trail
    - _Requirements: 9.4_

  - [ ] 14.8 Implement `GET /api/analytics`, `GET /api/policies/compare`, and `GET /api/patients/search`
    - Denials-by-payer aggregation grouping Cases by the Case payer reference (`Case.payerId`/`Case.payerName`), placing every Case whose payer reference is unset into a single "Unknown payer" bucket so grouped totals equal the number of Cases with a denial reason; resolution rate, average time-to-resolution, at-risk list; per-payer policy retrieval and diff explanation for a procedure code; patient-name search
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 17.1, 17.2, 19.2_

  - [ ]* 14.9 Write property test for denials-by-payer aggregation
    - **Property 32: Denials-by-payer aggregation is exact**
    - Assert grouping by the Case payer reference with an "Unknown payer" bucket for unset payers, and that the sum of all reported counts (including the bucket) equals the total number of Cases with a denial reason
    - **Validates: Requirements 14.1**

  - [ ]* 14.10 Write property test for policy comparison retrieval
    - **Property 34: Policy comparison retrieves per-payer criteria**
    - **Validates: Requirements 17.1**

  - [ ]* 14.11 Write property test for global search filtering
    - **Property 35: Global search filters by patient name**
    - **Validates: Requirements 19.2**

  - [ ]* 14.12 Write property test for lossless strategy/verification persistence and retrieval
    - **Property 50: Strategy and verification outputs persist and retrieve losslessly**
    - **Validates: Requirements 23.1, 23.2, 23.4**

- [ ] 15. Implement the shared case action and human-action API
  - [ ] 15.1 Implement `POST /api/cases/[id]/action`
    - Handle Approve, Reject, Edit, and Request More Evidence by **delegating to the shared `performCaseAction(caseId, actionType, meta)` operation** (`lib/caseActions.ts`, task 15.10) with `meta.source: "dashboard"` — the route contains no case-action logic of its own and is not the writer of the `human_action` Trace_Step; map the structured `CaseActionResult` to the HTTP response (never mark sent without a recorded Approve; 400 on malformed payloads)
    - Also handle the two Case_Outcome action types for Cases in status `AppealSent`: `appeal_won` → `Resolved` and `appeal_denied` → `DeniedFinal`, setting `Case.resolvedAt` to the processing timestamp and recording a `human_action` Trace_Step describing the outcome
    - Reject any Case_Outcome action when the Case status is not `AppealSent`, leaving status and `resolvedAt` unchanged, recording no Trace_Step, and returning a message identifying that the Case must be in status `AppealSent`
    - Perform the status change, `resolvedAt` update, and Trace_Step write atomically so that a persistence failure rolls back all three effects (Case retains `AppealSent` and its prior `resolvedAt`) and returns a message indicating the outcome was not recorded
    - Accept a client-supplied `Idempotency-Key` header and wrap submission/approval/outcome/stage-advancing writes in `withIdempotency` (`lib/idempotency.ts`) so a retried request applies its effect at most once and returns the stored original result; perform every Case_Status change through `assertTransition` (`lib/caseStatus.ts`), rejecting illegal transitions and leaving status unchanged
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 16.1, 16.2, 24.2, 24.3, 24.4, 24.5, 24.6, 26.1, 26.4, 26.5, 28.1, 28.2, 28.5, 40.1, 40.2, 40.3_

  - [ ]* 15.2 Write property test for approve and reject transitions
    - **Property 22: Approve and reject transitions**
    - **Validates: Requirements 8.2, 8.3**

  - [ ]* 15.3 Write property test for edit storing revised content
    - **Property 23: Edit stores revised content**
    - **Validates: Requirements 8.4**

  - [ ]* 15.4 Write property test for request-more-evidence re-run with combined context
    - **Property 24: Request-more-evidence re-runs with combined context**
    - **Validates: Requirements 8.5, 16.1**

  - [ ]* 15.5 Write property test for no-send-without-approval
    - **Property 25: No outbound action sent without human approval**
    - **Validates: Requirements 8.6, 8.7**

  - [ ]* 15.6 Write property test for re-runs growing the audit trail without loss
    - **Property 26: Re-runs grow the audit trail without loss**
    - **Validates: Requirements 16.2**

  - [ ]* 15.7 Write property test for case outcome transitions from AppealSent
    - **Property 54: Case outcome transitions from AppealSent**
    - Assert `appeal_won` sets status `Resolved` and `appeal_denied` sets status `DeniedFinal`; in both cases `Case.resolvedAt` is set to the processing timestamp and exactly one new `human_action` Trace_Step describing the outcome is recorded
    - **Validates: Requirements 24.2, 24.3**

  - [ ]* 15.8 Write property test for outcome actions rejected outside AppealSent
    - **Property 55: Outcome actions rejected outside AppealSent**
    - Assert that for any non-`AppealSent` status either Case_Outcome action is rejected, leaving status and `resolvedAt` unchanged, adding no Trace_Step, and returning the "must be in status AppealSent" message
    - **Validates: Requirements 24.1, 24.4**

  - [ ]* 15.9 Write property test for outcome persistence failure rolling back atomically
    - **Property 56: Outcome persistence failure rolls back atomically**
    - Assert that when persisting the status change, `resolvedAt`, or the Trace_Step fails, all three effects roll back (Case retains `AppealSent` and its prior `resolvedAt`, no partial Trace_Step) and a message indicating the outcome was not recorded is returned
    - **Validates: Requirements 24.5**

  - [ ] 15.10 Implement the shared case action in `lib/caseActions.ts`
    - Implement `performCaseAction(caseId, actionType, meta)` as the single shared implementation of approve/reject/edit/request_more_evidence invoked by **both** the Dashboard action route (task 15.1) and the WhatsApp staff-command handler (task 26.11), differing only in `meta.source` (`"dashboard"` | `"whatsapp"`); make it the **sole writer** of the `human_action` Trace_Step for these four transitions, recording `meta.source` as the channel source; return a structured `CaseActionResult` (`success`, `newStatus`, `message`, optional `pdfUrl`) and **never throw** — wrap the whole body so any persistence/tool error becomes `{ success: false, newStatus: <unchanged>, message }`
    - approve → generate the `Appeal_Packet` via `generateAppealPdf` if none exists, set `AppealSent`, invoke the simulated Submission_And_Tracking step, and return the appeal location as `pdfUrl`; reject → set `NeedsHumanInput` and send a staff manual-review notification on the WhatsApp_Channel; edit → dashboard-only apply to the Case `recommendation` without a status change, and when `meta.source === "whatsapp"` refuse with a message leaving `recommendation`/`Case_Status` unchanged; request_more_evidence → append the evidence as an `Extracted_Field` with `sourceType: "human_provided"`, set `Investigating`, and re-invoke the `Agent_Runner` pipeline as a fire-and-forget re-run (consistent with Requirement 16)
    - Apply every `Case_Status` change through `assertTransition` (`lib/caseStatus.ts`) and wrap it in `withIdempotency(meta.idempotencyKey, …)` (`lib/idempotency.ts`) so a legal transition takes effect at most once across retries/redeliveries
    - _Requirements: 40.1, 40.2, 40.3, 40.4, 40.5, 40.6, 40.7, 40.8, 40.9, 40.10, 8.10, 16.1, 26.4, 28.1_

  - [ ]* 15.11 Write property test for shared case action dispatch per action type
    - **Property 75: Shared case action dispatches each action type correctly**
    - Assert approve→PDF+AppealSent+submission+pdfUrl, reject→NeedsHumanInput+staff notification, edit dashboard-applied vs whatsapp-refused, request_more_evidence→`human_provided` Extracted_Field+Investigating+fire-and-forget re-run; every status change flows through `assertTransition`/`withIdempotency` and the `human_action` Trace_Step is written only here
    - **Validates: Requirements 40.3, 40.5, 40.6, 40.7, 40.8, 40.9, 40.10, 8.10**

  - [ ]* 15.12 Write property test for shared case action never throwing
    - **Property 76: Shared case action never throws**
    - Assert that for any `CaseActionType` and any injected persistence failure at any point, `performCaseAction` resolves to `{ success: false, message: <non-empty> }`, leaves `Case_Status` unchanged, and never propagates an exception
    - **Validates: Requirements 40.4**

- [ ] 16. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 17. Implement shared layout and navigation
  - [ ] 17.1 Build `app/layout.tsx` with sidebar, global search, and agent-status indicator
    - Persistent sidebar (Dashboard / New Case / Analytics) on every page; global patient search wired to `/api/patients/search`; `AgentStatusIndicator` showing running case id or "Idle"
    - _Requirements: 19.1, 19.2, 19.3, 19.4_

  - [ ]* 17.2 Write component tests for navigation and status indicator
    - Assert sidebar links render on every page and the status indicator toggles between running-case and Idle
    - _Requirements: 19.1, 19.3, 19.4_

- [ ] 18. Implement the Intake page
  - [ ] 18.1 Build `app/intake/page.tsx` with `IntakeForm`
    - Textarea + file upload + intake-type select + an urgent toggle that defaults to off (drives `Case.isUrgent` and the SLA deadline); POST `/api/cases`; redirect to the Case Detail page on the returned caseId
    - _Requirements: 1.6, 1.7, 10.4_

  - [ ]* 18.2 Write component test for intake redirect
    - Assert successful submission redirects to `/case/[id]`
    - _Requirements: 1.6_

- [ ] 19. Implement the Dashboard page
  - [ ] 19.1 Build `app/page.tsx` Kanban board, case cards, and denials widget
    - `KanbanBoard` with a column per Case_Status; `CaseCard` shows patient initials, payer, procedure, confidence badge, `SlaCountdownRing`, and at-risk indicator; `DenialsByPayerWidget` (Recharts) for the current month; card click opens Case Detail; New Case control opens Intake
    - _Requirements: 10.1, 10.2, 10.3, 10.5, 12.2, 12.4_

  - [ ]* 19.2 Write component tests for card content and navigation
    - Assert card fields, confidence badge, SLA countdown, at-risk indicator, and card/New-Case navigation
    - _Requirements: 10.2, 10.3, 10.5, 12.4_

- [ ] 20. Implement the Case Detail page
  - [ ] 20.1 Build `app/case/[id]/page.tsx` facts panel, live trace, and action zone
    - `CaseFactsPanel` (extracted fields with confidence chips and expandable source tags); `LiveTracePanel` polling `/trace` every 1s while Investigating with Framer Motion entrance, labeling each trace line with a stage icon/label derived from its `stepType` (🩺 medical_review, 📚 policy_review, 🎯 strategy, ✅ verification, 🤖 decision, plus the tool name for tool_call steps); `HumanActionZone` (recommendation + Approve/Edit/Request More Evidence/Reject + appeal PDF preview/download + plain-English explanation) wired to `/action`, displaying each flagged issue alongside the recommendation when the stored `verificationResult.status` is `fail`
    - In `HumanActionZone`, when the Case status is `AppealSent`, show the two Case_Outcome controls **Appeal Won** and **Appeal Denied** (which POST `appeal_won`/`appeal_denied` to `/action`); show these controls only for `AppealSent` cases and hide them in every other status
    - _Requirements: 7.5, 8.1, 11.1, 11.2, 11.4, 11.5, 13.1, 13.2, 13.3, 13.4, 15.2, 20.7, 20.8, 20.9, 20.10, 22.6, 24.1_

  - [ ]* 20.2 Write component tests for panels, polling, stage labels, and flagged issues
    - Assert fact/source-tag expansion, 1s trace polling and chronological append, per-stepType stage icon/label rendering in the live trace (11.5, 20.7–20.10), action buttons in AwaitingApproval, appeal preview/download when present, plain-English display, and flagged-issue display in HumanActionZone when `verificationResult.status` is `fail` (22.6)
    - Assert the Appeal Won / Appeal Denied controls render only when the Case status is `AppealSent` and are hidden in every other status (24.1)
    - _Requirements: 11.1, 11.2, 11.4, 11.5, 13.2, 13.4, 15.2, 20.7, 20.8, 20.9, 20.10, 22.6, 24.1_

- [ ] 21. Implement the Audit and Analytics pages
  - [ ] 21.1 Build `app/case/[id]/audit/page.tsx` and `app/analytics/page.tsx`
    - Audit: merged chronological timeline of fields + trace steps with "Download as PDF"; Analytics: denials-by-payer bar chart, resolution rate, average time-to-resolution, at-risk list (Recharts)
    - _Requirements: 9.3, 9.4, 14.1, 14.2, 14.3, 14.4_

  - [ ]* 21.2 Write component tests for audit timeline and analytics charts
    - Assert chronological merged rendering and that all four analytics views render from `/api/analytics`
    - _Requirements: 14.2, 14.3, 14.4_

- [ ] 22. Implement seed and demo reset
  - [ ] 22.1 Build `prisma/seed.ts` and `POST /api/demo/reset`
    - Seed ≥3 payers (each ≥2 policies), 6–8 patients (each 1–3 chart notes including a stale note, a mismatched diagnosis code, and a missing-evidence reference), 4–5 cases across statuses, and at least one case per Resolution_Path; reset re-runs the seed
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5_

  - [ ]* 22.2 Write smoke tests for seed content and reset
    - Assert seed counts/content invariants and that reset restores the seeded set
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5_

- [ ] 23. Implement hardening: safety guard, status FSM, audit chain, and idempotency
  - [ ] 23.1 Implement the Safety_Guard in `lib/guard.ts`
    - Implement `screenUntrusted` as a deterministic, non-LLM screen that returns the content fenced and labeled as data (never as instructions) and sets `injectionDetected` true iff the text matches at least one prompt-injection / instruction-override pattern; consumed by the Intake_And_Extraction stage (task 11.5) before any Qwen call
    - _Requirements: 27.2, 27.3_

  - [ ]* 23.2 Write property test for the safety guard
    - **Property 62: Safety guard fences untrusted content and detects injection deterministically**
    - **Validates: Requirements 27.2, 27.3, 27.4, 27.5**

  - [ ] 23.3 Implement the case-status state machine in `lib/caseStatus.ts`
    - Define `ALLOWED_TRANSITIONS` per the Requirement 28 table and `assertTransition(from, to)`: accept iff `to` is in the allowed set for `from`; reject an illegal transition leaving the status unchanged and returning a message identifying it; treat a same-state request as an idempotent no-op success; reject every outgoing transition from a terminal status (`Resolved`, `DeniedFinal`)
    - Route every status write — runner stage-advances (task 11.13), the action route and Case_Outcome recording (task 15.1) — through `assertTransition`
    - _Requirements: 28.1, 28.2, 28.3, 28.4, 28.5_

  - [ ]* 23.4 Write property test for the status transition table
    - **Property 63: Status transitions obey the allowed-transition table**
    - **Validates: Requirements 28.1, 28.2, 28.3, 28.4, 28.5**

  - [ ] 23.5 Implement the tamper-evident audit chain in `lib/auditChain.ts`
    - Implement `GENESIS_HASH`, `canonicalSerialize` (deterministic, order-stable), `computeHash(prevHash, content) = sha256(prevHash + canonicalSerialize(content))`, and `verifyAuditChain(caseId)` returning `{ intact, headHash, firstBrokenEventId?, reason? }`
    - Wire hash-chained writes into the trace-step persistence path (`createTraceStep` in `lib/db.ts`): the first event's `prevHash` is `GENESIS_HASH`, each subsequent event's `prevHash` is the previous event's stored `hash`, and each event captures its `beforeState`/`afterState` for mutating changes
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.7_

  - [ ]* 23.6 Write property test for an untampered chain verifying as intact
    - **Property 59: Untampered audit chain verifies as intact**
    - **Validates: Requirements 25.1, 25.2, 25.7**

  - [ ]* 23.7 Write property test for tamper detection and localization
    - **Property 60: Tampering breaks the chain and the first broken event is identified**
    - **Validates: Requirements 25.5, 25.6**

  - [ ] 23.8 Implement `GET /api/cases/[id]/audit/verify`
    - Call `verifyAuditChain(caseId)` and return whether the Audit_Chain is intact together with the head hash (and the first broken event id when broken)
    - _Requirements: 25.4_

  - [ ] 23.9 Implement idempotency support in `lib/idempotency.ts`
    - Implement `withIdempotency(key, operation, run)` that applies the effect and stores the result the first time a key is seen and returns the stored original result on any retry with the same key, applying the effect at most once; wired into the action route (task 15.1) for submission/approval/outcome/stage-advance
    - _Requirements: 26.1, 26.2, 26.3, 26.4, 26.5_

  - [ ]* 23.10 Write property test for idempotent mutating operations
    - **Property 61: Mutating operations are idempotent under a repeated key**
    - **Validates: Requirements 26.2, 26.3, 26.4, 26.5**

- [ ] 24. Implement gold-case behavioral evaluation
  - [ ] 24.1 Build gold-case fixtures and the evaluation runner
    - Author the `eval/gold/*.json` fixtures (each with a fixed Intake and the expected Resolution_Path and expected triggering Finding identifier(s)) and `scripts/eval.ts` exposing `runGoldCases` that executes each Gold_Case against deterministic fakes and reports a per-case pass/fail; a Gold_Case passes only when both the produced Resolution_Path and the produced triggering Finding identifier(s) match the expected values; note it can gate CI
    - _Requirements: 30.1, 30.2, 30.3, 30.4_

  - [ ]* 24.2 Write property test for gold-case evaluation
    - **Property 65: Gold-case evaluation passes iff path and triggering findings match**
    - **Validates: Requirements 30.2, 30.3, 30.4**

- [x] 25. Implement application configuration validation
  - [x] 25.1 Implement the fail-fast config loader in `lib/config.ts`
    - Implement `loadConfig(env)` with Zod: require `QWEN_API_KEY`, `QWEN_API_BASE` (URL), and `DATABASE_URL`; treat the four WhatsApp keys (`WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`) as an all-or-nothing group; on failure fail fast with a message naming every missing/invalid key, treating any strict non-empty subset of the WhatsApp group as a validation failure
    - Expose `whatsappEnabled(cfg)` returning true iff the `whatsapp` block is present (all four WhatsApp keys set); implement `redactedSummary(cfg)` mapping each configuration key to only `"set"` or `"missing"` and never emitting any secret value; invoke `loadConfig` once at boot so misconfiguration is caught immediately
    - _Requirements: 38.1, 38.2, 38.3, 38.4_

  - [ ]* 25.2 Write property test for fail-fast, all-or-nothing config validation
    - **Property 73: Config validation is fail-fast and all-or-nothing**
    - **Validates: Requirements 38.1, 38.2, 38.3**

  - [ ]* 25.3 Write property test for the secret-free config summary
    - **Property 74: Config summary never leaks a secret**
    - **Validates: Requirements 38.4**

- [ ] 26. Implement the WhatsApp channel
  - [-] 26.1 Implement request-signature verification in `lib/whatsapp/signature.ts`
    - Implement `computeSignatureHeader(rawBody, appSecret)` producing the `sha256=<hex>` HMAC over the exact raw bytes, and `verifySignatureWithSecret(rawBody, presentedHeader, appSecret)` doing a constant-time compare that returns `false` (never throws) on any body/secret/signature alteration or malformed/wrong-length header
    - _Requirements: 31.3, 31.4_

  - [ ]* 26.2 Write property test for exact signature verification
    - **Property 66: WhatsApp signature verification is exact**
    - **Validates: Requirements 31.3, 31.4**

  - [ ] 26.3 Implement the GET verify handshake in `app/api/whatsapp/webhook/route.ts`
    - Add the `runtime = "nodejs"` route and its `GET` handler that compares the presented verify token against the configured verify token and echoes the presented challenge only when they match, rejecting (returning no challenge) otherwise
    - _Requirements: 31.1, 31.2_

  - [ ]* 26.4 Write property test for the verify handshake
    - **Property 67: WhatsApp verify handshake matches tokens exactly**
    - **Validates: Requirements 31.1, 31.2**

  - [ ] 26.5 Implement two-layer inbound dedupe in `lib/whatsapp/dedupe.ts`
    - Implement `createDedupe()` with a process-local ring buffer (fast path) plus a durable Prisma `ProcessedMessage` claim: `claim(messageId)` atomically wins at most once per id (subsequent claims fail), `markProcessed`/`release` manage claim state, and the durable layer fails open (returns true) on a store error so a fault never silently drops a message
    - _Requirements: 31.6_

  - [ ]* 26.6 Write property test for at-most-once inbound dedupe
    - **Property 68: Inbound dedupe is idempotent (at most once)**
    - **Validates: Requirements 31.6**

  - [ ] 26.7 Implement the total inbound parser in `lib/whatsapp/parseInbound.ts`
    - Implement `extractInboundMessages(payload)` to flatten a provider webhook envelope into individual messages and the total `parseInbound(raw, phoneNumberId)` mapping each raw message to exactly one `NormalizedInbound`, classifying unknown/unclassifiable messages as `kind: "unsupported"` with an empty `body` rather than dropping or throwing
    - _Requirements: 32.1, 32.2_

  - [ ]* 26.8 Write property test for the total inbound parser
    - **Property 69: Inbound parser is total**
    - **Validates: Requirements 32.1, 32.2**

  - [ ] 26.9 Implement outbound sending with window fallback in `lib/whatsapp/sender.ts`
    - Implement `createSender(config)` exposing `sendText`, `sendTemplate`, `sendInteractiveButtons`, and `sendWithWindowFallback`, plus `isWindowClosed(err)`; apply an 8-second timeout per outbound call; on a closed-window failure, re-attempt exactly once using an approved template and then stop (never an automatic resend loop); a successful in-window attempt makes no fallback attempt
    - _Requirements: 33.4, 33.5, 33.6_

  - [ ]* 26.10 Write property test for the closed-window single re-attempt
    - **Property 72: Closed-window fallback re-attempts at most once**
    - **Validates: Requirements 33.5, 33.6**

  - [ ] 26.11 Implement role-based routing in `lib/whatsapp/router.ts`
    - Implement `resolveRole(phone, staffNumbers)` (registered `Staff_Number` ⇒ staff, else patient), `parseStaffCommand(text)` (total parser for `Approve`/`Reject`/`Status`/`Show`, non-commands → `{ kind: "none" }`), the generic PHI-free `PATIENT_TEMPLATES` set (including `needsMoreInfo` that never names the missing item), and `routeInbound(inbound, ports)` over injected `RouterPorts` (including the `performCaseAction`, `classifyMedia`, `detectEmergency`, `recordHandoff`, and `conversationalFallback` ports used by tasks 26.22–26.35)
    - Patient intake (free text or denial-letter image) → screen the text through the `Safety_Guard`, create a Case with `intakeType: "whatsapp_patient_note"` storing the message/extracted text as raw Intake, run the normal nine-stage pipeline, and reply with the `caseCreated` acknowledgement template; patient status question → look up the most recent open Case by phone and reply with a generic `statusGeneric` template (or `noOpenCase`) without re-running the pipeline
    - Staff command from a registered `Staff_Number` → `Approve`/`Reject` perform the same `Human_Action` as the dashboard by **delegating to the shared `performCaseAction` operation** (`lib/caseActions.ts`, task 15.10) via the injected `performCaseAction` port with `meta.source: "whatsapp"` — the same implementation the Dashboard invokes, never a channel-local copy — which itself applies the status change through `assertTransition` and `withIdempotency`; `Status`/`Show` reply with a one-line summary / Case Detail link and mutate nothing; a non-staff action command is rejected without changing any Case
    - _Requirements: 32.1, 32.2, 32.3, 32.4, 32.5, 33.1, 33.2, 33.3, 33.4, 34.1, 34.2, 34.3, 34.4, 34.5, 34.6, 34.7, 34.8, 8.8, 8.9, 8.10_

  - [ ]* 26.12 Write property test for staff-command parsing and authorization
    - **Property 70: Staff commands parse correctly and only registered numbers act**
    - **Validates: Requirements 34.1, 34.7**

  - [ ]* 26.13 Write property test for PHI-free patient outbound templates
    - **Property 71: Patient outbound is always a PHI-free template**
    - **Validates: Requirements 33.2, 33.3, 33.4, 36.3**

  - [ ] 26.14 Implement the port-binding composition root in `lib/whatsapp/wiring.ts`
    - Implement `buildRouterPorts()` binding the abstract `RouterPorts` to the real in-process services: `createCase` to the case-creation logic used by `/api/cases`, `performCaseAction` to the shared `lib/caseActions.ts` operation used by `/api/cases/[id]/action` (task 15.10), the lookups to Prisma queries, `classifyMedia` to the media gate (task 26.22), `detectEmergency` to the deterministic emergency detector (task 26.25), `recordHandoff` to the handoff store + staff broadcast (task 26.27), `conversationalFallback` to the scoped LLM fallback (task 26.29), `send` to `createSender(config)`, and `guard` to `screenUntrusted`
    - _Requirements: 34.2, 34.6, 34.8, 40.2, 41.1, 42.4, 43.1, 44.1_

  - [ ] 26.15 Wire the webhook POST inbound pipeline in `app/api/whatsapp/webhook/route.ts`
    - Implement the `POST` handler pipeline: capture the raw request bytes → HMAC-verify the `X-Hub-Signature-256` header over those exact bytes (when an app secret is configured) → acknowledge fast with 200 → dedupe by inbound message id → parse to `NormalizedInbound` → route via `routeInbound(buildRouterPorts())` → reply with a template; screen inbound text through the `Safety_Guard` before any Qwen prompt, create WhatsApp-originated Cases with `intakeType: "whatsapp_patient_note"`, and write channel-originated domain actions to the same `Trace_Step`/`Audit_Chain` entries the in-app flow uses
    - _Requirements: 31.3, 31.4, 31.5, 31.6, 31.7, 36.2, 36.3, 1.10, 1.11_

  - [ ] 26.16 Record channel messages in the WhatsApp channel audit
    - On every inbound and outbound WhatsApp message, persist a `WhatsAppMessage` row capturing direction, sender, role, content (template id / generic text for patient outbound), message type, provider message id, timestamp, and linked Case where applicable
    - _Requirements: 36.1_

  - [ ]* 26.17 Write example test for WhatsApp channel audit recording
    - Assert an inbound and an outbound message each produce a `WhatsAppMessage` row with the correct direction, role, message type, and linked Case
    - _Requirements: 36.1_

  - [ ] 26.18 Implement WhatsApp staff notifications
    - Send staff notification `WhatsApp_Message`s to the registered `Staff_Number` for: a new Case created from a patient message, a Case reaching `AwaitingApproval` (one-line Decision_Intelligence summary + overall Confidence_Score), an approaching SLA_Clock deadline, and a Verification_QA-flagged issue requiring manual review
    - _Requirements: 35.1, 35.2, 35.3, 35.4_

  - [ ]* 26.19 Write example test for staff notifications
    - Assert each of the four notification triggers sends a staff notification with the expected generic content
    - _Requirements: 35.1, 35.2, 35.3, 35.4_

  - [ ] 26.20 Implement the one-off WhatsApp setup automation in `scripts/setup-whatsapp.ts`
    - Provide a conversational one-off setup script that configures the WhatsApp channel (webhook subscription, template registration) using the loaded config; no strict acceptance requirement (setup/ops)

  - [ ]* 26.21 Write optional smoke test for the setup script
    - Assert the setup script runs against fakes without error and is a one-shot (no runtime dependency in the request path)

  - [ ] 26.22 Implement the media quality gate in `lib/whatsapp/mediaGate.ts`
    - Implement `classifyMedia(files)` returning a `MediaQualityResult` per file (`usable`, and when not usable a `reason` of `blurry`/`too_dark`/`cropped`/`not_a_document`/`wrong_document_type`, and when usable the `extractedText`); fail-safe so any thrown error in the check/extraction yields `{ usable: false }` and extraction results are not used; wire the classify → route decision into `router.ts` **before any intake**: usable → route the extracted text through the same intake path as an inbound text message; unusable → reply with corrective guidance specific to the reason and create **no Case**; when multiple media files arrive in one delivery, use the relevant document(s) and disregard clearly unrelated files
    - _Requirements: 41.1, 41.2, 41.3, 41.4, 41.5, 41.6, 32.6_

  - [ ]* 26.23 Write property test for the media quality gate route/block decision
    - **Property 79: Media quality gate routes usable files and blocks unusable ones**
    - Assert usable → extracted text routed through the text-intake path; unusable → no Case + reason-specific corrective reply; any check/extraction error treated as not usable (fail-safe) so extraction results are never used on error
    - **Validates: Requirements 41.1, 41.3, 41.4, 41.5**

  - [ ]* 26.24 Write integration/example test for media text extraction correctness
    - Extract text from a sample clear image/PDF and assert non-empty extracted text is produced for a usable file; OCR/PDF extraction is I/O- and library-bound, so its correctness is covered by an integration/example test rather than a property test
    - _Requirements: 41.4_

  - [ ] 26.25 Implement the emergency short-circuit in `lib/whatsapp/emergency.ts`
    - Implement the deterministic, **non-LLM** `detectEmergency(text)` matching a fixed set of emergency-language patterns (chest pain, difficulty breathing, severe bleeding, stroke, overdose, suicidal statements) with plain string/regex rules; wire it **FIRST** in the patient path in `router.ts` so on a match AuthPilot replies with the emergency-care template directing the patient to call 911 / go to the ER, raises an **urgent** `Handoff_Request` (task 26.27), and short-circuits — no Case is created or mutated and no later rule runs
    - _Requirements: 42.1, 42.2, 42.3, 42.4, 43.2_

  - [ ]* 26.26 Write property test for the emergency short-circuit
    - **Property 77: Emergency language short-circuits deterministically**
    - Assert `detectEmergency` is deterministic with no model call, and for any text it flags as emergency the router replies with the emergency template, records an urgent `Handoff_Request`, and creates/mutates no Case
    - **Validates: Requirements 42.1, 42.2, 42.3, 42.4, 43.2**

  - [ ] 26.27 Implement human handoff in `lib/whatsapp/handoff.ts`
    - Implement `recordHandoff(req)` persisting a `HandoffRequest` row (patient phone, optional linked Case, reason, urgent flag) and broadcasting a staff notification identifying the handoff, flagged **urgent** when `req.urgent` is set; wire the router so an explicit patient request for a human raises a **non-urgent** handoff and an emergency (task 26.25) raises an **urgent** one
    - _Requirements: 43.1, 43.2, 43.3, 43.4_

  - [ ]* 26.28 Write example test for handoff staff notification
    - Assert an explicit patient human-request records a non-urgent `HandoffRequest` and a staff notification, and an emergency-driven handoff records an urgent `HandoffRequest` whose staff notification is flagged urgent
    - _Requirements: 43.3, 43.4_

  - [ ] 26.29 Implement the conversational fallback in `lib/whatsapp/fallback.ts`
    - Implement `conversationalFallback(input)` producing a scoped reply under a role-specific system prompt: patient scope MAY explain general concepts/process/timelines, acknowledge frustration, and ask a clarifying question, and MUST NOT state any specific denial reason/diagnosis/procedure code/dollar amount/policy detail, MUST NOT give medical advice (redirect medical questions to the patient's physician), and MUST NOT promise an outcome; staff scope MAY explain a Case's decision reasoning/status/thresholds, and MUST NOT perform any case action from free text or guess a case id; wire it in `router.ts` as the **last resort** for any inbound that matches neither a structured staff command, a clear new-case trigger, nor a status query
    - _Requirements: 44.1, 44.2, 44.3, 44.4, 44.5, 44.6, 44.7, 32.7, 34.10_

  - [ ]* 26.30 Write example/smoke tests for fallback wording and scope constraints
    - Assert patient-scope replies stay PHI-free (no denial reason/diagnosis/code/amount/policy detail), never give medical advice or promise an outcome, and staff-scope replies never perform an action or guess a case id; the model-generated wording is validated by example/smoke tests rather than a property test
    - _Requirements: 44.2, 44.3, 44.4, 44.5, 44.6, 44.7_

  - [ ]* 26.31 Write deterministic test that routing into the fallback happens
    - Assert that inbound messages which are non-command (staff), non-trigger, and non-status are routed into `conversationalFallback` under the correct role scope; the routing decision is deterministic and testable even though the reply wording is not
    - _Requirements: 44.1, 32.7, 34.10_

  - [ ] 26.32 Implement the staff free-text action guardrail in `lib/whatsapp/router.ts`
    - When a staff message expresses an intent to act (e.g. "approve this", "please send it", "reject that one") **without** an exact structured command with an explicit case id, refuse: take **no case action** (never invoke `performCaseAction`), never guess a case id, and reply asking the staff member to use the structured format `Approve <case-id>` or `Reject <case-id>`; only a well-formed `parseStaffCommand` result with an explicit case id ever reaches `performCaseAction`
    - _Requirements: 45.1, 45.2, 45.3, 34.9, 44.7_

  - [ ]* 26.33 Write property test for the staff free-text action guardrail
    - **Property 78: Staff free-text action intent is refused without a structured command**
    - Assert that for any staff free-text action intent without an exact structured command/explicit case id, `performCaseAction` is never invoked, no Case changes, no case id is guessed, and the reply requests the `Approve <case-id>` / `Reject <case-id>` format
    - **Validates: Requirements 45.1, 45.2, 45.3, 34.9, 44.7**

  - [ ] 26.34 Implement unsupported-type and ambiguous-reply handling in `lib/whatsapp/router.ts`
    - Unsupported inbound type (audio, video, location, sticker, contacts, or an otherwise unrecognized `kind: "unsupported"`) → reply asking the sender to resend as text, a photo, or a PDF, creating **no Case** and mutating no existing Case; ambiguous short patient reply with no clear referent and no open-Case context → reply with a clarifying question and create **no** new Case; both are terminal replies that never touch case state
    - _Requirements: 46.1, 46.2, 47.1, 47.2_

  - [ ]* 26.35 Write example tests for unsupported-type and ambiguous-reply handling
    - Assert an unsupported-type inbound gets the resend-as-text/photo/PDF reply and creates/mutates no Case, and an ambiguous short patient reply with no open-Case context gets a clarifying question and creates no Case
    - _Requirements: 46.1, 46.2, 47.1, 47.2_

- [ ] 27. Implement voice transcript intake
  - [ ] 27.1 Implement `transcriptToIntake` in `lib/voice/transcriptIntake.ts` and wire a transcript entrypoint
    - Implement the pure `transcriptToIntake(t)` mapping a `Voice_Transcript` to `{ rawText, intakeType: "phone_note" }`, and wire a transcript intake entrypoint that feeds the result through the same create-Case path as any other `phone_note` intake and runs the normal nine-stage pipeline; no real-time media or telephony processing is introduced
    - _Requirements: 37.1, 37.2_

  - [ ]* 27.2 Write example/smoke test for transcript intake
    - Assert a submitted transcript becomes a `phone_note` intake that runs the normal pipeline and that no telephony / real-time-media module is required (37.2 is smoke-tested, not a numbered property)
    - _Requirements: 37.1, 37.2_

- [ ] 28. Wire CI, deployment, and configuration operations
  - [ ] 28.1 Wire CI, deploy config, portability, and boot-time config validation
    - Configure CI to run typecheck, lint, tests (including the fast-check property tests) and the gold-eval, and the build; add Vercel deploy configuration; provide an optional Postgres `docker-compose` plus the documented single provider + `DATABASE_URL` switch (no logic change); add `.env.example` enumerating the required and WhatsApp configuration keys; invoke `loadConfig` at boot so configuration is validated fail-fast
    - _Requirements: 38.1, 38.2, 38.3, 38.4, 39.1, 39.2_

  - [ ]* 28.2 Write smoke/setup checks for CI and boot configuration
    - Assert the CI pipeline runs typecheck/lint/test/gold-eval/build and that boot fails fast on missing/invalid configuration; ops/config behaviors are covered by smoke/setup tests (no new numbered properties beyond 73/74)
    - _Requirements: 38.1, 38.2, 39.1, 39.2_

- [ ] 29. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific granular requirements for traceability, and every one of the 79 correctness properties maps to exactly one property-based test sub-task.
- Property-based tests use fast-check with Vitest at ≥100 iterations, tagged `// Feature: authpilot, Property {number}: {property_text}`; Qwen and the NIH API are replaced with deterministic fakes and the database uses an in-memory/temporary SQLite instance. Stage parallelism (Property 37) is validated with instrumented per-stage start/end timestamps rather than wall-clock timing. Qwen degradation on a structured failure (Requirement 6.9) is covered by an example test that feeds a `QwenFailure` into the runner and asserts Escalate_To_Human / NeedsHumanInput.
- Architectural/wiring guarantees (Requirements 5.2, 7.2, 17.3, 20.3, 20.11, 20.12) and UI stage labeling / flagged-issue rendering (Requirements 11.5, 20.7–20.10, 22.6) are covered by smoke/example/component tests rather than property tests, consistent with the design's testing strategy.
- Data-store portability (Requirement 39), voice transcript intake (Requirement 37), the WhatsApp channel audit (Requirement 36.1) and staff notifications (Requirement 35), the one-off WhatsApp setup script, and the CI/deploy/boot-config operations are covered by smoke/example/setup tests rather than property tests, since they carry no numbered correctness property beyond config Properties 73 and 74.
- The shared case action `performCaseAction` (`lib/caseActions.ts`) is the single implementation of approve/reject/edit/request_more_evidence and the sole writer of the `human_action` Trace_Step; both the Dashboard action route (task 15.1) and the WhatsApp staff-command handler (task 26.11) delegate to it, so the two channels can never drift or double-log. Properties 75 and 76 cover its per-action dispatch and its no-throw contract.
- The advanced WhatsApp behaviors add Properties 77 (emergency short-circuit), 78 (staff free-text action guardrail), and 79 (media quality gate route/block). Emergency detection (Requirement 42.4) and the media route/block decision are deterministic and property-tested; media text extraction (OCR/PDF) is library-bound and covered by an integration/example test; the conversational fallback wording (Requirement 44) is model-generated and covered by example/smoke tests, while the deterministic routing decision *into* the fallback is separately tested; the handoff notification (Requirement 43) and the unsupported-type/ambiguous-reply replies (Requirements 46, 47) are covered by example tests, since they carry no numbered property.
- UI, library-bound (PDF/text extraction), and one-shot setup behaviors are covered by component, integration, and smoke tests rather than property tests.
- Checkpoints ensure incremental validation at natural boundaries (pure logic, tools/PDF, the nine-stage runner, APIs, and final).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "25.1"] },
    { "id": 2, "tasks": ["2.2", "2.4", "3.1", "3.3", "4.1", "6.1", "7.1", "7.5", "8.1", "14.1", "14.3", "14.5", "14.8", "26.1", "26.5", "26.7", "26.9"] },
    { "id": 3, "tasks": ["2.3", "2.5", "3.2", "3.4", "4.2", "4.3", "6.2", "6.3", "7.2", "7.3", "7.4", "7.6", "8.2", "8.3", "10.1", "10.5", "10.9", "14.2", "14.4", "14.6", "14.7", "14.9", "14.10", "14.11", "14.12", "25.2", "25.3", "26.2", "26.3", "26.6", "26.8", "26.10"] },
    { "id": 4, "tasks": ["7.7", "10.2", "10.3", "10.4", "10.6", "10.7", "10.8", "10.10", "26.4"] },
    { "id": 5, "tasks": ["7.8", "7.9", "11.3", "23.1", "23.3", "23.5", "23.9"] },
    { "id": 6, "tasks": ["11.1", "11.4", "23.2", "23.4", "23.6", "23.7", "23.8", "23.10", "26.11"] },
    { "id": 7, "tasks": ["11.2", "11.5", "13.1", "26.12", "26.13", "15.10"] },
    { "id": 8, "tasks": ["11.6", "11.7", "11.32", "13.2", "13.3", "13.4", "15.11", "15.12", "26.22"] },
    { "id": 9, "tasks": ["11.8", "11.9", "26.23", "26.24", "26.25"] },
    { "id": 10, "tasks": ["11.10", "11.11", "11.12", "11.13", "26.26", "26.27"] },
    { "id": 11, "tasks": ["11.14", "11.15", "26.28", "26.29"] },
    { "id": 12, "tasks": ["11.16", "11.17", "11.18", "26.30", "26.31", "26.32"] },
    { "id": 13, "tasks": ["11.19", "11.20", "11.21", "11.22", "11.23", "11.33", "26.33", "26.34"] },
    { "id": 14, "tasks": ["11.24", "11.25", "15.1", "26.35"] },
    { "id": 15, "tasks": ["11.26", "11.27", "11.28", "11.29", "11.30", "11.31", "15.2", "15.3", "15.4", "15.5", "15.6", "15.7", "15.8", "15.9"] },
    { "id": 16, "tasks": ["17.1", "18.1", "19.1", "20.1", "21.1", "22.1", "24.1"] },
    { "id": 17, "tasks": ["17.2", "18.2", "19.2", "20.2", "21.2", "22.2", "24.2"] },
    { "id": 18, "tasks": ["26.14", "26.16", "26.18", "27.1", "28.1"] },
    { "id": 19, "tasks": ["26.15", "26.20"] },
    { "id": 20, "tasks": ["26.17", "26.19", "26.21", "27.2", "28.2"] }
  ]
}
```
