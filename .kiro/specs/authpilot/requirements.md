# Requirements Document

## Introduction

AuthPilot is a Qwen-powered autonomous agent that helps front-office/billing staff and physicians at small-to-mid-size medical practices handle insurance prior authorizations and claim denials. AuthPilot ingests a messy trigger (a denial letter, a referral/prior-auth request, or a patient phone note), resolves the entities involved (patient, payer, procedure and diagnosis codes, denial reason), investigates the patient chart and payer medical-necessity policy through tool use, detects contradictions and gaps, computes a confidence-scored decision (auto-draft, draft-and-request-evidence, or escalate to human), generates an evidence-cited appeal packet PDF, verifies the drafted appeal for accuracy before it reaches a human, routes every outbound action through human approval, and tracks each case to resolution against CMS 2026 SLA deadlines — all with a complete, visual audit trail.

AuthPilot's agent runtime is organized as an ordered multi-stage pipeline rather than a single flat loop. The stages are: (1) Intake & Extraction, (2) Medical Review and (3) Policy Review running in parallel with restricted tool scopes, (4) Strategy, (5) Decision Intelligence, (6) Appeal Generation, (7) Verification/QA, (8) Human Approval, and (9) Submission & Tracking. Each stage records its own labeled trace steps so the live trace panel can show which stage produced each reasoning line. The Strategy stage estimates win-probability across candidate approaches from seeded case history and payer-specific track record; the Verification/QA stage independently checks the generated appeal for hallucinated citations and incorrect references before human review.

This document defines the requirements for the full application: a Next.js 14 (App Router) + TypeScript web app with Tailwind, shadcn/ui, Recharts, and Framer Motion on the frontend; Next.js API routes with a custom TypeScript agent loop on the backend; SQLite via Prisma for persistence; Qwen via DashScope/OpenRouter for reasoning and tool use; and pdf-lib for document generation. All external systems (EHR, payer policy, claims) are mocked with locally seeded data.

## Glossary

- **AuthPilot**: The overall system, comprising the web application, API layer, agent runtime, and database.
- **Agent_Runner**: The custom TypeScript agent runtime that executes the ordered multi-stage pipeline by calling Qwen and the agent tools; within each stage it runs a plan → tool_call → observe → decide → act cycle.
- **Pipeline_Stage**: One named stage of the Agent_Runner pipeline: Intake_And_Extraction, Medical_Review, Policy_Review, Strategy, Decision_Intelligence, Appeal_Generation, Verification_QA, Human_Approval, or Submission_And_Tracking.
- **Medical_Review**: The pipeline stage that assesses clinical medical necessity using only Chart_Note data.
- **Policy_Review**: The pipeline stage that assesses payer medical-necessity criteria using only Payer_Policy data.
- **Strategy**: The pipeline stage that computes win-probability across candidate appeal approaches from seeded case history and payer-specific track record, and serves multi-payer policy diffing as an input.
- **Decision_Intelligence**: The pipeline stage housing the Decision_Engine, consuming the Medical_Review, Policy_Review, and Strategy summaries.
- **Verification_QA**: The pipeline stage that independently checks the generated Appeal_Packet for hallucinated citations, incorrect patient/policy/code references, and unsupported claims before human review.
- **Strategy_Options**: The candidate appeal approaches with their estimated win-probabilities produced by the Strategy stage, stored on the Case.
- **Verification_Result**: The outcome of the Verification_QA stage, comprising a pass/fail status and a list of flagged issues, stored on the Case.
- **Qwen_Client**: The typed wrapper around the DashScope/OpenRouter chat-completions endpoint that supports function calling and retry logic.
- **Case**: A single unit of work created from one intake, tracked from creation through resolution, holding intake text, status, extracted fields, trace steps, recommendation, and SLA deadline.
- **Intake**: The raw trigger text/document submitted to start a Case, of type Denial Letter, New PA Request, or Patient Phone Note.
- **Extracted_Field**: A structured fact the agent derived (e.g., patient, payer, procedure code, denial reason), stored with value, confidence, source type, reasoning, and timestamp.
- **Trace_Step**: A single recorded agent activity with reasoning and timestamp, used to render the live agent trace and audit trail. Its step type is one of "tool_call", "decision", "human_action", "medical_review", "policy_review", "strategy", or "verification".
- **Agent_Tool**: A callable TypeScript function backed by a Prisma query or external API that the agent invokes: fetch patient record, fetch payer policy, look up diagnosis code, check prior auth history, generate appeal PDF.
- **Payer_Policy**: A seeded LCD-style medical-necessity criteria record for a payer and procedure code.
- **Chart_Note**: A seeded patient EHR note with a date, content, and diagnosis code, deliberately including messy or contradictory data.
- **Confidence_Score**: A numeric value from 0 to 100 (percent) the agent assigns to an extracted fact or to its overall resolution decision.
- **Decision_Engine**: The logic within the Agent_Runner that maps overall confidence and policy-match state to a resolution path.
- **Resolution_Path**: One of three outcomes: Auto_Draft (high confidence), Draft_And_Request_Evidence (medium confidence), or Escalate_To_Human (low confidence or policy contradiction).
- **Appeal_Packet**: The generated PDF appeal letter citing the denial reason, payer policy clause, and supporting chart evidence.
- **Human_Action**: An operator decision on a recommendation: Approve, Edit, Request More Evidence, or Reject.
- **Case_Outcome**: An Operator's terminal decision on a Case in status "AppealSent": Appeal Won (transitions the Case to "Resolved") or Appeal Denied (transitions the Case to "DeniedFinal").
- **Case_Status**: One of New, Investigating, NeedsHumanInput, AwaitingApproval, AppealSent, Resolved, DeniedFinal.
- **SLA_Clock**: The per-Case countdown to the CMS 2026 deadline (7 days standard, 72 hours urgent).
- **Audit_Trail**: The complete chronological record of a Case merging extracted fields, trace steps, and human actions.
- **Dashboard**: The Kanban home page (`/`) grouping cases by status with an analytics widget.
- **Analytics_Page**: The `/analytics` page presenting denial-intelligence charts.
- **Operator**: A front-office/billing staff member or physician who uses AuthPilot.
- **Case payer reference**: The payer stored directly on a Case (Case.payerId and the convenience field Case.payerName), set during the Intake_And_Extraction stage when the payer is resolved, used as the grouping key for denials-by-payer analytics independently of any linked Patient.
- **Audit_Chain**: The tamper-evident sequence of audit events (Trace_Step and Human_Action records) for a Case in which each event stores the hash of the immediately preceding event (prevHash) and its own hash (hash) computed over a Canonical_Serialization of the event content, forming a linked chain that starts from the fixed Genesis_Hash.
- **Genesis_Hash**: The fixed, well-known starting hash value used as the prevHash of the first audit event in a Case Audit_Chain.
- **Canonical_Serialization**: The deterministic, order-stable textual representation of an audit event content used as the input to hash computation, so that identical content always produces the same hash.
- **Idempotency_Key**: A client-supplied identifier accompanying a mutating operation that allows the AuthPilot to recognize a retried operation and apply the operation effect at most once.
- **Safety_Guard**: The deterministic, non-LLM screening component that fences untrusted Intake text or extracted document text as data and detects prompt-injection or instruction-override patterns before the content is included in a Qwen_Client prompt.
- **Finding**: A structured contradiction, gap, policy, or verification issue that carries a stable finding identifier, a Finding_Severity, the expected and actual values where applicable, a technical message, and a patient/operator-friendly message.
- **Finding_Severity**: The severity of a Finding, one of "warning" or "blocking".
- **Status_Transition**: An ordered pair of Case_Status values (from-status, to-status) representing a requested change to a Case Case_Status, evaluated against the allowed-transition set.
- **Gold_Case**: A stored evaluation case with a fixed Intake and expected outcomes — the expected Resolution_Path and the expected triggering Finding identifier(s) — used to detect decision-logic regressions.
- **WhatsApp_Channel**: AuthPilot's messaging channel through which patients submit intakes and receive generic status updates, and through which registered staff members receive notifications and issue actions, carrying only triggers, generic (PHI-free) status, and staff approvals.
- **WhatsApp_Message**: A single inbound or outbound message on the WhatsApp_Channel, recorded with its direction, sender, role, content, message type, timestamp, and linked Case where applicable.
- **Staff_Number**: A phone number registered with AuthPilot as belonging to an authorized staff member, used to authorize staff actions and address staff notifications on the WhatsApp_Channel.
- **Patient_Template**: A pre-approved, generic, PHI-free message template used for all outbound patient-facing messages on the WhatsApp_Channel.
- **Voice_Transcript**: The text transcript of a phone call submitted to AuthPilot as the source of a "phone_note" Intake, without any real-time media or telephony processing.
- **App_Configuration**: The set of configuration keys required to run AuthPilot, including the datasource provider and connection URL and the WhatsApp_Channel keys, validated at startup.
- **PHI**: Protected health information — patient-identifying or case-specific medical detail that remains within the AuthPilot application and generated PDFs and is never carried on the WhatsApp_Channel.
- **Shared_Case_Action**: The single shared case-action operation `performCaseAction(caseId, actionType, meta)`, where actionType is one of approve, reject, edit, or request_more_evidence, and meta carries the invoking source ("dashboard" or "whatsapp") and the acting actor. Shared_Case_Action is the one implementation invoked by both the Dashboard action route and the WhatsApp staff-command handler, and is the sole writer of "human_action" Trace_Steps for these transitions.
- **Media_Quality_Result**: The outcome of the pre-extraction quality/type check applied to an inbound WhatsApp image or PDF, comprising a usable flag and, when not usable, a reason of one of "blurry", "too_dark", "cropped", "not_a_document", or "wrong_document_type", together with any extracted text when usable.
- **Emergency_Language**: Inbound patient text that matches AuthPilot's deterministic emergency-language patterns (for example chest pain, difficulty breathing, severe bleeding, stroke, overdose, or suicidal statements), detected without any language-model call.
- **Handoff_Request**: A recorded request for a staff member to contact a patient directly, carrying the patient phone number, an optional linked Case, a reason, and an urgent flag.
- **Conversational_Fallback**: The scoped conversational assistant that handles inbound WhatsApp messages that do not match a structured staff command, a clear new-case trigger, or a status query, operating under role-specific (patient or staff) content constraints.

