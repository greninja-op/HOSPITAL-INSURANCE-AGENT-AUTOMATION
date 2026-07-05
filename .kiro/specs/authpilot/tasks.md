# Implementation Plan: AuthPilot

## Overview

This plan builds AuthPilot as a single Next.js 14 (App Router) + TypeScript repository backed by SQLite via Prisma. Work proceeds bottom-up: project scaffolding and data layer first, then the pure/near-pure logic modules (Decision_Engine, SLA_Clock) that carry most of the correctness properties, then the Qwen client and agent tools, then the bounded Agent_Runner, then the API routes, and finally the frontend pages and seed/demo data. Each step builds on the previous one and ends by wiring the new code into the running app. Property-based tests (fast-check, Vitest, ≥100 iterations) sit next to the logic they validate; example, integration, and smoke tests cover UI, library-bound, and one-shot setup behavior.

## Tasks

- [ ] 1. Scaffold project and shared foundations
  - Initialize a Next.js 14 (App Router) + TypeScript project with Tailwind, shadcn/ui, Recharts, and Framer Motion
  - Add Vitest and fast-check; configure a test script and a shared fast-check config (`{ numRuns: 100 }`)
  - Create the `lib/` directory and define shared TypeScript types/enums: `CaseStatus`, `ResolutionPath`, `intakeType`, `sourceType`, `stepType`, `Recommendation`, `AppealContent`
  - _Requirements: 5.6, 5.7, 5.8_

- [ ] 2. Define the data layer with Prisma
  - [ ] 2.1 Author the Prisma schema and generate the client
    - Define `Patient`, `ChartNote`, `Payer`, `PayerPolicy`, `Case`, `ExtractedField`, `TraceStep` models per the design, including `Case.isUrgent`, `resolutionPath`, `denialReason`, `requestedEvidence`, `plainEnglishExplanation`, `recommendation`, `appealPdfUrl`, `resolvedAt`
    - Configure SQLite datasource and add a shared Prisma client module in `lib/db.ts`
    - Add a test helper that spins up an in-memory/temporary SQLite instance for tests
    - _Requirements: 2.2, 9.1, 9.2_

- [ ] 3. Implement the Decision_Engine (pure logic)
  - [ ] 3.1 Implement `decide()` in `lib/decisionEngine.ts`
    - Evaluate rules in order: iterations-exhausted OR contradictionCount > 0 → Escalate_To_Human (NeedsHumanInput); confidence > 85 → Auto_Draft (AwaitingApproval); 60 ≤ confidence ≤ 85 → Draft_And_Request_Evidence (AwaitingApproval); confidence < 60 → Escalate_To_Human (NeedsHumanInput)
    - Return `{ path, status }` with status derived from path
    - _Requirements: 4.4, 5.2, 5.3, 5.4, 5.6, 5.7, 5.8_

  - [ ]* 3.2 Write property test for the Decision_Engine mapping
    - **Property 14: Decision engine mapping**
    - **Validates: Requirements 4.4, 5.2, 5.3, 5.4, 5.6, 5.7, 5.8**
    - Use the decision-input generator with emphasis on the 60 and 85 boundaries

  - [ ] 3.3 Implement `computeOverallConfidence()` in `lib/decisionEngine.ts`
    - Aggregate extracted-field confidences into an overall score clamped to [0, 100]
    - _Requirements: 5.1_

  - [ ]* 3.4 Write property test for overall confidence range
    - **Property 15: Overall confidence stays in range**
    - **Validates: Requirements 5.1**

- [ ] 4. Implement the SLA_Clock (pure logic)
  - [ ] 4.1 Implement `slaDeadline()`, `remainingMs()`, and `isAtRisk()` in `lib/sla.ts`
    - `slaDeadline`: +7 days standard, +72 hours urgent; `remainingMs`: deadline minus now (may be negative); `isAtRisk`: remaining < 24h including overdue
    - _Requirements: 12.1, 12.2, 12.3_

  - [ ]* 4.2 Write property test for SLA deadline computation
    - **Property 30: SLA deadline computation**
    - **Validates: Requirements 12.1, 12.2**

  - [ ]* 4.3 Write property test for the at-risk boundary
    - **Property 31: At-risk boundary**
    - **Validates: Requirements 12.3**

