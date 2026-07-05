# AUTHPILOT — AUTONOMOUS PRIOR AUTHORIZATION & DENIAL APPEAL AGENT
### Full Build Brief for Kiro Agent (Claude Opus 4.8) — Track 4: Autopilot Agent

---

## 1. APP OVERVIEW

**App name:** AuthPilot
**One-line description:** A Qwen-powered autonomous agent that reads messy insurance denial letters and referral requests, investigates the patient's chart and payer policy, decides whether to auto-resubmit, auto-appeal, or escalate to a human, drafts the appeal packet, and tracks it to resolution — end to end, with a full audit trail.

**Core problem it solves:**
Medical practices lose enormous time and revenue to prior authorization and claim denials. Physicians complete ~39 prior auth requests per week and burn ~13 hours weekly on paperwork; the vast majority of denials (82%) are winnable on appeal, but almost nobody appeals because building a payer-specific, evidence-matched appeal is slow and confusing. As of the 2026 CMS Interoperability & Prior Authorization Final Rule, payers must now give specific denial reasons and decide within 7 days (72 hours if urgent) — so practices that can't respond fast lose the appeal window entirely. AuthPilot acts as an autonomous "prior auth & appeals coordinator" that reads the incoming denial/referral, pulls the right chart data, matches it against payer medical-necessity criteria, decides if it can resolve automatically or needs a human, drafts the appeal, and pushes it toward submission — instead of a human doing all of this by hand.

**Target user:** Front-office / billing staff and physicians at a small-to-mid-size medical practice (the same persona who currently manually tracks prior auths in spreadsheets and re-types denial letters into appeal templates).

---

## 2. FULL FEATURE LIST

### Core (must-have, demo-critical)
1. **Intake ingestion** — accept a messy trigger: a pasted/uploaded denial letter (PDF/text), a referral request, or a "patient called about a denial" free-text note.
2. **Entity resolution** — agent identifies patient, payer, procedure/diagnosis codes, and denial reason from unstructured text (may be incomplete/contradictory — this is intentional).
3. **Multi-source investigation (tool use)** — agent calls tools to: fetch patient chart/EHR record (mock DB), fetch payer policy / LCD medical-necessity criteria (mock policy DB), look up ICD-10/CPT code meaning, check prior auth history for this patient.
4. **Contradiction & gap detection** — agent explicitly flags what's missing or conflicting (e.g., "diagnosis code doesn't match documented symptoms," "chart note is 4 months old," "no imaging report attached").
5. **Confidence-scored decision engine** — agent computes a resolution path with explicit rule logic:
   - High confidence + clear-cut policy match → auto-draft resubmission/appeal for one-click human approval
   - Medium confidence → draft + explicitly ask for one more piece of evidence
   - Low confidence / contradicts policy outright → escalate to human with reasoning, do NOT auto-act
