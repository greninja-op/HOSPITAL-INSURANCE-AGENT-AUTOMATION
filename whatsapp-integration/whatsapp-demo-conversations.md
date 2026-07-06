# AuthPilot — Sample WhatsApp Conversations (Demo & Test Scripts)

Use these as literal messages to send to your test/sandbox WhatsApp number.
Each scenario maps to a different branch of the webhook logic and a different
Decision Intelligence outcome, so together they cover your three demo cases
(auto-resolve, needs-evidence, escalate) plus the staff approval flow.

---

## Scenario 1 — Clean case → auto-appeal path (HIGH confidence)

**Patient (inbound, free text):**
> hi this is maria lopez, my insurance (aetna) just denied my mri for my back again. dr patel already sent them everything. i dont understand why they keep saying no

**AuthPilot (outbound, immediate ack):**
> We've received your message about your insurance issue and started reviewing it. We'll update you here as soon as we have next steps.

*(pipeline runs in background — Medical + Policy review find a clean LCD match, Strategy finds high historical overturn rate for this payer/denial-reason combo, Decision Intelligence auto-drafts appeal, case → AwaitingApproval)*

**AuthPilot → Staff (outbound notification):**
> New case AP-114 created from patient message: Maria Lopez. Reply 'Show AP-114' to view.

*(a few seconds later, after pipeline completes)*

**AuthPilot → Staff (outbound notification):**
> Case AP-114 ready for approval: Lumbar MRI denial, Aetna, meets LCD L34567 medical necessity criteria, no missing evidence. Confidence 91%. Reply 'Approve AP-114' or 'Reject AP-114', or open the dashboard.

**Staff (inbound):**
> Approve AP-114

**AuthPilot → Staff (outbound):**
> ✅ Case AP-114 approved. Appeal is being sent now.

**AuthPilot → Patient (outbound, generic):**
> An appeal has been submitted on your behalf. This typically takes a few business days. We'll let you know as soon as we hear back.

---

## Scenario 2 — Missing document → needs-evidence path (MEDIUM confidence)

**Patient (inbound, free text):**
> United healthcare denied my physical therapy extension. i've been going for weeks and it was helping. can you guys do something

**AuthPilot (outbound, immediate ack):**
> We've received your message about your insurance issue and started reviewing it. We'll update you here as soon as we have next steps.

*(pipeline runs — Medical Review finds supportive chart notes but flags the most recent progress note is 6 weeks old; Policy Review finds UHC requires a progress note within 30 days for extension approval; Decision Intelligence → NeedsHumanInput)*

**AuthPilot → Staff (outbound notification):**
> Case AP-115 flagged by verification: progress note on file is 6 weeks old, UHC policy requires a note within 30 days for PT extension approval. Needs manual review before approval.

**Staff (inbound):**
> Status AP-115

**AuthPilot → Staff (outbound):**
> Case AP-115: NeedsHumanInput | Confidence: 63 | 12 day(s) left on deadline.

*(staff uploads a fresh progress note through the dashboard, not WhatsApp — case re-runs, confidence rises, moves to AwaitingApproval, same approval flow as Scenario 1 follows)*

**AuthPilot → Patient (outbound, generic — sent when case first moved to NeedsHumanInput):**
> We need one more document to move your case forward. Please check your patient portal or call our office at (555) 019-2231 for details.

---

## Scenario 3 — Genuine contradiction → escalation path (LOW confidence)

**Patient (inbound, image attachment of a denial letter, poorly lit photo)**

*(caption text, if any): "here's the letter they sent"*

**AuthPilot (outbound, immediate ack):**
> We've received your message about your insurance issue and started reviewing it. We'll update you here as soon as we have next steps.

*(OCR extracts the letter text; Policy Review finds the denial reason cites a diagnosis code that doesn't match anything in the patient's chart at all — likely a payer-side coding error or wrong patient file; Decision Intelligence → escalate, does NOT auto-draft anything)*

**AuthPilot → Staff (outbound notification):**
> Case AP-116 flagged by verification: denial letter cites diagnosis code M54.5 (low back pain), but chart notes on file are for a shoulder injury (M75.1). Possible wrong-patient mixup on payer side. Needs manual review before approval.

**Staff (inbound):**
> Show AP-116

**AuthPilot → Staff (outbound):**
> View case AP-116 here: https://authpilot.app/case/AP-116

*(staff reviews in dashboard, confirms it's a payer error, calls the payer directly — this is correctly a case AuthPilot did NOT try to auto-resolve)*

---

## Scenario 4 — Patient checks status on an existing case (no new case created)

**Patient (inbound, free text, a day after Scenario 1):**
> hi any update on my appeal?

*(webhook matches the status-query pattern, finds Maria's existing open case, does NOT create a duplicate case)*

**AuthPilot (outbound):**
> An appeal has been submitted on your behalf. This typically takes a few business days. We'll let you know as soon as we hear back.

---

## Scenario 5 — Unrecognized staff command (error handling, worth demoing once)

**Staff (inbound):**
> hey can you check on the lopez case

**AuthPilot → Staff (outbound):**
> I didn't recognize that command. Try: 'Approve <case id>', 'Reject <case id>', 'Status <case id>', or 'Show <case id>'.

*(shows judges the system fails gracefully with a helpful hint rather than silently doing nothing or crashing — small detail, good to point out live)*

---

## Suggested live demo order

1. **Scenario 1** end-to-end, live — this is your "wow, it just worked" moment. Send the patient message from your own phone while narrating the trace panel.
2. **Scenario 3** — deliberately show the escalation. Say out loud: "and here's what happens when the agent isn't confident — it doesn't guess, it stops and tells a human exactly why."
3. **Scenario 4**, quickly — shows the system isn't naively creating duplicate cases every time someone texts.
4. Mention Scenario 2 verbally (missing-evidence path) if time is short — you don't need to run every branch live, just prove you have all three.