## Requirements

### Requirement 1: Intake Ingestion

**User Story:** As a billing staff member, I want to submit a messy denial letter, referral request, or patient phone note, so that AuthPilot can start working the case for me.

#### Acceptance Criteria

1. WHEN an Operator submits Intake text with a selected intake type of "denial_letter", "new_pa_request", "phone_note", or "whatsapp_patient_note", THE AuthPilot SHALL create a new Case with status "New" and store the raw Intake text.
2. WHEN an Operator uploads a PDF denial letter, THE AuthPilot SHALL extract the text content from the PDF and store it as the Case raw Intake text.
3. IF an Operator submits an Intake with empty text and no uploaded file, THEN THE AuthPilot SHALL reject the submission and return a validation message identifying the missing intake content.
4. IF an Operator submits an Intake without selecting an intake type, THEN THE AuthPilot SHALL reject the submission and return a validation message identifying the missing intake type.
5. WHEN a Case is created from an Intake, THE AuthPilot SHALL return the Case identifier to the Operator immediately without waiting for the agent run to complete.
6. WHEN a Case is created from an Intake, THE AuthPilot SHALL redirect the Operator to the Case Detail page for that Case identifier.
7. THE AuthPilot SHALL provide, on the Intake page and on the create-Case API endpoint, an urgent flag that defaults to not urgent.
8. WHEN an Operator submits an Intake with the urgent flag set, THE AuthPilot SHALL set Case.isUrgent to true and set the SLA_Clock deadline to 72 hours from Case creation.
9. WHEN an Operator submits an Intake with the urgent flag not set, THE AuthPilot SHALL set Case.isUrgent to false and set the SLA_Clock deadline to 7 days from Case creation.
10. WHERE an Intake originates from the WhatsApp_Channel, THE AuthPilot SHALL create the Case with intake type "whatsapp_patient_note" and store the inbound WhatsApp text (or the text extracted from an inbound WhatsApp document) as the raw Intake text.
11. WHEN inbound WhatsApp text or extracted WhatsApp document content is to be incorporated into any prompt to the Qwen_Client, THE AuthPilot SHALL first screen that content with the Safety_Guard consistent with Requirement 27 before the content enters any prompt.

### Requirement 2: Entity Resolution

**User Story:** As a billing staff member, I want AuthPilot to identify the patient, payer, codes, and denial reason from unstructured text, so that I do not have to re-type case details.

#### Acceptance Criteria

1. WHEN the Agent_Runner processes a Case Intake, THE Agent_Runner SHALL extract the patient, payer, procedure code, diagnosis code, and denial reason as Extracted_Field records.
2. WHEN the Agent_Runner creates an Extracted_Field, THE Agent_Runner SHALL store the field name, extracted value, Confidence_Score, source type, reasoning, and timestamp.
3. WHERE an entity value cannot be determined from available sources, THE Agent_Runner SHALL record the Extracted_Field with a value of "unknown" and a Confidence_Score of 0.
4. WHEN the Agent_Runner extracts an entity value, THE Agent_Runner SHALL set the source type to one of "raw_intake", "chart_note", "payer_policy", or "code_lookup".
5. WHEN the Intake_And_Extraction stage resolves the extracted patient to a known Patient record, THE Agent_Runner SHALL set Case.patientId to the identifier of that Patient record.
6. IF the Intake_And_Extraction stage cannot match the extracted patient to a known Patient record, THEN THE Agent_Runner SHALL leave Case.patientId unset and record the patient as an unresolved field consistent with Requirement 20.4.
7. WHEN the Intake_And_Extraction stage resolves the extracted payer to a known Payer, THE Agent_Runner SHALL set the Case payer reference (Case.payerId and Case.payerName) to that Payer.
8. IF the Intake_And_Extraction stage cannot resolve the extracted payer to a known Payer, THEN THE Agent_Runner SHALL leave the Case payer reference unset and record the payer as an unresolved field consistent with Requirement 20.4.

### Requirement 3: Multi-Source Investigation via Tool Use

**User Story:** As a physician, I want AuthPilot to pull the patient chart, payer policy, and code definitions itself, so that its recommendation is grounded in real evidence.

#### Acceptance Criteria

1. WHEN the Agent_Runner needs patient clinical data, THE Agent_Runner SHALL invoke the fetch-patient-record Agent_Tool with a patient identifier and receive the patient record and associated Chart_Notes.
2. WHEN the Agent_Runner needs medical-necessity criteria, THE Agent_Runner SHALL invoke the fetch-payer-policy Agent_Tool with a payer identifier and procedure code and receive the matching Payer_Policy criteria.
3. WHEN the Agent_Runner needs a diagnosis code definition, THE Agent_Runner SHALL invoke the diagnosis-code-lookup Agent_Tool with the code and receive the code definition.
4. WHEN the Agent_Runner needs prior authorization history, THE Agent_Runner SHALL invoke the prior-auth-history Agent_Tool with a patient identifier and receive that patient's past Cases.
5. WHEN the Agent_Runner invokes any Agent_Tool, THE Agent_Runner SHALL record a Trace_Step of type "tool_call" storing the tool name, input, output, reasoning, and timestamp.
6. IF an Agent_Tool invocation fails, THEN THE Agent_Runner SHALL record a Trace_Step describing the failure and continue the loop without terminating the Case.
7. IF the diagnosis-code-lookup external service is unavailable, THEN THE diagnosis-code-lookup Agent_Tool SHALL return a result indicating the code could not be validated.
8. WHILE the Medical_Review stage is executing, THE Agent_Runner SHALL restrict Medical_Review tool access to the fetch-patient-record Agent_Tool only.
9. WHILE the Policy_Review stage is executing, THE Agent_Runner SHALL restrict Policy_Review tool access to the fetch-payer-policy Agent_Tool only.

### Requirement 4: Contradiction and Gap Detection

**User Story:** As a physician, I want AuthPilot to flag what is missing or conflicting, so that I can trust it is not glossing over problems.

#### Acceptance Criteria

1. WHEN the Agent_Runner detects that an extracted value conflicts with an investigated source, THE Agent_Runner SHALL record a Trace_Step describing the contradiction and the two conflicting sources.
2. WHEN the Agent_Runner detects that evidence required by the Payer_Policy is absent from available sources, THE Agent_Runner SHALL record a Trace_Step describing the gap.
3. WHEN a Chart_Note supporting the case is dated more than 90 days before the Case creation date, THE Agent_Runner SHALL record a Trace_Step flagging the Chart_Note as potentially stale, including the note date.
4. WHEN the Agent_Runner detects one or more contradictions for a Case, THE Decision_Engine SHALL set the Resolution_Path to Escalate_To_Human.

### Requirement 5: Confidence-Scored Decision Engine

**User Story:** As a billing staff member, I want AuthPilot to decide whether it can act automatically or needs me, so that my attention goes only to the hard cases.

