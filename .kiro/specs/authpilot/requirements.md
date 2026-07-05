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
- **Case_Status**: One of New, Investigating, NeedsHumanInput, AwaitingApproval, AppealSent, Resolved, DeniedFinal.
- **SLA_Clock**: The per-Case countdown to the CMS 2026 deadline (7 days standard, 72 hours urgent).
- **Audit_Trail**: The complete chronological record of a Case merging extracted fields, trace steps, and human actions.
- **Dashboard**: The Kanban home page (`/`) grouping cases by status with an analytics widget.
- **Analytics_Page**: The `/analytics` page presenting denial-intelligence charts.
- **Operator**: A front-office/billing staff member or physician who uses AuthPilot.

## Requirements

### Requirement 1: Intake Ingestion

**User Story:** As a billing staff member, I want to submit a messy denial letter, referral request, or patient phone note, so that AuthPilot can start working the case for me.

#### Acceptance Criteria

1. WHEN an Operator submits Intake text with a selected intake type of "denial_letter", "new_pa_request", or "phone_note", THE AuthPilot SHALL create a new Case with status "New" and store the raw Intake text.
2. WHEN an Operator uploads a PDF denial letter, THE AuthPilot SHALL extract the text content from the PDF and store it as the Case raw Intake text.
3. IF an Operator submits an Intake with empty text and no uploaded file, THEN THE AuthPilot SHALL reject the submission and return a validation message identifying the missing intake content.
4. IF an Operator submits an Intake without selecting an intake type, THEN THE AuthPilot SHALL reject the submission and return a validation message identifying the missing intake type.
5. WHEN a Case is created from an Intake, THE AuthPilot SHALL return the Case identifier to the Operator immediately without waiting for the agent run to complete.
6. WHEN a Case is created from an Intake, THE AuthPilot SHALL redirect the Operator to the Case Detail page for that Case identifier.

### Requirement 2: Entity Resolution

**User Story:** As a billing staff member, I want AuthPilot to identify the patient, payer, codes, and denial reason from unstructured text, so that I do not have to re-type case details.

#### Acceptance Criteria

1. WHEN the Agent_Runner processes a Case Intake, THE Agent_Runner SHALL extract the patient, payer, procedure code, diagnosis code, and denial reason as Extracted_Field records.
2. WHEN the Agent_Runner creates an Extracted_Field, THE Agent_Runner SHALL store the field name, extracted value, Confidence_Score, source type, reasoning, and timestamp.
3. WHERE an entity value cannot be determined from available sources, THE Agent_Runner SHALL record the Extracted_Field with a value of "unknown" and a Confidence_Score of 0.
4. WHEN the Agent_Runner extracts an entity value, THE Agent_Runner SHALL set the source type to one of "raw_intake", "chart_note", "payer_policy", or "code_lookup".

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

1. WHEN a Case is created, THE AuthPilot SHALL set the SLA_Clock deadline to 7 days from creation for a standard Case and 72 hours from creation for an urgent Case.
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

1. WHEN an Operator opens the Analytics_Page, THE AuthPilot SHALL display a chart of denial reasons grouped by payer.
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

### Requirement 23: Pipeline Data Persistence

**User Story:** As a compliance-conscious operator, I want the strategy and verification outputs stored on the case, so that the full multi-stage reasoning is auditable.

#### Acceptance Criteria

1. WHEN the Strategy stage produces Strategy_Options for a Case, THE AuthPilot SHALL persist the Strategy_Options on that Case as a structured field that retains each candidate appeal approach with its win-probability estimate and is retrievable independently of the existing recommendation.
2. WHEN the Verification_QA stage produces a Verification_Result for a Case, THE AuthPilot SHALL persist the Verification_Result on that Case as a structured field that retains the pass or fail status and the complete list of flagged issues and is retrievable independently of the existing recommendation.
3. THE AuthPilot SHALL restrict a Trace_Step step type to exactly one of the following seven values: "tool_call", "decision", "human_action", "medical_review", "policy_review", "strategy", or "verification".
4. WHEN an Operator opens the Audit Trail for a Case, THE AuthPilot SHALL return the persisted Strategy_Options and Verification_Result for that Case unchanged from the values stored by the Strategy stage and the Verification_QA stage.
5. IF persistence of the Strategy_Options or the Verification_Result for a Case fails, THEN THE AuthPilot SHALL record a Trace_Step describing the failure and SHALL retain the existing Case recommendation without overwriting it.
6. IF a Trace_Step is created with a step type outside the seven allowed values, THEN THE AuthPilot SHALL reject the Trace_Step and record an error indication identifying the invalid step type.