- [ ] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement the Qwen_Client
  - [ ] 6.1 Implement `callQwen()` with retry in `lib/qwen.ts`
    - Typed wrapper over the DashScope/OpenRouter chat-completions endpoint with `tools` (function-calling) support; parse `toolCalls`/`content`; read `QWEN_API_KEY`/`QWEN_API_BASE`
    - Retry transient failures up to 2 additional times (3 attempts total); throw `QwenUnavailableError` after the third failure
    - _Requirements: 6.5_

  - [ ]* 6.2 Write property test for the retry bound
    - **Property 18: Qwen client retry bound**
    - **Validates: Requirements 6.5**
    - Use a deterministic fake that fails a configurable number of consecutive times

- [ ] 7. Implement the Agent_Tools
  - [ ] 7.1 Implement Prisma-backed tools in `lib/agentTools.ts`
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

- [ ] 8. Implement the appeal PDF generator
  - [ ] 8.1 Implement `generateAppealPdf()` in `lib/appealPdf.ts`
    - Use pdf-lib to render an appeal citing the denial reason, referenced Payer_Policy clause, and supporting Chart_Note evidence; persist the file and return `{ url }`
    - _Requirements: 7.2, 7.3_

  - [ ]* 8.2 Write property test for appeal citation completeness
    - **Property 20: Appeal packet cites required evidence**
    - **Validates: Requirements 7.2**

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

- [ ] 11. Implement the Agent_Runner (bounded loop)
  - [ ] 11.1 Implement `runAgent()` loop and orchestration in `lib/agentRunner.ts`
    - Set status Investigating; build system prompt + seed messages (raw intake plus `extraContext` on re-runs); loop up to 8 iterations calling Qwen, dispatching tools, and persisting Trace_Steps + Extracted_Fields each iteration before the next call; break on final decision
    - On loop exhaustion without a decision, force Escalate_To_Human and record a Trace_Step with reasoning "needs manual review"; catch `QwenUnavailableError` and escalate
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ]* 11.2 Write property test for the loop cap forcing escalation
    - **Property 17: Loop cap forces escalation**
    - **Validates: Requirements 6.4**

  - [ ] 11.3 Wire decision, tracing, PDF, and status side-effects into the runner
    - Call `decide()`, persist a `decision` Trace_Step (overall confidence, path, reasoning); on Auto_Draft / Draft_And_Request_Evidence generate the appeal PDF, store `appealPdfUrl`, set AwaitingApproval (recording requested evidence for the medium path); on Escalate_To_Human set NeedsHumanInput
    - _Requirements: 5.5, 5.6, 5.7, 5.8, 7.1_

  - [ ]* 11.4 Write property test for decision tracing
    - **Property 16: Decisions are traced**
    - **Validates: Requirements 5.5**

  - [ ]* 11.5 Write property test for conditional appeal generation
    - **Property 19: Appeal PDF generated only on drafting paths**
    - **Validates: Requirements 7.1**

  - [ ]* 11.6 Write property test for appeal location storage
    - **Property 21: Appeal location is stored**
    - **Validates: Requirements 7.3**

  - [ ] 11.7 Produce the plain-English explanation and store the recommendation
    - Generate a non-empty plain-English explanation of the denial reason and next steps; store the recommendation JSON and explanation on the Case
    - _Requirements: 15.1_

  - [ ]* 11.8 Write property test for plain-English explanation production
    - **Property 33: Plain-English explanation is always produced**
    - **Validates: Requirements 15.1**