#### Acceptance Criteria

1. WHEN the Agent_Runner completes investigation for a Case, THE Decision_Engine SHALL compute an overall Confidence_Score from 0 to 100 for the resolution decision.
2. WHEN the Decision_Intelligence stage computes the resolution decision, THE Decision_Engine SHALL derive it from the Medical_Review summary, the Policy_Review summary, and the Strategy summary rather than from raw source documents.
3. WHERE the overall Confidence_Score is greater than 85 AND no contradiction is detected, THE Decision_Engine SHALL set the Resolution_Path to Auto_Draft.
4. WHERE the overall Confidence_Score is greater than or equal to 60 AND less than or equal to 85 AND no contradiction is detected, THE Decision_Engine SHALL set the Resolution_Path to Draft_And_Request_Evidence.
5. WHERE the overall Confidence_Score is less than 60, THE Decision_Engine SHALL set the Resolution_Path to Escalate_To_Human.
6. WHEN the Decision_Engine sets a Resolution_Path, THE Agent_Runner SHALL record a Trace_Step of type "decision" storing the overall Confidence_Score, the selected Resolution_Path, and the reasoning.
7. WHEN the Decision_Engine selects Auto_Draft, THE AuthPilot SHALL set the Case_Status to "AwaitingApproval".
8. WHEN the Decision_Engine selects Draft_And_Request_Evidence, THE AuthPilot SHALL set the Case_Status to "AwaitingApproval" and record the specific additional evidence requested.
9. WHEN the Decision_Engine selects Escalate_To_Human, THE AuthPilot SHALL set the Case_Status to "NeedsHumanInput".

### Requirement 6: Agent Loop Control

**User Story:** As an operator, I want the agent to run in a bounded, observable loop, so that it never runs away and I can see each step.

#### Acceptance Criteria

1. WHEN a Case is created, THE Agent_Runner SHALL begin the agent loop asynchronously using the Case raw Intake text as the initial input.
2. WHILE the agent loop is executing for a Case, THE AuthPilot SHALL set the Case_Status to "Investigating".
3. WHEN the Agent_Runner completes one loop iteration, THE Agent_Runner SHALL persist all Trace_Step and Extracted_Field records produced in that iteration before beginning the next iteration.
4. IF the agent loop reaches 8 iterations without producing a final decision, THEN THE Agent_Runner SHALL stop the loop, set the Resolution_Path to Escalate_To_Human, and record a Trace_Step with reasoning "needs manual review".
5. IF a call to the Qwen_Client fails, THEN THE Qwen_Client SHALL retry the call up to 2 additional times before reporting failure to the Agent_Runner.
6. WHEN the Qwen_Client issues a request attempt, THE Qwen_Client SHALL apply a bounded timeout to that attempt.
7. IF a Qwen_Client attempt fails with a transient failure — a network error, a request timeout, or an HTTP 429, 500, 502, 503, or 504 response — THEN THE Qwen_Client SHALL retry the call using exponential backoff, up to the 3-attempt total established in Requirement 6.5.
8. IF a Qwen_Client attempt fails with a permanent failure — an HTTP 4xx response other than 429, or a malformed or empty response — THEN THE Qwen_Client SHALL report a structured failure result to the Agent_Runner on that attempt without performing a further retry.
9. WHEN the Qwen_Client reports a structured failure result to the Agent_Runner, THE Agent_Runner SHALL degrade the calling Pipeline_Stage gracefully by setting the Resolution_Path to Escalate_To_Human rather than terminating the run abnormally.

### Requirement 7: Appeal Packet Generation

**User Story:** As a billing staff member, I want AuthPilot to produce a real, evidence-cited appeal PDF, so that I can send a strong appeal instead of a generic template.

#### Acceptance Criteria

1. WHEN the Decision_Engine selects Auto_Draft or Draft_And_Request_Evidence, THE Agent_Runner SHALL invoke the generate-appeal-PDF Agent_Tool for the Case.
2. WHEN the Appeal_Generation stage produces an Appeal_Packet, THE Agent_Runner SHALL derive the Appeal_Packet content from the Decision_Intelligence stage output rather than from raw source documents.
3. WHEN the generate-appeal-PDF Agent_Tool produces an Appeal_Packet, THE Appeal_Packet SHALL cite the denial reason, the referenced Payer_Policy clause, and the supporting Chart_Note evidence for the Case.
4. WHEN an Appeal_Packet is generated, THE AuthPilot SHALL store the Appeal_Packet location reference on the Case.
5. WHEN an Appeal_Packet is generated, THE AuthPilot SHALL make the Appeal_Packet available for preview and download on the Case Detail page.

### Requirement 8: Human-in-the-Loop Approval

**User Story:** As a physician, I want to approve, edit, request more evidence, or reject every outbound action, so that nothing is sent without my sign-off.

#### Acceptance Criteria

1. WHILE a Case has status "AwaitingApproval", THE AuthPilot SHALL present the agent recommendation with the actions Approve, Edit, Request More Evidence, and Reject.
2. WHEN an Operator selects Approve for a Case, THE AuthPilot SHALL record a Trace_Step of type "human_action" with the approval and set the Case_Status to "AppealSent".
3. WHEN an Operator selects Reject for a Case, THE AuthPilot SHALL record a Trace_Step of type "human_action" with the rejection and set the Case_Status to "NeedsHumanInput".
4. WHEN an Operator selects Edit and submits revised recommendation content, THE AuthPilot SHALL store the revised content on the Case and record a Trace_Step of type "human_action" describing the edit.
5. WHEN an Operator selects Request More Evidence and submits additional information, THE AuthPilot SHALL append the additional information to the Case context, re-invoke the Agent_Runner, and record a Trace_Step of type "human_action".
6. WHILE no Human_Action has been recorded for a Case recommendation, THE AuthPilot SHALL NOT mark any outbound action as sent.
7. WHEN an outbound action is approved, THE AuthPilot SHALL simulate sending the action rather than transmitting to any external system.
8. WHERE a Human_Action is initiated via the WhatsApp_Channel by a registered Staff_Number, THE AuthPilot SHALL record the resulting "human_action" Trace_Step with a channel source of "whatsapp".
9. WHEN a Human_Action initiated via the WhatsApp_Channel changes the Case_Status, THE AuthPilot SHALL apply the change through the Case Status state machine defined in Requirement 28 and SHALL apply the change idempotently consistent with Requirement 26.
10. THE AuthPilot SHALL perform the Approve, Reject, Edit, and Request More Evidence actions through the single Shared_Case_Action operation defined in Requirement 40, which SHALL be the sole writer of the "human_action" Trace_Step for these transitions regardless of whether the action originates from the Dashboard or the WhatsApp_Channel.

### Requirement 9: Full Audit Trail

**User Story:** As a compliance-conscious operator, I want a complete chronological record of everything AuthPilot and I did, so that every decision is defensible.

#### Acceptance Criteria

1. THE AuthPilot SHALL record for every Extracted_Field the source document, extracted value, Confidence_Score, reasoning, timestamp, and originating tool or agent step.
2. THE AuthPilot SHALL record for every Trace_Step the step type, reasoning, timestamp, and the tool name, input, and output where applicable.
3. WHEN an Operator opens the Audit Trail page for a Case, THE AuthPilot SHALL display all Extracted_Field and Trace_Step records for that Case merged in chronological order.
4. WHEN an Operator requests an audit export for a Case, THE AuthPilot SHALL generate a PDF containing the full Audit_Trail for that Case.

### Requirement 10: Case Dashboard

**User Story:** As a billing staff member, I want a Kanban board of all cases by status, so that I can see my whole workload at a glance.

#### Acceptance Criteria

1. WHEN an Operator opens the Dashboard, THE AuthPilot SHALL display all Cases grouped into columns by Case_Status: New, Investigating, NeedsHumanInput, AwaitingApproval, AppealSent, Resolved, and DeniedFinal.
2. WHEN the Dashboard renders a Case card, THE AuthPilot SHALL display the patient initials, payer, procedure, overall Confidence_Score badge, and SLA_Clock countdown for that Case.
3. WHEN an Operator selects a Case card, THE AuthPilot SHALL open the Case Detail page for that Case.
4. WHEN an Operator selects the New Case control on the Dashboard, THE AuthPilot SHALL open the Intake page.
5. WHEN the Dashboard renders, THE AuthPilot SHALL display an analytics widget summarizing denials by payer for the current month.

### Requirement 11: Live Agent Trace Panel

**User Story:** As an operator, I want to watch AuthPilot's reasoning stream live, so that I can see it is genuinely investigating and not returning a canned answer.

