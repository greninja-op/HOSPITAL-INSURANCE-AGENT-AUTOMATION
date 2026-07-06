// =============================================================================
// prisma/seed.ts
//
// AuthPilot demo seed (Requirement 18). Populates the database with realistic,
// deliberately-messy demo data so the app looks alive and can be reliably reset
// between run-throughs:
//
//   • ≥3 Payers, each with ≥2 LCD-style Payer_Policy records, and with at least
//     two payers sharing the SAME procedureCode so the multi-payer policy
//     comparison view has data (Req 18.1).
//   • 6–8 Patients, each with 1–3 Chart_Notes, including at least one stale note
//     (>90 days old), one mismatched diagnosis code, and one missing-evidence
//     reference (Req 18.2).
//   • 4–5 Cases spanning different Case_Status values (Req 18.3) with at least
//     one Case per Resolution_Path: Auto_Draft, Draft_And_Request_Evidence,
//     Escalate_To_Human (Req 18.4).
//
// The seed is idempotent: it clears the demo dataset (children first to respect
// foreign keys) and re-inserts it, so it is safe to re-run and is reused by the
// POST /api/demo/reset control (Req 18.5).
//
// Uses the SHARED, generated Prisma client from lib/db.ts so scripts and the app
// speak to the database exactly the same way. Run from the project root:
//   npx tsx prisma/seed.ts        (or: npm run prisma:seed)
// with DATABASE_URL set (see .env).
// =============================================================================

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db";
import { slaDeadline } from "../lib/sla";
import type {
  CaseStatus,
  IntakeType,
  Recommendation,
  ResolutionPath,
  SourceType,
  StrategyOptions,
  VerificationResult,
} from "../lib/types";