- [ ] 12. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. Implement intake and case creation API
  - [ ] 13.1 Implement `POST /api/cases` with zod validation and async kickoff
    - Validate intake (reject empty/whitespace text with no file and missing/invalid intake type with a field-identifying 400); on PDF upload extract text via pdf-lib and store as raw intake; create Case status New with SLA deadline; kick off `runAgent` async and return the caseId immediately
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 12.1_

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
    - Merge Extracted_Field and Trace_Step records chronologically (non-decreasing by timestamp, lossless); generate an audit-trail PDF for export
    - _Requirements: 9.3, 9.4_

  - [ ]* 14.6 Write property test for chronological, lossless audit merge
    - **Property 27: Audit trail is chronological and lossless**
    - **Validates: Requirements 9.3**

  - [ ]* 14.7 Write integration test for audit PDF export
    - Generate an audit PDF for a case and assert it contains the full trail
    - _Requirements: 9.4_

  - [ ] 14.8 Implement `GET /api/analytics`, `GET /api/policies/compare`, and `GET /api/patients/search`
    - Denials-by-payer aggregation, resolution rate, average time-to-resolution, at-risk list; per-payer policy retrieval and diff explanation for a procedure code; patient-name search
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 17.1, 17.2, 19.2_

  - [ ]* 14.9 Write property test for denials-by-payer aggregation
    - **Property 32: Denials-by-payer aggregation is exact**
    - **Validates: Requirements 14.1**

  - [ ]* 14.10 Write property test for policy comparison retrieval
    - **Property 34: Policy comparison retrieves per-payer criteria**
    - **Validates: Requirements 17.1**

  - [ ]* 14.11 Write property test for global search filtering
    - **Property 35: Global search filters by patient name**
    - **Validates: Requirements 19.2**

- [ ] 15. Implement the human-action API
  - [ ] 15.1 Implement `POST /api/cases/[id]/action`
    - Handle Approve (→ AppealSent, simulated send only), Reject (→ NeedsHumanInput), Edit (store revised content), Request More Evidence (append context, re-invoke `runAgent`); record a `human_action` Trace_Step for each; never mark sent without a recorded Approve; 400 on malformed payloads
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 16.1, 16.2_

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
    - Textarea + file upload + intake-type select; POST `/api/cases`; redirect to the Case Detail page on the returned caseId
    - _Requirements: 1.6, 10.4_

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
    - `CaseFactsPanel` (extracted fields with confidence chips and expandable source tags); `LiveTracePanel` polling `/trace` every 1s while Investigating with Framer Motion entrance; `HumanActionZone` (recommendation + Approve/Edit/Request More Evidence/Reject + appeal PDF preview/download + plain-English explanation) wired to `/action`
    - _Requirements: 8.1, 11.1, 11.2, 11.4, 13.1, 13.2, 13.3, 13.4, 15.2_

  - [ ]* 20.2 Write component tests for panels, polling, and source expansion
    - Assert fact/source-tag expansion, 1s trace polling and chronological append, action buttons in AwaitingApproval, appeal preview/download when present, and plain-English display
    - _Requirements: 11.1, 11.2, 11.4, 13.2, 13.4, 15.2_

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

- [ ] 23. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific granular requirements for traceability, and every one of the 35 correctness properties maps to exactly one property-based test sub-task.
- Property-based tests use fast-check with Vitest at ≥100 iterations, tagged `// Feature: authpilot, Property {number}: {property_text}`; Qwen and the NIH API are replaced with deterministic fakes and the database uses an in-memory/temporary SQLite instance.
- UI, library-bound (PDF/text extraction), and one-shot setup behaviors are covered by component, integration, and smoke tests rather than property tests, consistent with the design's testing strategy.
- Checkpoints ensure incremental validation at natural boundaries (pure logic, tools/PDF, runner, APIs, and final).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["3.1", "3.3", "4.1", "6.1", "7.1", "7.5", "8.1"] },
    { "id": 3, "tasks": ["3.2", "3.4", "4.2", "4.3", "6.2", "7.2", "7.3", "7.4", "7.6", "8.2", "8.3", "10.1", "10.5"] },
    { "id": 4, "tasks": ["7.7", "10.2", "10.3", "10.4", "10.6", "10.7", "10.8"] },
    { "id": 5, "tasks": ["7.8", "7.9", "11.1"] },
    { "id": 6, "tasks": ["11.2", "11.3"] },
    { "id": 7, "tasks": ["11.4", "11.5", "11.6", "11.7"] },
    { "id": 8, "tasks": ["11.8", "13.1", "14.1", "14.3", "14.5", "14.8", "15.1"] },
    { "id": 9, "tasks": ["13.2", "13.3", "13.4", "14.2", "14.4", "14.6", "14.7", "14.9", "14.10", "14.11", "15.2", "15.3", "15.4", "15.5", "15.6"] },
    { "id": 10, "tasks": ["17.1", "18.1", "19.1", "20.1", "21.1", "22.1"] },
    { "id": 11, "tasks": ["17.2", "18.2", "19.2", "20.2", "21.2", "22.2"] }
  ]
}
```