#### Acceptance Criteria

1. WHILE a Case has status "Investigating", THE AuthPilot SHALL poll for new Trace_Steps for that Case at an interval of one second.
2. WHEN new Trace_Steps are retrieved for a Case, THE AuthPilot SHALL append them to the live agent trace panel in chronological order with an entrance animation.
3. WHEN an Operator requests Trace_Steps since a given timestamp, THE AuthPilot SHALL return only the Trace_Steps created after that timestamp.
4. WHEN a Trace_Step is displayed in the trace panel, THE AuthPilot SHALL display the step reasoning and, for tool calls, the tool name.
5. WHEN a Trace_Step of step type "medical_review", "policy_review", "strategy", "verification", or "decision" is displayed in the trace panel, THE AuthPilot SHALL display a stage label identifying the originating Pipeline_Stage.

### Requirement 12: SLA Clock and At-Risk Flagging

**User Story:** As a billing staff member, I want each case to show a deadline countdown and warn me when it is at risk, so that I never miss the CMS appeal window.

#### Acceptance Criteria

1. WHEN a Case is created, THE AuthPilot SHALL set the SLA_Clock deadline to 72 hours from creation WHERE Case.isUrgent is true and to 7 days from creation WHERE Case.isUrgent is false.
2. WHILE a Case is unresolved, THE AuthPilot SHALL display the remaining time until the SLA_Clock deadline.
3. WHEN the remaining time until a Case SLA_Clock deadline is less than 24 hours, THE AuthPilot SHALL flag the Case as at-risk.
4. WHEN a Case is flagged as at-risk, THE AuthPilot SHALL display the at-risk indicator on the Dashboard card and in the Analytics_Page at-risk list.

### Requirement 13: Case Detail Screen

**User Story:** As an operator, I want a single screen showing extracted facts, the live trace, and my action zone, so that I can work a case end to end in one place.

#### Acceptance Criteria

1. WHEN an Operator opens the Case Detail page, THE AuthPilot SHALL display a case-facts panel listing each Extracted_Field with its value, Confidence_Score, and source tag.
2. WHEN an Operator expands the source tag of an Extracted_Field, THE AuthPilot SHALL display the source document or tool that produced the value.
3. WHEN an Operator opens the Case Detail page, THE AuthPilot SHALL display the live agent trace panel and the human action zone with the current recommendation.
4. WHERE an Appeal_Packet exists for the Case, THE AuthPilot SHALL display an Appeal_Packet preview and a download control in the human action zone.

### Requirement 14: Denial Pattern Analytics

**User Story:** As a practice manager, I want charts of denial patterns and resolution performance, so that I can see operations intelligence beyond single cases.

#### Acceptance Criteria

1. WHEN an Operator opens the Analytics_Page, THE AuthPilot SHALL display a chart of denial reasons grouped by the Case payer reference, grouping every Case whose payer reference is unset under an "Unknown payer" bucket, such that the sum of the grouped Cases equals the total number of Cases that have a denial reason.
2. WHEN an Operator opens the Analytics_Page, THE AuthPilot SHALL display the resolution rate across Cases.
3. WHEN an Operator opens the Analytics_Page, THE AuthPilot SHALL display the average time-to-resolution across resolved Cases.
4. WHEN an Operator opens the Analytics_Page, THE AuthPilot SHALL display a list of Cases nearing their SLA_Clock deadline.

### Requirement 15: Patient-Facing Plain-English Explanation

**User Story:** As a front-office staff member, I want a plain-English explanation of the denial to show the patient, so that I can communicate clearly without medical jargon.

#### Acceptance Criteria

1. WHEN the Agent_Runner produces a recommendation for a Case, THE Agent_Runner SHALL produce a plain-English explanation of the denial reason and the next steps.
2. WHEN an Operator opens the Case Detail page, THE AuthPilot SHALL display the plain-English explanation alongside the technical recommendation.

### Requirement 16: What-If Replanning

**User Story:** As a physician, I want AuthPilot to re-reason when I reject its recommendation or add evidence, so that I get an updated recommendation without starting over.

#### Acceptance Criteria

1. WHEN an Operator selects Request More Evidence or Reject and submits new information, THE Agent_Runner SHALL re-run its reasoning using the existing Case context plus the new information.
2. WHEN the Agent_Runner completes a re-run, THE AuthPilot SHALL produce an updated recommendation and record the new Trace_Steps and Extracted_Fields for the Case.

### Requirement 17: Multi-Payer Policy Diffing

**User Story:** As a practice manager, I want AuthPilot to explain why the same procedure has different outcomes across payers, so that I understand payer-specific criteria differences.

#### Acceptance Criteria

1. WHEN an Operator requests a policy comparison for a procedure code across two or more payers, THE AuthPilot SHALL retrieve the matching Payer_Policy criteria for each selected payer.
2. WHEN Payer_Policy criteria for the same procedure differ across payers, THE AuthPilot SHALL present the differing criteria and an explanation of how the differences affect the outcome.
3. WHEN the Strategy stage computes Strategy_Options for a Case, THE Strategy stage SHALL query the multi-payer policy diffing described in this requirement as one of its inputs.

### Requirement 18: Seed and Demo Data

**User Story:** As a demo operator, I want realistic pre-loaded data and a reset control, so that the app looks populated and can be reliably reset between run-throughs.

#### Acceptance Criteria

1. WHEN the seed process runs, THE AuthPilot SHALL create at least 3 Payers, each with 2 or more Payer_Policy records containing LCD-style medical-necessity criteria.
2. WHEN the seed process runs, THE AuthPilot SHALL create between 6 and 8 Patients, each with 1 to 3 Chart_Notes that include at least one stale note, one mismatched diagnosis code, and one missing evidence reference.
3. WHEN the seed process runs, THE AuthPilot SHALL create between 4 and 5 Cases spanning different Case_Status values.
4. WHEN the seed process runs, THE AuthPilot SHALL create at least one Case designed for each Resolution_Path: Auto_Draft, Draft_And_Request_Evidence, and Escalate_To_Human.
5. WHEN an Operator selects the Reset Demo Data control, THE AuthPilot SHALL re-run the seed process and restore the seeded data set.

### Requirement 19: Navigation and Global Status

**User Story:** As an operator, I want persistent navigation and a live agent-status indicator, so that I can move between views and always know whether the agent is running.

#### Acceptance Criteria

1. THE AuthPilot SHALL display a persistent sidebar with links to the Dashboard, Intake, and Analytics_Page on every page.
2. WHEN an Operator enters a patient name in the global search, THE AuthPilot SHALL display Cases matching that patient name.
3. WHILE the Agent_Runner is executing a Case, THE AuthPilot SHALL display an agent-status indicator showing the running Case identifier.
4. WHILE no Agent_Runner execution is in progress, THE AuthPilot SHALL display an agent-status indicator showing "Idle".

### Requirement 20: Multi-Stage Agent Pipeline

**User Story:** As an operator, I want AuthPilot to run as distinct named stages, so that I can see specialized reasoning steps instead of one undifferentiated loop.

#### Acceptance Criteria

1. WHEN the Agent_Runner processes a Case, THE Agent_Runner SHALL execute the pipeline so that the earliest Trace_Step timestamp of each Pipeline_Stage occurs in the relative order Intake_And_Extraction first, then Medical_Review and Policy_Review, then Strategy, then Decision_Intelligence, then Appeal_Generation, then Verification_QA, then Human_Approval, then Submission_And_Tracking.
2. WHEN the Agent_Runner reaches the review phase for a Case, THE Agent_Runner SHALL run the Medical_Review stage and the Policy_Review stage with overlapping execution windows, such that each of the two stages begins before the other stage completes.
3. WHEN the Intake_And_Extraction stage runs, THE Agent_Runner SHALL resolve, within that single stage, an Extracted_Field for each of patient, payer, procedure code, diagnosis code, and denial reason.
4. IF the Intake_And_Extraction stage cannot resolve one or more of the required Extracted_Fields (patient, payer, procedure code, diagnosis code, or denial reason) from the Intake, THEN THE Agent_Runner SHALL record a Trace_Step identifying each unresolved field and continue the pipeline without terminating the Case.
5. WHEN any Pipeline_Stage runs, THE Agent_Runner SHALL record at least one Trace_Step labeled with that Pipeline_Stage.
6. IF a Pipeline_Stage fails to complete due to an error, THEN THE Agent_Runner SHALL record a Trace_Step describing the failure and the affected Pipeline_Stage, and set the Resolution_Path to Escalate_To_Human without proceeding to subsequent stages.
7. WHEN the Medical_Review stage records a Trace_Step, THE Agent_Runner SHALL set the Trace_Step step type to "medical_review".
8. WHEN the Policy_Review stage records a Trace_Step, THE Agent_Runner SHALL set the Trace_Step step type to "policy_review".
9. WHEN the Strategy stage records a Trace_Step, THE Agent_Runner SHALL set the Trace_Step step type to "strategy".
10. WHEN the Verification_QA stage records a Trace_Step, THE Agent_Runner SHALL set the Trace_Step step type to "verification".
11. THE Agent_Runner SHALL implement the Strategy and Verification_QA stages using only the existing Agent_Tools without introducing any additional tool.
12. THE Agent_Runner SHALL implement the pipeline without a separate Learning, Memory, Document, Entity, or Orchestrator stage as a distinct Qwen call.