6. **Appeal packet generation** — agent produces an actual downloadable PDF appeal letter citing the specific denial reason, payer policy clause, and supporting chart evidence (never a generic template).
7. **Human-in-the-loop approval screen** — every outbound action (submit appeal, send patient message, resubmit claim) requires explicit human Approve / Edit / Request More Evidence / Reject before "sending" (simulated send in this prototype).
8. **Full audit trail** — every extracted fact stores: source document, extracted value, confidence %, reasoning, timestamp, which tool/agent step produced it, and human approval status. Rendered as a visual timeline per case.
9. **Case dashboard** — Kanban-style view of all cases by status: New → Investigating → Needs Human Input → Awaiting Approval → Appeal Sent → Resolved/Won → Denied Final.
10. **Live agent trace / "show your work" panel** — a real-time log panel showing each tool call, decision, and reasoning step as the agent runs (critical for judges to see it's not a static chatbot).
11. **7-day / 72-hour SLA clock** — each case shows a countdown based on CMS rule deadlines, and the agent proactively flags at-risk cases nearing deadline.

### High-impact (judge-impressing, still build if time allows)
12. **Denial pattern analytics** — dashboard chart of denial reasons by payer over time (shows "operations intelligence," not just single-case handling).
13. **Auto-draft patient-facing plain-English explanation** ("Here's why this was denied and what happens next") shown alongside the technical appeal letter.
14. **What-if replanning** — if the human rejects the agent's recommendation or provides new evidence, the agent re-runs its reasoning and produces an updated recommendation live.
15. **Multi-payer policy diffing** — same procedure, different payer criteria, agent explains why the outcome differs (shows contract/policy contradiction detection).

### Nice-to-have (only if ahead of schedule)
16. Voice/phone transcript intake simulation (patient calls in — paste a transcript, agent extracts the case).
17. Simple email-draft "send to payer portal" simulation button.
18. Exportable case audit trail as PDF for compliance records.

---

## 3. TECH STACK

Keep this simple, fast to scaffold, and demo-reliable. All beginner-friendly, no exotic infra.

**Frontend**
- Next.js 14 (App Router) + React + TypeScript
- Tailwind CSS for styling
- shadcn/ui for components (cards, dialogs, badges, timeline)
- Recharts for the analytics chart
- Framer Motion for subtle transitions (agent trace panel streaming in, status changes)

**Backend**
- Next.js API routes (keep it one repo — no separate backend service needed for a hackathon)
- Node.js runtime

**Database**
- SQLite via Prisma ORM (zero-config, file-based, perfect for hackathon demo; swappable to Postgres later with one env change)

**Agent / LLM layer**
- Qwen (Qwen2.5-72B-Instruct or Qwen-Max) called via **Alibaba Cloud DashScope API** (or OpenRouter as a fallback host if DashScope signup is slow — OpenRouter exposes Qwen models with an OpenAI-compatible schema)
- Custom lightweight agent loop written directly in TypeScript (do NOT reach for a heavy framework like LangChain for a hackathon — implement a simple `plan → tool_call → observe → decide → act` loop manually so judges can see exactly what's happening, and it's easier to debug live)
- Tool-calling implemented via Qwen's native function-calling / tool-use format (OpenAI-compatible `tools` schema)

**Document generation**
- `pdf-lib` (Node) to generate the appeal letter PDF from a template + agent-filled fields

**Mock external systems (all local, seeded — no real payer/EHR integration needed)**
- Mock EHR API (Next.js API route reading from Prisma `Patient`, `ChartNote` tables)
- Mock Payer Policy API (Next.js API route reading from a seeded `PayerPolicy` table containing LCD-style medical necessity criteria)
- Mock ICD-10/CPT lookup (small seeded JSON dictionary — no need for the real NLM API, but if time allows, the free **NIH Clinical Tables API** `https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search` can be used for realistic code lookups)

**Deployment**
- Vercel (frontend + API routes together, one command deploy)

---

## 4. PAGES & USER FLOW

### 1. `/` — Dashboard (Home)
Kanban board of all cases grouped by status column (New / Investigating / Needs Human Input / Awaiting Approval / Appeal Sent / Resolved). Each card shows patient initials, payer, procedure, confidence badge, and SLA countdown. Clicking a card opens the Case Detail page. A "+ New Case" button opens the Intake page. A small analytics widget (denials by payer, this month) sits at the top.

### 2. `/intake` — New Case Intake
A simple form: paste/upload the denial letter or referral text, select intake type (Denial Letter / New PA Request / Patient Phone Note), and hit "Run AuthPilot." This triggers the agent run and redirects to the live Case Detail page where the user watches the agent work in real time.

### 3. `/case/[id]` — Case Detail (the core screen — most of the build effort goes here)
Three-panel layout:
- **Left panel — Case Facts:** structured fields the agent extracted (patient, payer, procedure, diagnosis, denial reason), each with a small confidence % and a "source" tag that expands to show which document/tool produced it.
- **Center panel — Live Agent Trace:** a scrolling timeline of agent steps ("🔍 Fetching patient chart...", "📄 Comparing against Payer XYZ LCD policy L34567...", "⚠️ Contradiction found: chart note date is 4 months old...", "🤖 Decision: escalate to human — confidence 62%"). This is the single most important UI element for the demo.
- **Right panel — Human Action Zone:** the agent's recommendation card (mirrors the "Agent recommendation / Reason / Risk / Human action" pattern below), with buttons: Approve & Send / Edit / Request More Evidence / Reject. Below it, the generated appeal PDF preview with a download button.

### 4. `/case/[id]/audit` — Audit Trail
Full chronological log for the case: every extracted field, every tool call, every decision branch taken, every human action, each with timestamp. Rendered as a vertical timeline. Exportable as PDF.

### 5. `/analytics` — Denial Intelligence
Charts: denial reasons by payer, resolution rate, average time-to-resolution, cases nearing SLA deadline. This page exists mainly to show judges the "operations intelligence" layer, not just single-case handling.

**Navigation:** Persistent left sidebar with Dashboard / New Case / Analytics links, plus a global search by patient name. Top bar shows a live "Agent Status: Idle / Running Case #123" indicator.

---

## 5. UI & DESIGN INSTRUCTIONS

**Overall feel:** Clinical-operations software — trustworthy, calm, precise. Think Linear or Notion crossed with a hospital ops dashboard. NOT playful, NOT consumer-app colorful. Judges should feel "this could run in a real clinic tomorrow."

**Color scheme:**
- Base: near-white background `#FAFAFA`, dark slate text `#1A1D23`
- Primary accent: deep clinical blue `#2563EB` (buttons, active states, links)
- Status colors: New = slate gray `#6B7280`, Investigating = amber `#D97706`, Needs Human Input = red-orange `#EA580C`, Awaiting Approval = blue `#2563EB`, Appeal Sent = purple `#7C3AED`, Resolved/Won = green `#16A34A`, Denied Final = red `#DC2626`
- Confidence badges: green (>85%), amber (60–85%), red (<60%)

**Typography:**
- UI font: Inter (via next/font/google)
- Monospace accents for extracted codes/IDs and the agent trace log: JetBrains Mono — this reinforces "this is real system output, not marketing copy"

**Layout style:**
- Card-based, generous whitespace, 8px-grid spacing
- Rounded corners `rounded-xl`, soft shadows `shadow-sm`, thin 1px borders `border-slate-200`
- The Live Agent Trace panel should look like a terminal/log feed: dark background `#0F172A`, monospace text, each new line animating in with a subtle fade/slide (Framer Motion) as the agent streams reasoning — this single component will do the most work in the demo, invest UI polish here.

**Key components/animations:**
- Kanban cards with a subtle SLA countdown ring (green → amber → red as deadline approaches)
- Agent trace lines stream in token-by-token or line-by-line (simulate streaming even if the backend returns the full trace, to feel "live")
- The human recommendation card should visually mirror this exact pattern (build this as a distinct styled component):
  ```
  🤖 Agent Recommendation: Resubmit with additional documentation
  Reason: Chart note supports medical necessity per LCD L34567 §2.1,
          but imaging report referenced is missing from submission.
  Risk: Medium — payer historically denies incomplete imaging on first pass.
  Human action: [Approve & Send] [Edit] [Request More Evidence] [Reject]
  ```
- Confidence percentages shown as small horizontal bar chips, not just numbers
- Toast notifications for state changes ("Case #114 moved to Awaiting Approval")

Must look polished out of the box — no default unstyled shadcn components; apply the palette/spacing above consistently everywhere.

---

## 6. DATA & APIS

### Data models (Prisma schema)

```prisma
model Patient {
  id            String   @id @default(cuid())
  name          String
  dob           DateTime
  payerId       String
  payer         Payer    @relation(fields: [payerId], references: [id])
  chartNotes    ChartNote[]
  cases         Case[]
}

model ChartNote {
  id          String   @id @default(cuid())
  patientId   String
  patient     Patient  @relation(fields: [patientId], references: [id])
  noteDate    DateTime
  content     String
  diagnosisCode String
}

model Payer {
  id       String   @id @default(cuid())
  name     String
  policies PayerPolicy[]
  patients Patient[]
}

model PayerPolicy {
  id                String  @id @default(cuid())
  payerId           String
  payer             Payer   @relation(fields: [payerId], references: [id])
  policyCode        String  // e.g. "LCD L34567"
  procedureCode     String  // CPT code
  criteriaText      String  // medical necessity criteria, plain text
}

model Case {
  id              String   @id @default(cuid())
  patientId       String
  patient         Patient  @relation(fields: [patientId], references: [id])
  intakeType      String   // "denial_letter" | "new_pa_request" | "phone_note"
  rawIntakeText   String
  status          String   // New, Investigating, NeedsHumanInput, AwaitingApproval, AppealSent, Resolved, DeniedFinal
  slaDeadline     DateTime
  extractedFields ExtractedField[]
  traceSteps      TraceStep[]
  recommendation  Json?
  appealPdfUrl    String?
  createdAt       DateTime @default(now())
}

model ExtractedField {
  id          String   @id @default(cuid())
  caseId      String
  case        Case     @relation(fields: [caseId], references: [id])
  fieldName   String
  value       String
  confidence  Float
  sourceType  String   // "chart_note" | "payer_policy" | "raw_intake" | "code_lookup"
  reasoning   String
  timestamp   DateTime @default(now())
}

model TraceStep {
  id          String   @id @default(cuid())
  caseId      String
  case        Case     @relation(fields: [caseId], references: [id])
  stepType    String   // "tool_call" | "decision" | "human_action"
  toolName    String?
  input       Json?
  output      Json?
  reasoning   String
  timestamp   DateTime @default(now())
}
```

### Free/mock APIs to integrate
- **Qwen via DashScope**: `POST https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions` (OpenAI-compatible schema, use `tools` param for function calling). If access is friction-heavy, fall back to **OpenRouter**: `POST https://openrouter.ai/api/v1/chat/completions` with `model: "qwen/qwen-2.5-72b-instruct"`.
- **NIH Clinical Tables ICD-10 lookup** (free, no key required): `GET https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search?sf=code,name&terms=<query>` — use this for realistic diagnosis code validation instead of a fully mocked list.
- All EHR / payer-policy / claims data is **mocked locally** via the Prisma tables above — there is no real payer API to integrate with for a hackathon, and this is expected/normal for Track 4 (judges care about the agent logic, not real payer connectivity).

### Seed data (must pre-populate on first run via `prisma/seed.ts`)
- 3 Payers: "Aetna", "UnitedHealthcare", "Oscar Health" — each with 2–3 `PayerPolicy` entries with real-style LCD medical-necessity language (use realistic language for procedures like epidural steroid injections, MRI lumbar spine, physical therapy extension, durable medical equipment).
- 6–8 Patients, each with 1–3 `ChartNote` entries — deliberately include messy/contradictory notes (a note dated 5 months ago, a diagnosis code that doesn't quite match symptoms, a missing imaging reference) so the agent has real ambiguity to resolve.
- 4–5 pre-loaded `Case` records in different statuses so the Dashboard looks populated on first load, PLUS the ability to create fresh live cases during the demo.
- At least 2 seed cases specifically designed to demo the three decision branches: one auto-resolvable (high confidence), one needing more evidence (medium confidence), one requiring human escalation (low confidence / policy contradiction).

---

## 7. STEP-BY-STEP BUILD INSTRUCTIONS FOR KIRO AGENT

Follow these steps in order. Do not skip ahead. Verify each step works before moving to the next.

**Step 1 — Project scaffold**
Initialize a Next.js 14 TypeScript project with App Router and Tailwind CSS. Install: `prisma`, `@prisma/client`, `shadcn-ui` (init with the "slate" base color), `recharts`, `framer-motion`, `pdf-lib`, `zod`, `date-fns`. Set up `.env` with `QWEN_API_KEY` and `QWEN_API_BASE` (DashScope compatible-mode URL, or OpenRouter URL as fallback).

**Step 2 — Database & seed**
Create the Prisma schema exactly as specified in Section 6. Run `prisma migrate dev` to create the SQLite DB. Write `prisma/seed.ts` populating all seed data described above (3 payers, 6–8 patients with messy chart notes, 4–5 pre-loaded cases across different statuses covering all three decision branches). Run the seed and verify data exists via `prisma studio`.

**Step 3 — Qwen client wrapper**
Create `lib/qwen.ts`: a typed wrapper function `callQwen(messages, tools?)` that calls the DashScope/OpenRouter chat completions endpoint, supports the `tools` (function-calling) parameter, and returns parsed tool calls or final text. Add basic retry-on-failure logic (2 retries).

**Step 4 — Define agent tools**
Create `lib/agentTools.ts` implementing these callable tools as plain TypeScript functions, each backed by a Prisma query:
- `fetchPatientRecord(patientId)` → returns patient + chart notes
- `fetchPayerPolicy(payerId, procedureCode)` → returns matching LCD policy criteria
- `lookupDiagnosisCode(code)` → calls the NIH Clinical Tables API
- `checkPriorAuthHistory(patientId)` → returns past cases for this patient
- `generateAppealPdf(caseId, content)` → uses pdf-lib to render and save a PDF, returns its URL
Wrap each tool with a matching JSON schema for Qwen's `tools` parameter.

**Step 5 — Build the agent loop**
Create `lib/agentRunner.ts` implementing the core loop:
1. System prompt establishes the agent's role, the decision rules (auto-resolve if confidence > 85% and policy match is clear; request more evidence if 60–85%; escalate to human if < 60% or policy contradiction detected), and instructs it to always cite which document/tool supports each extracted fact.
2. Feed the raw intake text as the first user message.
3. Loop: call Qwen with available tools → if it requests a tool call, execute it via `agentTools.ts`, append the result as a tool message, continue loop → if it returns a final decision, break.
4. At each loop iteration, write a `TraceStep` row to the DB (so the frontend can poll/stream it) and an `ExtractedField` row for every new fact learned.
5. On completion, write the final `recommendation` JSON to the `Case` row, generate the appeal PDF via the tool, and set case `status` per the decision branch reached.
Cap the loop at 8 iterations to avoid runaway calls; if not resolved by then, force escalation to human with a "needs manual review" reasoning.

**Step 6 — API routes**
Build these Next.js API routes:
- `POST /api/cases` — create a new case from intake text, kick off `agentRunner` asynchronously, return case ID immediately
- `GET /api/cases` — list all cases (for dashboard)
- `GET /api/cases/[id]` — full case detail including extracted fields and trace steps
- `GET /api/cases/[id]/trace` — poll endpoint returning trace steps since a given timestamp (used for the "live" streaming feel on the frontend — poll every 1s while status is "Investigating")
- `POST /api/cases/[id]/action` — human action endpoint (approve / edit / request-more-evidence / reject); on "request more evidence," re-invoke `agentRunner` with the new info appended to context and let it re-decide

**Step 7 — Build the Dashboard page**
Implement `/` per Section 4: Kanban columns driven by `case.status`, cards with confidence badges and SLA countdown (computed from `slaDeadline`), analytics widget at top using Recharts fed by a simple aggregation query grouping cases by payer/denial reason.

**Step 8 — Build the Intake page**
Implement `/intake`: textarea + file-type dropdown + submit button that calls `POST /api/cases`, then redirects to `/case/[id]`.

**Step 9 — Build the Case Detail page (highest priority for polish)**
Implement the three-panel layout per Section 4/5. Left panel reads `extractedFields`. Center panel polls `/api/cases/[id]/trace` every second while status is "Investigating" and animates new lines in with Framer Motion, styled as a dark terminal feed. Right panel renders the recommendation card in the exact format shown in Section 5, wires the four action buttons to `POST /api/cases/[id]/action`, and embeds the generated PDF (via an `<iframe>` or download link).

**Step 10 — Build the Audit Trail page**
Implement `/case/[id]/audit` as a vertical timeline merging `extractedFields` and `traceSteps` chronologically, each entry showing source, confidence, reasoning, and timestamp. Add a "Download as PDF" button using the same pdf-lib utility.

**Step 11 — Build the Analytics page**
Implement `/analytics` with 2–3 Recharts visualizations: denials by payer (bar chart), resolution rate over time (line chart), cases nearing SLA deadline (list/table).

**Step 12 — Apply design system**
Go back through every page and apply the exact color palette, fonts (Inter + JetBrains Mono), spacing, and card styles from Section 5. Ensure shadcn components are re-themed via `tailwind.config.ts`, not left default.

**Step 13 — End-to-end test with all three decision branches**
Manually run three fresh cases through `/intake` using messy, realistic denial-letter text you write for: (a) a clean high-confidence case, (b) a medium-confidence case missing one document, (c) a low-confidence case with a genuine policy contradiction. Confirm each reaches the correct status and the trace panel clearly shows the reasoning path.

**Step 14 — Demo polish**
Add a "Reset Demo Data" button (re-runs the seed script) so the app can be reliably reset between judge run-throughs. Write a short `README.md` explaining the workflow, the decision logic, and how to run it locally, for judges who want to inspect the code.

**Step 15 — Deploy**
Deploy to Vercel. Confirm the SQLite file persists correctly for the demo session (acceptable for hackathon scope; note in README that a production version would use Postgres).