/** Cast a typed JSON payload to the Prisma input JSON type for a `Json` column. */
function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** Milliseconds in one day, for readable relative dates. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** A date `days` in the past from `now`. */
function daysAgo(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/** Summary of what the seed inserted, returned to callers (e.g. reset route). */
export interface SeedSummary {
  payers: number;
  payerPolicies: number;
  patients: number;
  chartNotes: number;
  cases: number;
  extractedFields: number;
}

// =============================================================================
// clearDemoData — remove every demo/mutable row, children before parents.
//
// Order matters because of foreign-key constraints. Case-scoped audit/channel
// rows and the idempotency/dedupe/handoff tables are cleared too so a reset
// yields a pristine, reproducible dataset (Req 18.5).
// =============================================================================
export async function clearDemoData(): Promise<void> {
  // Case-scoped children (FK → Case).
  await prisma.whatsAppMessage.deleteMany();
  await prisma.traceStep.deleteMany();
  await prisma.extractedField.deleteMany();
  // Standalone mutable tables (no FK relation, keyed by caseId/messageId).
  await prisma.idempotencyKey.deleteMany();
  await prisma.processedMessage.deleteMany();
  await prisma.handoffRequest.deleteMany();
  // Cases (FK → Patient, Payer).
  await prisma.case.deleteMany();
  // Patient-scoped children then parents.
  await prisma.chartNote.deleteMany();
  await prisma.patient.deleteMany();
  // Payer-scoped children then parents.
  await prisma.payerPolicy.deleteMany();
  await prisma.payer.deleteMany();
}

// =============================================================================
// seedDemoData — clear, then insert the full demo dataset. Returns row counts.
// =============================================================================
export async function seedDemoData(): Promise<SeedSummary> {
  const now = new Date();

  await clearDemoData();

  // ─── Payers ────────────────────────────────────────────────────────────────
  // Three payers. Procedure codes 27447 (total knee arthroplasty) and 64483
  // (transforaminal epidural injection) are shared across payers so the
  // multi-payer policy comparison view has real diffs to show (Req 18.1).
  const aetna = await prisma.payer.create({ data: { name: "Aetna" } });
  const uhc = await prisma.payer.create({
    data: { name: "UnitedHealthcare" },
  });
  const bcbs = await prisma.payer.create({
    data: { name: "Blue Cross Blue Shield" },
  });

  await prisma.payerPolicy.createMany({
    data: [
      // Aetna — shares 27447 and 64483 with the other payers.
      {
        payerId: aetna.id,
        policyCode: "LCD L33455",
        procedureCode: "27447",
        criteriaText:
          "Total knee arthroplasty is medically necessary when ALL are met: (1) radiographic evidence of Kellgren-Lawrence grade 3-4 osteoarthritis; (2) documented failure of >=12 weeks of conservative therapy (NSAIDs, physical therapy, activity modification); (3) pain and functional limitation interfering with activities of daily living. Documentation of BMI and smoking status is required.",
      },
      {
        payerId: aetna.id,
        policyCode: "LCD L34567",
        procedureCode: "64483",
        criteriaText:
          "Transforaminal epidural steroid injection is covered when there is radicular pain in a dermatomal distribution corroborated by MRI-confirmed nerve root compression, following at least 4 weeks of conservative management. No more than 3 injections per 6-month period.",
      },
      {
        payerId: aetna.id,
        policyCode: "LCD L35001",
        procedureCode: "70553",
        criteriaText:
          "MRI of the brain without and with contrast is covered for new-onset unexplained neurological deficit, suspected intracranial mass, or persistent headache with red-flag features. Prior non-contrast CT results should be documented when available.",
      },
      // UnitedHealthcare — shares 27447 and 64483.
      {
        payerId: uhc.id,
        policyCode: "UHC-MPG-27447",
        procedureCode: "27447",
        criteriaText:
          "Knee replacement requires: (1) moderate-to-severe osteoarthritis on weight-bearing imaging; (2) at least 3 months of failed non-operative treatment; (3) a completed pre-operative optimization checklist. UnitedHealthcare additionally requires BMI < 40 or a documented weight-management plan.",
      },
      {
        payerId: uhc.id,
        policyCode: "UHC-MPG-64483",
        procedureCode: "64483",
        criteriaText:
          "Transforaminal epidural steroid injections require MRI-confirmed radiculopathy and >=6 weeks of conservative care. Repeat injections require documentation of >=50% pain relief lasting >=6 weeks from the prior injection.",
      },
      // Blue Cross Blue Shield — shares 27447; adds an endoscopy policy.
      {
        payerId: bcbs.id,
        policyCode: "BCBS-CPB-27447",
        procedureCode: "27447",
        criteriaText:
          "Total knee arthroplasty is approved for advanced degenerative joint disease refractory to conservative therapy for a minimum of 8 weeks. Requires radiographic confirmation and a documented functional assessment score.",
      },
      {
        payerId: bcbs.id,
        policyCode: "BCBS-CPB-43239",
        procedureCode: "43239",
        criteriaText:
          "Upper GI endoscopy (EGD) with biopsy is covered for persistent dyspepsia unresponsive to 4-8 weeks of PPI therapy, dysphagia, or alarm features such as weight loss, anemia, or GI bleeding.",
      },
    ],
  });

  const payerPolicyCount = await prisma.payerPolicy.count();

  // ─── Patients + Chart_Notes ─────────────────────────────────────────────────
  // 7 patients, each with 1-3 chart notes. The dataset deliberately embeds
  // messiness required by Req 18.2:
  //   • STALE note   → Margaret Chen's knee note is > 90 days old.
  //   • MISMATCHED dx → James Okafor's note carries M17.11 (right knee OA) while
  //                     his case/intake concern the left knee — a dx mismatch.
  //   • MISSING evidence reference → Priya Nair's note explicitly lacks the
  //     imaging/MRI report the policy requires ("MRI report not on file").
  const patients = [
    {
      name: "Margaret Chen",
      dob: new Date("1955-03-12"),
      payerId: aetna.id,
      notes: [
        {
          // STALE: dated > 90 days ago (Req 18.2).
          noteDate: daysAgo(140, now),
          diagnosisCode: "M17.0",
          content:
            "Bilateral primary osteoarthritis of knees. Kellgren-Lawrence grade 4 on right. Completed 14 weeks PT and NSAIDs without relief. BMI 31. Non-smoker. Candidate for right total knee arthroplasty. NOTE: last imaging is over four months old.",
        },
        {
          noteDate: daysAgo(6, now),
          diagnosisCode: "M17.0",
          content:
            "Follow-up: persistent right knee pain limiting ambulation to one block. Wishes to proceed with surgery. No new imaging obtained this visit.",
        },
      ],
    },
    {
      name: "James Okafor",
      dob: new Date("1968-07-25"),
      payerId: uhc.id,
      notes: [
        {
          // MISMATCHED dx: M17.11 is RIGHT knee OA, but the case concerns the LEFT knee.
          noteDate: daysAgo(20, now),
          diagnosisCode: "M17.11",
          content:
            "Left knee severe osteoarthritis, weight-bearing films show joint-space narrowing. 4 months failed conservative therapy. Coded as M17.11 (right knee) in error on the requisition. BMI 37, enrolled in weight-management program. Requesting left total knee arthroplasty.",
        },
      ],
    },
    {
      name: "Priya Nair",
      dob: new Date("1979-11-02"),
      payerId: aetna.id,
      notes: [
        {
          // MISSING evidence reference: policy needs MRI, note states it is absent.
          noteDate: daysAgo(15, now),
          diagnosisCode: "M54.16",
          content:
            "Lumbar radiculopathy, L5 distribution, 7 weeks of conservative care without adequate relief. Planning transforaminal epidural steroid injection at L5-S1. MRI report not on file — imaging ordered but results not yet available.",
        },
        {
          noteDate: daysAgo(3, now),
          diagnosisCode: "M54.16",
          content:
            "Patient reports ongoing radicular pain down the left leg. Still awaiting MRI results before proceeding.",
        },
      ],
    },
    {
      name: "Robert Alvarez",
      dob: new Date("1961-01-18"),
      payerId: uhc.id,
      notes: [
        {
          noteDate: daysAgo(30, now),
          diagnosisCode: "M17.12",
          content:
            "Left knee osteoarthritis, KL grade 3. Completed 12 weeks PT and NSAIDs. BMI 34. Non-smoker. Radiographs confirm moderate-to-severe degenerative change. Pre-operative optimization checklist complete.",
        },
        {
          noteDate: daysAgo(9, now),
          diagnosisCode: "M17.12",
          content:
            "Cleared by cardiology for elective left total knee arthroplasty. Proceeding with prior authorization.",
        },
      ],
    },
    {
      name: "Yuki Tanaka",
      dob: new Date("1972-05-30"),
      payerId: bcbs.id,
      notes: [
        {
          noteDate: daysAgo(11, now),
          diagnosisCode: "K21.9",
          content:
            "Persistent dyspepsia despite 8 weeks of high-dose PPI therapy. Reports intermittent dysphagia and 4 kg unintentional weight loss. EGD with biopsy recommended.",
        },
      ],
    },
    {
      name: "Fatima Al-Sayed",
      dob: new Date("1984-09-14"),
      payerId: bcbs.id,
      notes: [
        {
          noteDate: daysAgo(45, now),
          diagnosisCode: "M17.0",
          content:
            "Bilateral knee osteoarthritis. Only 3 weeks of documented conservative therapy so far — below the 8-week policy minimum. Advised continued PT and reassessment.",
        },
        {
          noteDate: daysAgo(5, now),
          diagnosisCode: "M17.0",
          content:
            "Now at 8 weeks conservative therapy with limited improvement. Functional assessment score documented. Considering surgical referral.",
        },
      ],
    },
    {
      name: "Daniel O'Brien",
      dob: new Date("1990-12-08"),
      payerId: aetna.id,
      notes: [
        {
          noteDate: daysAgo(2, now),
          diagnosisCode: "R51.9",
          content:
            "New-onset persistent headaches with morning nausea over the past 3 weeks. No prior CT. Neurological exam shows mild left-sided weakness. MRI brain with and without contrast ordered to rule out intracranial mass.",
        },
      ],
    },
  ];

  const patientRecords: { id: string; name: string; payerId: string }[] = [];
  let chartNoteCount = 0;

  for (const p of patients) {
    const created = await prisma.patient.create({
      data: {
        name: p.name,
        dob: p.dob,
        payerId: p.payerId,
        chartNotes: {
          create: p.notes.map((n) => ({
            noteDate: n.noteDate,
            content: n.content,
            diagnosisCode: n.diagnosisCode,
          })),
        },
      },
    });
    patientRecords.push({
      id: created.id,
      name: created.name,
      payerId: created.payerId,
    });
    chartNoteCount += p.notes.length;
  }

  const byName = (name: string) => {
    const rec = patientRecords.find((r) => r.name === name);
    if (!rec) throw new Error(`Seed error: patient "${name}" not created`);
    return rec;
  };

  // ─── Cases ───────────────────────────────────────────────────────────────
  // Five demo Cases spanning five distinct Case_Status values (New,
  // Investigating, NeedsHumanInput, AwaitingApproval, Resolved) — Req 18.3 —
  // with at least one Case designed for EACH Resolution_Path (Req 18.4):
  //   • Auto_Draft                → Robert Alvarez (AwaitingApproval), Yuki Tanaka (Resolved)
  //   • Draft_And_Request_Evidence → Margaret Chen (Investigating)
  //   • Escalate_To_Human          → James Okafor (NeedsHumanInput, contradiction)
  // Priya Nair's Case is freshly created (New) and not yet routed.
  //
  // Each Case carries a few Extracted_Fields so the trace/case views have
  // provenance to show, and the routed Cases carry the Json payloads
  // (recommendation / strategyOptions / verificationResult) the dashboard and
  // analytics render. Denial reasons are set where applicable so the
  // denials-by-payer analytics widget has content for the current month.

  const alvarez = byName("Robert Alvarez");
  const chen = byName("Margaret Chen");
  const okafor = byName("James Okafor");
  const nair = byName("Priya Nair");
  const tanaka = byName("Yuki Tanaka");

  /** Shape of one demo Case, expanded into a `prisma.case.create` below. */
  interface DemoCase {
    patientId: string;
    payerId: string;
    payerName: string;
    intakeType: IntakeType;
    rawIntakeText: string;
    status: CaseStatus;
    isUrgent: boolean;
    createdAt: Date;
    resolvedAt?: Date;
    resolutionPath?: ResolutionPath;
    overallConfidence?: number;
    denialReason?: string;
    requestedEvidence?: string;
    plainEnglishExplanation?: string;
    appealPdfUrl?: string;
    recommendation?: Recommendation;
    strategyOptions?: StrategyOptions;
    verificationResult?: VerificationResult;
    extractedFields: {
      fieldName: string;
      value: string;
      confidence: number;
      sourceType: SourceType;
      reasoning: string;
    }[];
  }

  const demoCases: DemoCase[] = [
    // 1) Auto_Draft — high confidence, verification passes, awaiting approval.
    {
      patientId: alvarez.id,
      payerId: alvarez.payerId,
      payerName: "UnitedHealthcare",
      intakeType: "new_pa_request",
      rawIntakeText:
        "Prior authorization request: left total knee arthroplasty (CPT 27447) for Robert Alvarez. KL grade 3 osteoarthritis, 12 weeks failed conservative therapy, pre-operative optimization complete.",
      status: "AwaitingApproval",
      isUrgent: false,
      createdAt: daysAgo(1, now),
      resolutionPath: "Auto_Draft",
      overallConfidence: 92,
      plainEnglishExplanation:
        "All UnitedHealthcare knee-replacement criteria are met and documented, so AuthPilot drafted the authorization request for a quick human approval.",
      recommendation: {
        headline: "Auto-draft prior authorization for left total knee arthroplasty",
        reason:
          "UHC-MPG-27447 requires moderate-to-severe OA on weight-bearing imaging, >=3 months failed non-operative care, and a completed pre-op optimization checklist. Chart notes document KL grade 3, 12 weeks PT/NSAIDs, and a complete checklist.",
        risk: "Low",
        resolutionPath: "Auto_Draft",
        appealContent: {
          patientName: "Robert Alvarez",
          denialReason: "N/A — new prior authorization request",
          policyClause: "UHC-MPG-27447",
          supportingEvidence: [
            "KL grade 3 osteoarthritis on weight-bearing radiographs",
            "12 weeks failed PT and NSAIDs",
            "Pre-operative optimization checklist complete; cardiology clearance obtained",
          ],
          argument:
            "The documented clinical picture satisfies every element of UHC-MPG-27447 for total knee arthroplasty; authorization is warranted.",
        },
      },
      strategyOptions: {
        options: [
          {
            approach: "Direct medical-necessity authorization citing UHC-MPG-27447",
            winProbability: 90,
            rationale:
              "Every policy element is explicitly documented; the strongest, most direct path.",
          },
          {
            approach: "Peer-to-peer review request emphasizing functional decline",
            winProbability: 70,
            rationale: "Fallback if the initial submission is questioned on documentation.",
          },
        ],
        usedPriorAuthHistory: true,
        payerTrackRecordSummary:
          "UnitedHealthcare approves well-documented TKA authorizations at a high rate when the pre-op checklist is complete.",
      },
      verificationResult: { status: "pass", flaggedIssues: [] },
      extractedFields: [
        {
          fieldName: "patientName",
          value: "Robert Alvarez",
          confidence: 98,
          sourceType: "raw_intake",
          reasoning: "Named explicitly in the prior-authorization request.",
        },
        {
          fieldName: "payer",
          value: "UnitedHealthcare",
          confidence: 96,
          sourceType: "raw_intake",
          reasoning: "Payer identified from the requisition header.",
        },
        {
          fieldName: "procedureCode",
          value: "27447",
          confidence: 97,
          sourceType: "code_lookup",
          reasoning: "CPT 27447 stated in the request and confirmed by code lookup.",
        },
        {
          fieldName: "diagnosisCode",
          value: "M17.12",
          confidence: 94,
          sourceType: "chart_note",
          reasoning: "Left knee osteoarthritis documented in the chart note.",
        },
      ],
    },

    // 2) Draft_And_Request_Evidence — medium confidence, stale imaging gap.
    {
      patientId: chen.id,
      payerId: chen.payerId,
      payerName: "Aetna",
      intakeType: "denial_letter",
      rawIntakeText:
        "Aetna denial: request for right total knee arthroplasty (CPT 27447) for Margaret Chen denied pending current radiographic evidence. Submitted imaging exceeds the acceptable age window.",
      status: "Investigating",
      isUrgent: false,
      createdAt: daysAgo(2, now),
      resolutionPath: "Draft_And_Request_Evidence",
      overallConfidence: 74,
      denialReason: "Insufficient recent imaging",
      requestedEvidence: "Updated weight-bearing knee radiographs obtained within the last 90 days",
      plainEnglishExplanation:
        "The clinical story supports surgery, but the imaging on file is more than four months old. AuthPilot drafted the appeal and flagged that fresh radiographs are needed before submission.",
      recommendation: {
        headline: "Draft appeal and request updated imaging",
        reason:
          "LCD L33455 requires radiographic evidence of KL grade 3-4 OA. Chart notes support the diagnosis, but the most recent imaging is >90 days old, creating an evidence gap.",
        risk: "Medium",
        resolutionPath: "Draft_And_Request_Evidence",
        requestedEvidence: [
          "Weight-bearing knee radiographs within the last 90 days",
        ],
        appealContent: {
          patientName: "Margaret Chen",
          denialReason: "Insufficient recent imaging",
          policyClause: "LCD L33455",
          supportingEvidence: [
            "KL grade 4 osteoarthritis previously documented",
            "14 weeks PT and NSAIDs without relief",
            "BMI 31, non-smoker",
          ],
          argument:
            "The clinical criteria of LCD L33455 are met; refreshed imaging will close the sole outstanding documentation gap.",
        },
      },
      strategyOptions: {
        options: [
          {
            approach: "Request updated radiographs, then resubmit citing LCD L33455",
            winProbability: 78,
            rationale: "Directly resolves the stated denial reason.",
          },
          {
            approach: "Appeal with existing imaging plus a physician attestation",
            winProbability: 45,
            rationale: "Weaker; the imaging-age objection likely stands.",
          },
        ],
        usedPriorAuthHistory: true,
        payerTrackRecordSummary:
          "Aetna commonly reverses imaging-age denials once current radiographs are supplied.",
      },
      verificationResult: { status: "pass", flaggedIssues: [] },
      extractedFields: [
        {
          fieldName: "patientName",
          value: "Margaret Chen",
          confidence: 97,
          sourceType: "raw_intake",
          reasoning: "Named on the denial letter.",
        },
        {
          fieldName: "denialReason",
          value: "Insufficient recent imaging",
          confidence: 90,
          sourceType: "raw_intake",
          reasoning: "Denial rationale quoted from the letter.",
        },
        {
          fieldName: "procedureCode",
          value: "27447",
          confidence: 95,
          sourceType: "code_lookup",
          reasoning: "CPT 27447 referenced in the denial.",
        },
      ],
    },

    // 3) Escalate_To_Human — contradiction (diagnosis laterality mismatch).
    {
      patientId: okafor.id,
      payerId: okafor.payerId,
      payerName: "UnitedHealthcare",
      intakeType: "denial_letter",
      rawIntakeText:
        "UnitedHealthcare denial: left total knee arthroplasty (CPT 27447) for James Okafor. Submitted diagnosis code M17.11 (right knee) does not match the requested left-knee procedure.",
      status: "NeedsHumanInput",
      isUrgent: true,
      createdAt: daysAgo(1, now),
      resolutionPath: "Escalate_To_Human",
      overallConfidence: 52,
      denialReason: "Diagnosis code does not match documented laterality",
      plainEnglishExplanation:
        "The chart says left knee but the diagnosis code on file is for the right knee. Because these conflict, AuthPilot escalated the case to a human to confirm the correct code before anything is submitted.",
      recommendation: {
        headline: "Escalate: diagnosis-code laterality contradiction",
        reason:
          "The requisition codes M17.11 (right knee OA) while the chart note and requested procedure concern the LEFT knee. Contradictions force escalation per the Decision_Engine.",
        risk: "High",
        resolutionPath: "Escalate_To_Human",
      },
      strategyOptions: {
        options: [
          {
            approach: "Correct the diagnosis code to M17.12 and resubmit",
            winProbability: 80,
            rationale:
              "If the left-knee documentation is accurate, a coding correction resolves the denial.",
          },
        ],
        usedPriorAuthHistory: true,
        payerTrackRecordSummary:
          "UnitedHealthcare denials driven by coding errors are routinely overturned once the code is corrected — but the laterality must be confirmed by a human first.",
      },
      verificationResult: {
        status: "fail",
        flaggedIssues: [
          {
            type: "reference_mismatch",
            reference: "M17.11",
            detail:
              "Diagnosis code M17.11 (right knee) conflicts with the left-knee procedure and chart documentation.",
            severity: "blocking",
          },
        ],
      },
      extractedFields: [
        {
          fieldName: "patientName",
          value: "James Okafor",
          confidence: 96,
          sourceType: "raw_intake",
          reasoning: "Named on the denial letter.",
        },
        {
          fieldName: "diagnosisCode",
          value: "M17.11",
          confidence: 88,
          sourceType: "chart_note",
          reasoning:
            "Code present on the requisition; flagged as inconsistent with the left-knee procedure.",
        },
        {
          fieldName: "procedureCode",
          value: "27447",
          confidence: 95,
          sourceType: "code_lookup",
          reasoning: "CPT 27447 (knee arthroplasty) referenced in the denial.",
        },
      ],
    },

    // 4) New — freshly intaked, not yet routed by the Decision_Engine.
    {
      patientId: nair.id,
      payerId: nair.payerId,
      payerName: "Aetna",
      intakeType: "new_pa_request",
      rawIntakeText:
        "Prior authorization request: transforaminal epidural steroid injection (CPT 64483) at L5-S1 for Priya Nair. Lumbar radiculopathy, 7 weeks conservative care.",
      status: "New",
      isUrgent: false,
      createdAt: now,
      extractedFields: [
        {
          fieldName: "patientName",
          value: "Priya Nair",
          confidence: 95,
          sourceType: "raw_intake",
          reasoning: "Named in the prior-authorization request.",
        },
        {
          fieldName: "procedureCode",
          value: "64483",
          confidence: 93,
          sourceType: "code_lookup",
          reasoning: "CPT 64483 (transforaminal epidural injection) stated in the request.",
        },
        {
          fieldName: "diagnosisCode",
          value: "M54.16",
          confidence: 90,
          sourceType: "chart_note",
          reasoning: "Lumbar radiculopathy documented in the chart note.",
        },
      ],
    },

    // 5) Resolved — Auto_Draft that has already completed successfully.
    {
      patientId: tanaka.id,
      payerId: tanaka.payerId,
      payerName: "Blue Cross Blue Shield",
      intakeType: "denial_letter",
      rawIntakeText:
        "Blue Cross Blue Shield denial: upper GI endoscopy with biopsy (CPT 43239) for Yuki Tanaka requires prior authorization. Persistent dyspepsia with alarm features.",
      status: "Resolved",
      isUrgent: false,
      createdAt: daysAgo(10, now),
      resolvedAt: daysAgo(3, now),
      resolutionPath: "Auto_Draft",
      overallConfidence: 88,
      denialReason: "Prior authorization required for EGD",
      appealPdfUrl: "/appeals/demo-egd-appeal.pdf",
      plainEnglishExplanation:
        "The endoscopy is well supported by alarm features and a failed PPI trial, so AuthPilot drafted and submitted the authorization, which was approved.",
      recommendation: {
        headline: "Auto-draft authorization for upper GI endoscopy",
        reason:
          "BCBS-CPB-43239 covers EGD with biopsy for dyspepsia unresponsive to 4-8 weeks of PPI therapy or with alarm features. Chart notes document an 8-week failed PPI trial, dysphagia, and 4 kg weight loss.",
        risk: "Low",
        resolutionPath: "Auto_Draft",
        appealContent: {
          patientName: "Yuki Tanaka",
          denialReason: "Prior authorization required for EGD",
          policyClause: "BCBS-CPB-43239",
          supportingEvidence: [
            "8 weeks failed high-dose PPI therapy",
            "Intermittent dysphagia",
            "4 kg unintentional weight loss (alarm feature)",
          ],
          argument:
            "The documented alarm features and failed PPI trial satisfy BCBS-CPB-43239; the endoscopy is medically necessary.",
        },
      },
      strategyOptions: {
        options: [
          {
            approach: "Cite alarm features (weight loss, dysphagia) under BCBS-CPB-43239",
            winProbability: 92,
            rationale: "Alarm features are the strongest, policy-aligned justification.",
          },
        ],
        usedPriorAuthHistory: true,
        payerTrackRecordSummary:
          "Blue Cross Blue Shield reliably authorizes EGD when alarm features are documented.",
      },
      verificationResult: { status: "pass", flaggedIssues: [] },
      extractedFields: [
        {
          fieldName: "patientName",
          value: "Yuki Tanaka",
          confidence: 97,
          sourceType: "raw_intake",
          reasoning: "Named on the denial letter.",
        },
        {
          fieldName: "procedureCode",
          value: "43239",
          confidence: 96,
          sourceType: "code_lookup",
          reasoning: "CPT 43239 (EGD with biopsy) referenced in the denial.",
        },
        {
          fieldName: "denialReason",
          value: "Prior authorization required for EGD",
          confidence: 91,
          sourceType: "raw_intake",
          reasoning: "Denial rationale quoted from the letter.",
        },
      ],
    },
  ];

  let extractedFieldCount = 0;

  for (const c of demoCases) {
    await prisma.case.create({
      data: {
        patientId: c.patientId,
        payerId: c.payerId,
        payerName: c.payerName,
        intakeType: c.intakeType,
        rawIntakeText: c.rawIntakeText,
        status: c.status,
        isUrgent: c.isUrgent,
        createdAt: c.createdAt,
        resolvedAt: c.resolvedAt ?? null,
        slaDeadline: slaDeadline(c.createdAt, c.isUrgent),
        resolutionPath: c.resolutionPath ?? null,
        overallConfidence: c.overallConfidence ?? null,
        denialReason: c.denialReason ?? null,
        requestedEvidence: c.requestedEvidence ?? null,
        plainEnglishExplanation: c.plainEnglishExplanation ?? null,
        appealPdfUrl: c.appealPdfUrl ?? null,
        recommendation: c.recommendation ? asJson(c.recommendation) : Prisma.JsonNull,
        strategyOptions: c.strategyOptions ? asJson(c.strategyOptions) : Prisma.JsonNull,
        verificationResult: c.verificationResult
          ? asJson(c.verificationResult)
          : Prisma.JsonNull,
        extractedFields: {
          create: c.extractedFields.map((f) => ({
            fieldName: f.fieldName,
            value: f.value,
            confidence: f.confidence,
            sourceType: f.sourceType,
            reasoning: f.reasoning,
          })),
        },
      },
    });
    extractedFieldCount += c.extractedFields.length;
  }

  return {
    payers: 3,
    payerPolicies: payerPolicyCount,
    patients: patientRecords.length,
    chartNotes: chartNoteCount,
    cases: demoCases.length,
    extractedFields: extractedFieldCount,
  };
}

// =============================================================================
// CLI entry point — `npx tsx prisma/seed.ts` or `npx prisma db seed`.
//
// When this module is run directly (not merely imported by the reset route or a
// test) it seeds the database, prints a summary, and disconnects the client.
// =============================================================================
async function main(): Promise<void> {
  const summary = await seedDemoData();
  console.log("AuthPilot demo seed complete:", summary);
}

// `import.meta.url` is unavailable under the CommonJS transpile tsx uses, so we
// detect direct execution via `require.main`. Guard for environments (bundlers,
// ESM) where `require` is not defined so importing this module never crashes.
const isDirectRun =
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module;

if (isDirectRun) {
  main()
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