### Requirement 21: Strategy Stage

**User Story:** As a practice manager, I want AuthPilot to weigh candidate appeal approaches by likelihood of success, so that it pursues the strategy most likely to win.

#### Acceptance Criteria

1. WHEN the Strategy stage runs for a Case, THE Strategy stage SHALL invoke the prior-auth-history Agent_Tool with the patient identifier to obtain the seeded case history for the patient.
2. WHEN the Strategy stage runs for a Case, THE Strategy stage SHALL identify at least one and at most five candidate appeal approaches and compute for each a win-probability estimate, expressed as an integer from 0 to 100 (percent), using the seeded case history and the payer-specific track record.
3. IF the prior-auth-history Agent_Tool returns no seeded case history or fails to return within its invocation, THEN THE Strategy stage SHALL compute the win-probability estimates using the payer-specific track record only and SHALL record an indication that seeded case history was unavailable.
4. WHEN the Strategy stage computes candidate approaches, THE AuthPilot SHALL store each candidate appeal approach and its win-probability estimate as Strategy_Options on the Case, ordered by descending win-probability estimate.
5. WHEN the Strategy stage completes, THE Agent_Runner SHALL provide the Strategy_Options summary, including each candidate appeal approach and its win-probability estimate, to the Decision_Intelligence stage.

### Requirement 22: Verification and QA Stage

**User Story:** As a physician, I want AuthPilot to independently check the drafted appeal for errors before I see it, so that I never review an appeal containing fabricated or mismatched references.

#### Acceptance Criteria

1. WHEN an Appeal_Packet is generated for a Case, THE Verification_QA stage SHALL check every citation in the Appeal_Packet against the retrieved Payer_Policy and Chart_Note data, and SHALL add a flagged issue identifying each citation that is not supported by that data.
2. WHEN an Appeal_Packet is generated for a Case, THE Verification_QA stage SHALL check every patient, policy, and code reference in the Appeal_Packet against the Case Extracted_Field values, and SHALL add a flagged issue identifying each reference that does not match the corresponding Extracted_Field value.
3. WHEN an Appeal_Packet is generated for a Case, THE Verification_QA stage SHALL check every claim in the Appeal_Packet against the retrieved evidence, and SHALL add a flagged issue identifying each claim that is not supported by that evidence.
4. WHEN the Verification_QA stage completes its checks, THE AuthPilot SHALL store a Verification_Result on the Case whose status is pass when the flagged-issues list contains zero issues and fail when the flagged-issues list contains one or more issues, together with the complete flagged-issues list.
5. THE AuthPilot SHALL NOT present a Case for Human_Approval until the Verification_QA stage has completed and its Verification_Result has been stored on the Case.
6. IF the Verification_Result status is fail, THEN THE AuthPilot SHALL display each flagged issue alongside the recommendation in the human action zone.
7. IF the Verification_QA stage cannot complete its checks due to a processing error, THEN THE AuthPilot SHALL store a Verification_Result with status fail and a flagged issue indicating that verification could not be completed, and SHALL NOT present the Case for Human_Approval as verified.
8. WHEN an Appeal_Packet is generated for a Case, THE Verification_QA stage SHALL verify that every citation and reference in the Appeal_Packet — the payer policy clause or identifier, the chart-note evidence, the diagnosis or procedure code, and the patient — resolves to an actual stored record in scope for the Case.
9. IF a citation or reference in the Appeal_Packet does not resolve to a stored record in scope for the Case, THEN THE Verification_QA stage SHALL add the unresolved citation or reference as a blocking flagged issue and THE AuthPilot SHALL set the Verification_Result status to fail so the appeal is not presented as verified.

### Requirement 23: Pipeline Data Persistence

**User Story:** As a compliance-conscious operator, I want the strategy and verification outputs stored on the case, so that the full multi-stage reasoning is auditable.

#### Acceptance Criteria

1. WHEN the Strategy stage produces Strategy_Options for a Case, THE AuthPilot SHALL persist the Strategy_Options on that Case as a structured field that retains each candidate appeal approach with its win-probability estimate and is retrievable independently of the existing recommendation.
2. WHEN the Verification_QA stage produces a Verification_Result for a Case, THE AuthPilot SHALL persist the Verification_Result on that Case as a structured field that retains the pass or fail status and the complete list of flagged issues and is retrievable independently of the existing recommendation.
3. THE AuthPilot SHALL restrict a Trace_Step step type to exactly one of the following seven values: "tool_call", "decision", "human_action", "medical_review", "policy_review", "strategy", or "verification".
4. WHEN an Operator opens the Audit Trail for a Case, THE AuthPilot SHALL return the persisted Strategy_Options and Verification_Result for that Case unchanged from the values stored by the Strategy stage and the Verification_QA stage.
5. IF persistence of the Strategy_Options or the Verification_Result for a Case fails, THEN THE AuthPilot SHALL record a Trace_Step describing the failure and SHALL retain the existing Case recommendation without overwriting it.
6. IF a Trace_Step is created with a step type outside the seven allowed values, THEN THE AuthPilot SHALL reject the Trace_Step and record an error indication identifying the invalid step type.

### Requirement 24: Case Outcome Recording

**User Story:** As an operator, I want to record whether a submitted appeal was won or denied, so that resolved cases leave the AppealSent state and analytics reflect real resolution performance.

#### Acceptance Criteria

1. WHILE a Case has status "AppealSent", THE AuthPilot SHALL present exactly two Case_Outcome actions, Appeal Won and Appeal Denied, to the Operator, and SHALL NOT present any Case_Outcome action while the Case has any other status.
2. WHEN an Operator selects Appeal Won for a Case in status "AppealSent", THE AuthPilot SHALL set the Case_Status to "Resolved", set Case.resolvedAt to the system timestamp captured at the moment the action is processed, and record a Trace_Step of type "human_action" describing the recorded outcome, completing all three effects within 3 seconds of the selection.
3. WHEN an Operator selects Appeal Denied for a Case in status "AppealSent", THE AuthPilot SHALL set the Case_Status to "DeniedFinal", set Case.resolvedAt to the system timestamp captured at the moment the action is processed, and record a Trace_Step of type "human_action" describing the recorded outcome, completing all three effects within 3 seconds of the selection.
4. IF an Operator attempts a Case_Outcome action on a Case whose status is not "AppealSent", THEN THE AuthPilot SHALL reject the action, leave the Case_Status and Case.resolvedAt unchanged, record no Trace_Step, and return a message identifying that the Case must be in status "AppealSent" for the action to proceed.
5. IF the AuthPilot cannot persist the Case_Status change, the Case.resolvedAt value, or the Trace_Step while processing a Case_Outcome action, THEN THE AuthPilot SHALL roll back all three effects so the Case retains status "AppealSent" with its prior Case.resolvedAt value, and return a message indicating the outcome was not recorded.
6. WHEN a Case reaches status "Resolved" or "DeniedFinal", THE AuthPilot SHALL retain the Case.resolvedAt value for use by the resolution-rate and average-time-to-resolution analytics.

### Requirement 25: Tamper-Evident Audit Chain

**User Story:** As a compliance-conscious operator, I want every audit event chained by hash to the one before it, so that any later tampering with the record is detectable.

#### Acceptance Criteria

1. WHEN the AuthPilot records a Trace_Step or Human_Action audit event for a Case, THE AuthPilot SHALL compute the event hash over a Canonical_Serialization of the audit event content and store both that hash and the prevHash referencing the immediately preceding audit event hash.
2. WHEN the AuthPilot records the first audit event for a Case, THE AuthPilot SHALL set the prevHash of that audit event to the fixed Genesis_Hash.
3. WHEN an audit event records a mutating change to a Case, THE AuthPilot SHALL capture the before-state and the after-state of the changed fields within the audit event content.
4. THE AuthPilot SHALL provide an integrity-verification operation that re-walks the Audit_Chain for a Case and returns whether the Audit_Chain is intact together with the head hash, where the head hash is the stored hash of the most recent audit event.
5. IF the recomputed hash of an audit event does not equal the stored hash of that audit event, THEN the integrity-verification operation SHALL report the Audit_Chain as broken and identify the first broken audit event.
6. IF the stored prevHash of an audit event does not equal the stored hash of the immediately preceding audit event, THEN the integrity-verification operation SHALL report the Audit_Chain as broken and identify the first broken audit event.
7. WHEN the integrity-verification operation finds no recomputed-hash mismatch and no prevHash linkage mismatch across all audit events for a Case, THE AuthPilot SHALL report the Audit_Chain as intact and return the head hash.

### Requirement 26: Idempotent Mutating Operations

**User Story:** As an operator, I want retried actions to take effect only once, so that a network retry never sends an appeal twice or advances a case twice.

#### Acceptance Criteria

1. THE AuthPilot SHALL accept a client-supplied Idempotency_Key with every mutating operation, including appeal submission, appeal approval, Case_Outcome recording, and stage-advancing status writes.
2. WHEN a mutating operation is received with an Idempotency_Key that has not been previously processed, THE AuthPilot SHALL apply the operation effect once and store the operation result together with that Idempotency_Key.
3. WHEN a mutating operation is retried with an Idempotency_Key that has already been processed, THE AuthPilot SHALL return the stored original result and SHALL apply the operation effect at most once across all retries with that Idempotency_Key.
4. IF a retried appeal-submission operation carries an already-processed Idempotency_Key, THEN THE AuthPilot SHALL return the original submission result without submitting the appeal a second time.
5. IF a retried stage-advancing operation carries an already-processed Idempotency_Key, THEN THE AuthPilot SHALL return the original result without advancing the Case_Status a second time.

### Requirement 27: Untrusted Content Safety Guard

**User Story:** As a physician, I want untrusted intake and document text screened before it reaches the model, so that a denial letter cannot hijack the agent with hidden instructions.

#### Acceptance Criteria

1. WHEN raw Intake text or extracted document text is incorporated into any prompt to the Qwen_Client, THE AuthPilot SHALL first screen the content with the Safety_Guard before the model call.
2. WHEN the Safety_Guard screens untrusted content, THE Safety_Guard SHALL fence the content and mark it as data rather than instructions within the prompt.
3. WHEN the Safety_Guard screens untrusted content, THE Safety_Guard SHALL detect prompt-injection and instruction-override patterns using deterministic rules without invoking any language model.
4. IF the Safety_Guard detects an injection attempt in untrusted content, THEN THE AuthPilot SHALL record a Trace_Step flagging the detected injection attempt.
5. IF the Safety_Guard detects an injection attempt in untrusted content, THEN THE AuthPilot SHALL treat the untrusted content as data only and SHALL NOT allow the untrusted content to be interpreted as agent instructions.

### Requirement 28: Case Status State Machine

**User Story:** As an operator, I want case status changes constrained to a defined set of transitions, so that a case can never enter an inconsistent or impossible state.

#### Acceptance Criteria

The allowed Status_Transitions are defined by the following table. Any (from-status, to-status) pair not listed is an illegal transition.

| From status | Allowed to-status |
|---|---|
| New | Investigating |
| Investigating | AwaitingApproval, NeedsHumanInput |
| AwaitingApproval | AppealSent, NeedsHumanInput |
| NeedsHumanInput | Investigating, AwaitingApproval |
| AppealSent | Resolved, DeniedFinal |
| Resolved | (terminal — none) |
| DeniedFinal | (terminal — none) |

1. THE AuthPilot SHALL restrict allowed Status_Transitions to the set defined in the table above.
2. IF a requested Status_Transition has a to-status that differs from its from-status and is not in the allowed set, THEN THE AuthPilot SHALL reject the transition, leave the Case_Status unchanged, and return a message identifying the illegal Status_Transition.
3. WHEN a requested Status_Transition has a to-status equal to its from-status, THE AuthPilot SHALL treat the transition as an idempotent no-op and return success while leaving the Case_Status unchanged.
4. THE AuthPilot SHALL treat "Resolved" and "DeniedFinal" as terminal statuses that have no allowed outgoing Status_Transition.
5. IF a Status_Transition is requested from the terminal status "Resolved" or "DeniedFinal" to a different status, THEN THE AuthPilot SHALL reject the transition and leave the Case_Status unchanged.

### Requirement 29: Structured Findings with Stable Identifiers and Severity

**User Story:** As a physician, I want every contradiction, gap, policy issue, and verification issue expressed as a structured finding with a severity, so that only genuinely blocking problems force escalation while warnings stay visible.

#### Acceptance Criteria

1. WHEN the AuthPilot produces a contradiction, gap, policy, or verification issue, THE AuthPilot SHALL record it as a Finding carrying a stable finding identifier, a Finding_Severity of "warning" or "blocking", the expected and actual values where applicable, a technical message, and a patient/operator-friendly message.
2. WHEN the AuthPilot detects a contradiction for a Case, THE AuthPilot SHALL assign the corresponding Finding a Finding_Severity of "blocking".
3. WHEN a Verification_QA flagged issue is recorded as a Finding, THE AuthPilot SHALL assign the Finding a Finding_Severity of "blocking" or "warning" according to its effect on appeal validity.
4. WHEN the AuthPilot routes a Case to Escalate_To_Human or to status "NeedsHumanInput" based on Findings, THE AuthPilot SHALL base that routing only on Findings whose Finding_Severity is "blocking".
5. WHERE a Finding has a Finding_Severity of "warning", THE AuthPilot SHALL surface the Finding to the reviewer without forcing escalation to Escalate_To_Human or to status "NeedsHumanInput".

### Requirement 30: Gold-Case Decision Evaluation

**User Story:** As a practice manager, I want a set of gold evaluation cases with expected outcomes, so that a change to the decision logic that breaks a known case is caught automatically.

#### Acceptance Criteria

1. THE AuthPilot SHALL include a set of Gold_Cases, each asserting the expected Resolution_Path and the expected triggering Finding identifier(s).
2. WHEN the Gold_Case evaluation operation runs, THE AuthPilot SHALL execute each Gold_Case and compare the produced Resolution_Path and triggering Finding identifier(s) against the expected values for that Gold_Case.
3. WHEN the Gold_Case evaluation operation completes, THE AuthPilot SHALL report a per-case pass or fail result, where a Gold_Case passes only when the produced Resolution_Path and the produced triggering Finding identifier(s) match the expected values.
4. IF a Gold_Case produces a Resolution_Path or a triggering Finding identifier that differs from its expected values, THEN THE AuthPilot SHALL report that Gold_Case as failed.

### Requirement 31: WhatsApp Webhook Ingress and Verification

**User Story:** As an operator, I want the WhatsApp channel endpoint to verify and authenticate every inbound request, so that only genuine, unaltered messages are processed and each is processed once.

#### Acceptance Criteria

1. WHEN the WhatsApp_Channel endpoint receives a GET verification request, THE AuthPilot SHALL complete the verification handshake by comparing the presented verify token against the configured verify token and returning the presented challenge value only when the tokens match.
2. IF the presented verify token does not match the configured verify token, THEN THE AuthPilot SHALL reject the GET verification request without completing the handshake.
3. WHERE a WhatsApp app secret is configured, WHEN the WhatsApp_Channel endpoint receives a POST inbound request, THE AuthPilot SHALL verify the request by computing an X-Hub-Signature-256 HMAC over the exact raw request body using the app secret and comparing the computed signature against the presented signature using a constant-time comparison.
4. IF the computed signature does not match the presented signature WHERE a WhatsApp app secret is configured, THEN THE AuthPilot SHALL reject the POST inbound request without processing its content.
5. WHEN the WhatsApp_Channel endpoint accepts a verified POST inbound request, THE AuthPilot SHALL acknowledge receipt promptly and process the message asynchronously.
6. WHEN the WhatsApp_Channel processes inbound messages, THE AuthPilot SHALL deduplicate messages by inbound message identifier so that each inbound message identifier is processed at most once, consistent with the idempotency guarantees of Requirement 26.
7. WHEN the WhatsApp_Channel processes a webhook-originated message, THE AuthPilot SHALL write the resulting audit events to the same Audit_Chain defined in Requirement 25 that the in-app flow uses.

### Requirement 32: WhatsApp Patient Intake

**User Story:** As a patient, I want to send my insurance problem or a photo of my denial letter over WhatsApp, so that AuthPilot starts working my case and I get an acknowledgement.

#### Acceptance Criteria

1. WHEN a patient sends free-text over the WhatsApp_Channel, THE AuthPilot SHALL create a Case with intake type "whatsapp_patient_note", store the message text as the raw Intake, and run the normal agent pipeline.
2. WHEN a patient sends a denial-letter image over the WhatsApp_Channel, THE AuthPilot SHALL extract the text from the image, store the extracted text as the raw Intake, create a Case with intake type "whatsapp_patient_note", and run the normal agent pipeline.
3. WHEN a Case is created from a patient WhatsApp message, THE AuthPilot SHALL reply on the WhatsApp_Channel with a generic pre-approved acknowledgement Patient_Template.
4. WHEN a patient asks for status over the WhatsApp_Channel, THE AuthPilot SHALL look up the patient's most recent open Case by phone number and reply with a generic PHI-free status Patient_Template without re-running the agent pipeline.
5. IF a patient asks for status over the WhatsApp_Channel and no open Case exists for that phone number, THEN THE AuthPilot SHALL reply with a generic "no open case" Patient_Template.
6. WHEN a patient sends an image or PDF over the WhatsApp_Channel, THE AuthPilot SHALL handle the file through the media quality gate defined in Requirement 41 before creating any Case.
7. WHEN an inbound patient message does not match a clear new-case trigger or a status query, THE AuthPilot SHALL route the message to the Conversational_Fallback defined in Requirement 44 rather than creating a Case from it.

### Requirement 33: WhatsApp Patient Outbound Messaging

**User Story:** As a compliance-conscious operator, I want every patient-facing WhatsApp message to be a generic pre-approved template with no PHI, so that protected health information never leaves the app over the channel.

#### Acceptance Criteria

1. THE AuthPilot SHALL define four generic Patient_Template triggers for outbound patient messages: case created, needs-more-info, appeal filed, and resolved.
2. WHEN the needs-more-info Patient_Template is sent, THE AuthPilot SHALL send a generic message that does not state which information or document is missing.
3. THE AuthPilot SHALL restrict every patient-facing WhatsApp_Message to content that contains no PHI and no case-specific medical detail.
4. THE AuthPilot SHALL send every outbound patient WhatsApp_Message using a pre-approved Patient_Template.
5. WHILE the 24-hour session window for a patient conversation is open, THE AuthPilot SHALL deliver outbound patient messages within that session window.
6. IF an outbound patient WhatsApp_Message cannot be delivered within the 24-hour session window, THEN THE AuthPilot SHALL re-attempt delivery using an approved Patient_Template at most one additional time and SHALL NOT enter an automatic resend loop.

### Requirement 34: WhatsApp Staff Actions

**User Story:** As a staff member, I want to approve, reject, and query cases from WhatsApp, so that I can act on cases from anywhere with the same effect as the dashboard.

#### Acceptance Criteria

1. WHILE a registered Staff_Number messages the WhatsApp_Channel, THE AuthPilot SHALL parse the commands Approve <case-id>, Reject <case-id>, Status <case-id | patient name>, and Show <case-id>.
2. WHEN a registered Staff_Number sends Approve <case-id>, THE AuthPilot SHALL perform the same effect as the in-app Approve action by transitioning the Case to "AppealSent", generating and sending the Appeal_Packet, and recording a "human_action" Trace_Step with source "whatsapp".
3. WHEN a registered Staff_Number sends Reject <case-id>, THE AuthPilot SHALL transition the Case to "NeedsHumanInput" and record the rejection reason.
4. WHEN a registered Staff_Number sends Status <case-id | patient name>, THE AuthPilot SHALL reply with a one-line summary containing the Case_Status, the overall Confidence_Score, and the SLA days remaining.
5. WHEN a registered Staff_Number sends Show <case-id>, THE AuthPilot SHALL reply with a link to the Case Detail page for that Case.
6. WHEN a staff action from the WhatsApp_Channel changes the Case_Status, THE AuthPilot SHALL apply the change through the Case Status state machine defined in Requirement 28 and SHALL apply the change idempotently consistent with Requirement 26.
7. IF a WhatsApp_Channel action command is sent by a sender that is not a registered Staff_Number, THEN THE AuthPilot SHALL reject the action without changing the Case.
8. WHEN a registered Staff_Number sends Approve <case-id> or Reject <case-id>, THE AuthPilot SHALL carry out the action through the single Shared_Case_Action operation defined in Requirement 40, the same operation the Dashboard invokes.
9. IF a staff message expresses an intent to act on a Case without using the exact structured command format, THEN THE AuthPilot SHALL apply the free-text action guardrail defined in Requirement 45 and SHALL take no case action from the ambiguous message.
10. WHEN a staff message does not match a structured command, THE AuthPilot SHALL route the message to the Conversational_Fallback defined in Requirement 44.

### Requirement 35: WhatsApp Staff Notifications

**User Story:** As a staff member, I want AuthPilot to notify me on WhatsApp about the cases that need my attention, so that I can respond promptly from anywhere.

#### Acceptance Criteria

1. WHEN a Case is created from a patient WhatsApp message, THE AuthPilot SHALL send a staff notification WhatsApp_Message to the registered Staff_Number indicating a new Case was created.
2. WHEN a Case reaches status "AwaitingApproval", THE AuthPilot SHALL send a staff notification WhatsApp_Message indicating the recommendation is ready, containing a one-line Decision_Intelligence summary and the overall Confidence_Score.
3. WHEN a Case SLA_Clock deadline is approaching, THE AuthPilot SHALL send a staff notification WhatsApp_Message indicating the approaching deadline.
4. WHEN the Verification_QA stage flags an issue requiring manual review for a Case, THE AuthPilot SHALL send a staff notification WhatsApp_Message indicating that the Case requires manual review.

### Requirement 36: WhatsApp Channel Audit and Data

**User Story:** As a compliance-conscious operator, I want every WhatsApp message and every channel-originated action recorded in the same audit trail as the in-app flow, so that the audit trail has no channel-shaped gap.

#### Acceptance Criteria

1. WHEN AuthPilot sends or receives a WhatsApp_Message, THE AuthPilot SHALL record the message with its direction, sender, role, content, message type, timestamp, and linked Case where applicable.
2. WHEN a WhatsApp-originated domain action occurs, THE AuthPilot SHALL write the same Trace_Step and Audit_Chain entries defined in Requirement 25 that the equivalent in-app action writes.
3. THE AuthPilot SHALL keep PHI and case-specific detail within the AuthPilot application and generated PDFs, and SHALL carry only triggers, generic PHI-free status, and staff approvals over the WhatsApp_Channel.

### Requirement 37: Voice Transcript Intake

**User Story:** As a front-office staff member, I want to submit a phone call transcript, so that AuthPilot works the case the same way it works any other intake.

#### Acceptance Criteria

1. WHEN a Voice_Transcript is submitted, THE AuthPilot SHALL create an Intake of type "phone_note" from the Voice_Transcript and run the normal agent pipeline as it does for any other Intake.
2. THE AuthPilot SHALL treat the Voice_Transcript intake as a transcript path only and SHALL NOT require any real-time media or telephony processing.

### Requirement 38: Configuration Validation

**User Story:** As an operator, I want AuthPilot to validate its configuration at startup and fail fast on problems, so that misconfiguration is caught immediately and secrets are never exposed.

#### Acceptance Criteria

1. WHEN AuthPilot starts, THE AuthPilot SHALL validate the required App_Configuration keys.
2. IF a required App_Configuration key is missing or invalid at startup, THEN THE AuthPilot SHALL fail fast and return a message identifying each missing or invalid key.
3. WHEN AuthPilot validates the WhatsApp_Channel keys, THE AuthPilot SHALL treat the four WhatsApp keys as an all-or-nothing group, enabling the WhatsApp_Channel only when all four keys are present and disabling the WhatsApp_Channel otherwise.
4. WHEN AuthPilot logs or summarizes App_Configuration, THE AuthPilot SHALL report only the presence of each secret value and SHALL NOT log any secret value.

### Requirement 39: Data Store Portability

**User Story:** As an operator, I want to run AuthPilot on SQLite by default and switch to PostgreSQL with a single configuration change, so that I can deploy on either data store without code changes.

#### Acceptance Criteria

1. THE AuthPilot SHALL run on SQLite by default.
2. WHERE the App_Configuration datasource provider and connection URL are set to PostgreSQL, THE AuthPilot SHALL run on PostgreSQL through that single configuration change without any change to application logic.

### Requirement 40: Shared Case Action Implementation

**User Story:** As an operator, I want approve, reject, edit, and request-more-evidence to run through one shared implementation, so that the Dashboard and WhatsApp channels always behave identically and can never drift or double-log.

#### Acceptance Criteria

1. THE AuthPilot SHALL implement a single Shared_Case_Action operation `performCaseAction(caseId, actionType, meta)` where actionType is one of approve, reject, edit, or request_more_evidence and meta carries the source ("dashboard" or "whatsapp") and the acting actor.
2. THE AuthPilot SHALL invoke the Shared_Case_Action operation from both the Dashboard action route and the WhatsApp staff-command handler, and SHALL NOT implement any separate case-action logic for either channel.
3. THE AuthPilot SHALL make the Shared_Case_Action operation the sole writer of the "human_action" Trace_Step for the approve, reject, edit, and request_more_evidence transitions.
4. IF a persistence operation fails while the Shared_Case_Action operation executes, THEN THE Shared_Case_Action operation SHALL return a structured failure result with success set to false and a human-readable message, and SHALL NOT propagate an exception to the caller.
5. WHEN the Shared_Case_Action operation is invoked with actionType approve, THE AuthPilot SHALL generate the Appeal_Packet if none exists for the Case, set the Case_Status to "AppealSent", invoke the simulated Submission_And_Tracking step, and return the Appeal_Packet location reference in the result.
6. WHEN the Shared_Case_Action operation is invoked with actionType reject, THE AuthPilot SHALL set the Case_Status to "NeedsHumanInput" and send a staff manual-review notification on the WhatsApp_Channel.
7. WHERE the meta source is "dashboard", WHEN the Shared_Case_Action operation is invoked with actionType edit, THE AuthPilot SHALL apply the edit to the Case recommendation and SHALL NOT change the Case_Status.
8. IF the Shared_Case_Action operation is invoked with actionType edit and the meta source is "whatsapp", THEN THE AuthPilot SHALL refuse the edit with a message and SHALL leave the Case recommendation and Case_Status unchanged.
9. WHEN the Shared_Case_Action operation is invoked with actionType request_more_evidence, THE AuthPilot SHALL append the additional evidence as an Extracted_Field with source type "human_provided", set the Case_Status to "Investigating", and re-invoke the Agent_Runner pipeline as a fire-and-forget re-run consistent with Requirement 16.
10. WHEN the Shared_Case_Action operation changes the Case_Status, THE AuthPilot SHALL apply the change through the Case Status state machine defined in Requirement 28 and SHALL apply the change idempotently consistent with Requirement 26.

### Requirement 41: WhatsApp Media Intake and Quality Gate

**User Story:** As a patient, I want AuthPilot to check my photo or PDF before it uses it, so that I get clear guidance to resend when the file is unreadable instead of a wrongly processed case.

#### Acceptance Criteria

1. WHEN a patient sends an image or PDF over the WhatsApp_Channel, THE AuthPilot SHALL run a quality/type check that produces a Media_Quality_Result before any text extraction is used for intake.
2. WHEN the quality/type check classifies a file as not usable, THE AuthPilot SHALL set the Media_Quality_Result reason to one of "blurry", "too_dark", "cropped", "not_a_document", or "wrong_document_type".
3. IF the Media_Quality_Result is not usable, THEN THE AuthPilot SHALL reply on the WhatsApp_Channel with corrective guidance specific to the Media_Quality_Result reason and SHALL NOT create a Case.
4. WHEN the Media_Quality_Result is usable, THE AuthPilot SHALL extract the file text and route the extracted text through the same intake path as an inbound text message.
5. IF the quality/type check or extraction fails with an error, THEN THE AuthPilot SHALL treat the file as not usable and SHALL NOT proceed with extraction results.
6. WHEN more than one media file arrives in a single delivery, THE AuthPilot SHALL use the relevant document or documents for intake and SHALL disregard clearly unrelated files.

### Requirement 42: Emergency Language Short-Circuit

**User Story:** As a patient, I want AuthPilot to react instantly when I describe an emergency, so that I am directed to emergency care before anything else happens.

#### Acceptance Criteria

1. WHEN inbound patient text matches Emergency_Language, THE AuthPilot SHALL reply on the WhatsApp_Channel directing the patient to call emergency services or go to the emergency room.
2. WHEN inbound patient text matches Emergency_Language, THE AuthPilot SHALL raise an urgent Handoff_Request consistent with Requirement 43.
3. WHEN inbound patient text matches Emergency_Language, THE AuthPilot SHALL short-circuit all other patient-message handling for that message so that no Case is created or mutated from it.
4. THE AuthPilot SHALL detect Emergency_Language using deterministic rules without invoking any language model.

### Requirement 43: Human Handoff

**User Story:** As a patient, I want to reach a real person when I ask or when there is an emergency, so that a staff member follows up with me directly.

#### Acceptance Criteria

1. WHEN a patient explicitly requests a human over the WhatsApp_Channel, THE AuthPilot SHALL record a Handoff_Request carrying the patient phone number, an optional linked Case, a reason, and an urgent flag.
2. WHEN an emergency is detected consistent with Requirement 42, THE AuthPilot SHALL record a Handoff_Request with the urgent flag set.
3. WHEN a Handoff_Request is recorded, THE AuthPilot SHALL send a staff notification on the WhatsApp_Channel identifying the handoff request.
4. WHERE a Handoff_Request has the urgent flag set, THE AuthPilot SHALL flag the corresponding staff notification as urgent.

### Requirement 44: WhatsApp Conversational Fallback

**User Story:** As a patient or staff member, I want AuthPilot to answer general questions helpfully within safe limits, so that unstructured messages get a useful reply without exposing protected detail or taking unintended action.

#### Acceptance Criteria

1. WHEN an inbound WhatsApp_Message does not match a structured staff command, a clear new-case trigger, or a status query, THE AuthPilot SHALL route the message to the Conversational_Fallback.
2. WHERE the sender is a patient, THE Conversational_Fallback MAY explain general concepts, process, and timelines in general terms, acknowledge frustration, and ask a clarifying question.
3. WHERE the sender is a patient, THE Conversational_Fallback SHALL NOT state any specific denial reason, diagnosis, procedure code, dollar amount, or policy detail.
4. WHERE the sender is a patient, THE Conversational_Fallback SHALL NOT give medical advice and SHALL redirect medical questions to the patient's physician.
5. WHERE the sender is a patient, THE Conversational_Fallback SHALL NOT promise a case outcome.
6. WHERE the sender is a registered Staff_Number, THE Conversational_Fallback MAY explain a Case's decision reasoning, status, and the AuthPilot decision thresholds.
7. WHERE the sender is a registered Staff_Number, THE Conversational_Fallback SHALL NOT perform any case action from free text and SHALL NOT guess a case identifier that was not clearly provided.

### Requirement 45: WhatsApp Staff Free-Text Action Guardrail

**User Story:** As a staff member, I want AuthPilot to refuse to act on ambiguous free-text instructions, so that every case action is traceable and no case is acted on by accident.

#### Acceptance Criteria

1. IF a staff message expresses an intent to act on a Case, such as approving, sending, or rejecting, without using the exact structured command format, THEN THE AuthPilot SHALL refuse to perform the action.
2. WHEN the AuthPilot refuses a free-text action per this requirement, THE AuthPilot SHALL reply asking the staff member to use the structured command format Approve <case-id> or Reject <case-id>.
3. IF a staff message expresses an ambiguous intent to act, THEN THE AuthPilot SHALL take no case action from that message.

### Requirement 46: Unsupported Inbound Message Types

**User Story:** As a sender, I want AuthPilot to tell me how to resend when I send an unsupported message type, so that I know how to get my request processed.

#### Acceptance Criteria

1. WHEN an inbound WhatsApp_Message is of an unsupported type, including audio, video, location, sticker, contacts, or an otherwise unrecognized type, THE AuthPilot SHALL reply asking the sender to resend the content as text, a photo, or a PDF.
2. WHEN an inbound WhatsApp_Message is of an unsupported type, THE AuthPilot SHALL NOT create a Case and SHALL NOT mutate an existing Case from that message.

### Requirement 47: Ambiguous Short Reply Clarification

**User Story:** As a patient, I want AuthPilot to ask what I mean when I send a short or unclear message, so that it does not open a new case from a stray reply.

#### Acceptance Criteria

1. WHEN a patient sends a short or ambiguous message that has no clear referent and there is no open Case context for that patient, THE AuthPilot SHALL reply with a clarifying question.
2. WHEN a patient sends a short or ambiguous message with no clear referent and no open Case context, THE AuthPilot SHALL NOT create a new Case from that message.
