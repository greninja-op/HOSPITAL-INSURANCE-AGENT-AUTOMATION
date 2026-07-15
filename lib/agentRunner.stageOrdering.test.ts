/**
 * lib/agentRunner.stageOrdering.test.ts
 *
 * Property test (Task 11.27) — Property 36: Pipeline stage ordering.
 *
 * Feature: authpilot.
 *
 *   *For any* completed agent run, when each executed `Pipeline_Stage` is keyed
 *   by the EARLIEST timestamp among its `Trace_Step`s, those keys are
 *   non-decreasing in the stage order
 *     Intake_And_Extraction
 *       ≤ {Medical_Review, Policy_Review}   (these two may interleave)
 *       ≤ Strategy
 *       ≤ Decision_Intelligence
 *       ≤ Appeal_Generation
 *       ≤ Verification_QA
 *       ≤ Human_Approval
 *       ≤ Submission_And_Tracking.
 *
 * **Validates: Requirements 20.1**
 *
 * Strategy (mirrors lib/agentRunner.verificationGate.test.ts): the stage
 * sequencing lives in `runAgent` (`lib/agentRunner.ts`), which exposes no `deps`
 * seam, so this drives the REAL pipeline end to end against an isolated,
 * throwaway PostgreSQL schema (`createTestDb`) and reads back the persisted
 * `Trace_Step`s in chronological order (exactly as the trace route does,
 * `orderBy: { timestamp: "asc" }`). Only the network / side-effecting seams are
 * replaced with deterministic fakes so the ordering is exercised without the
 * live Qwen model or real PDF I/O:
 *
 *   • `./qwen`.callQwen — a FAKE that completes every stage on its first
 *     iteration with valid-but-empty JSON content (`"{}"`), so no network, no
 *     API key and no real timers are needed and every stage runs.
 *   • `./decisionEngine`.decide — mocked to FORCE the sampled Resolution_Path
 *     (and its derived Case_Status), so runs traverse all drafting/escalation
 *     paths deterministically. Every other export is preserved via importActual.
 *   • `./appealPdf`.generateAppealPdf — stubbed to return a fake url (no PDF is
 *     rendered or written).
 *
 * Each pipeline stage body writes at least one Trace_Step whose `reasoning`
 * begins with a `[Stage_Name]` label, so a Trace_Step is attributed to its
 * stage by that leading label (unambiguous — unlike a bare substring match,
 * which the Decision_Intelligence step defeats by naming the upstream stages in
 * its prose). Uses Vitest + fast-check (numRuns 100), consistent with the suite.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type { CaseStatus, PipelineStage, QwenOutcome, ResolutionPath } from "./types";

// ─── Hoisted controller shared with the module mocks ──────────────────────────
//
// `vi.mock` factories are hoisted above imports, so the mutable state they close
// over must be created with `vi.hoisted`. Each sample sets `controller.decision`
// (the FORCED Decision_Engine result) before invoking `runAgent`.
const controller = vi.hoisted(() => ({
  decision: null as { path: string; status: string } | null,
}));

// FAKE Qwen: every stage completes immediately (no tool calls). Content "{}" is
// valid JSON so the JSON-parsing stages degrade cleanly to their empty/fallback
// shapes and the prose stages use it as their assessment text — every stage
// runs and emits its stage-labeled Trace_Step.
vi.mock("./qwen", async (importActual) => {
  const actual = await importActual<typeof import("./qwen")>();
  return {
    ...actual,
    callQwen: async (): Promise<QwenOutcome> => ({
      ok: true as const,
      toolCalls: [],
      content: "{}",
    }),
  };
});

// FORCE the Resolution_Path so runs traverse every path deterministically.
// Preserve `computeOverallConfidence` and everything else via importActual.
vi.mock("./decisionEngine", async (importActual) => {
  const actual = await importActual<typeof import("./decisionEngine")>();
  return {
    ...actual,
    decide: () => controller.decision,
  };
});

// Stub the generate-appeal-PDF tool: return a fake url — no PDF is rendered or
// written. Preserve every other `./appealPdf` export.
vi.mock("./appealPdf", async (importActual) => {
  const actual = await importActual<typeof import("./appealPdf")>();
  return {
    ...actual,
    generateAppealPdf: async (caseId: string) => ({
      url: `/appeals/${caseId}.pdf`,
    }),
  };
});

let testDb: TestDb;
let prisma: PrismaClient;
let runAgent: typeof import("./agentRunner").runAgent;

beforeAll(async () => {
  // Provision an isolated schema and bind its client as the shared singleton
  // BEFORE importing the runner, so `runAgent` and `createTraceStep` write to it.
  testDb = await createTestDb();
  prisma = testDb.prisma;
  process.env.DATABASE_URL = testDb.databaseUrl;
  (globalThis as unknown as { prisma?: PrismaClient }).prisma = prisma;

  const runner = await import("./agentRunner");
  runAgent = runner.runAgent;
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

// ─── Stage ordering model (design Property 36 / Req 20.1) ─────────────────────

/**
 * The required relative rank of each stage. Medical_Review and Policy_Review
 * share a rank because they run concurrently and may interleave (Req 20.2), so
 * either may carry the smaller earliest-timestamp.
 */
const STAGE_RANK: Record<PipelineStage, number> = {
  Intake_And_Extraction: 0,
  Medical_Review: 1,
  Policy_Review: 1,
  Strategy: 2,
  Decision_Intelligence: 3,
  Appeal_Generation: 4,
  Verification_QA: 5,
  Human_Approval: 6,
  Submission_And_Tracking: 7,
};

const ALL_STAGES = Object.keys(STAGE_RANK) as PipelineStage[];

/** The stages `runAgent` always drives to completion (Human_Approval and
 * Submission_And_Tracking are driven by the /action route + SLA tracker, so
 * they never appear in a `runAgent`-only trace). */
const PIPELINE_STAGES: PipelineStage[] = [
  "Intake_And_Extraction",
  "Medical_Review",
  "Policy_Review",
  "Strategy",
  "Decision_Intelligence",
  "Appeal_Generation",
  "Verification_QA",
];

/**
 * Attribute a Trace_Step to a Pipeline_Stage by its leading `[Stage_Name]`
 * label (the label every stage body prefixes onto its reasoning). Returns null
 * for steps with no leading stage label (e.g. `dispatchTool`'s tool_call steps
 * or the escalation `decision` step written by the orchestrator).
 */
function stageOf(reasoning: string): PipelineStage | null {
  const match = /^\[([A-Za-z_]+)\]/.exec(reasoning);
  if (!match) return null;
  const label = match[1] as PipelineStage;
  return label in STAGE_RANK ? label : null;
}

/**
 * Key each executed stage by the earliest Trace_Step timestamp attributed to
 * it, over the Case's Trace_Steps read back in chronological order.
 */
async function earliestStageTimestamps(
  caseId: string,
): Promise<Map<PipelineStage, number>> {
  const steps = await prisma.traceStep.findMany({
    where: { caseId },
    orderBy: { timestamp: "asc" }, // chronological — the canonical read-back order
    select: { reasoning: true, timestamp: true },
  });

  const earliest = new Map<PipelineStage, number>();
  for (const step of steps) {
    const stage = stageOf(step.reasoning);
    if (!stage) continue;
    const t = step.timestamp.getTime();
    const prev = earliest.get(stage);
    if (prev === undefined || t < prev) earliest.set(stage, t);
  }
  return earliest;
}

// ─── Seeding / generators ─────────────────────────────────────────────────────

/** Seed a fresh, independent Case (status New) for one sample. */
async function seedCase(
  intakeType: string,
  rawIntakeText: string,
  urgent: boolean,
): Promise<string> {
  const kase = await prisma.case.create({
    data: {
      intakeType,
      rawIntakeText: rawIntakeText.trim() === "" ? "intake" : rawIntakeText,
      status: "New",
      isUrgent: urgent,
      slaDeadline: new Date("2099-01-01T00:00:00.000Z"),
    },
    select: { id: true },
  });
  return kase.id;
}

/** The Case_Status the Decision_Engine derives for a path (mirrors decisionEngine). */
function statusForPath(path: ResolutionPath): CaseStatus {
  return path === "Escalate_To_Human" ? "NeedsHumanInput" : "AwaitingApproval";
}

const resolutionPathArb: fc.Arbitrary<ResolutionPath> = fc.constantFrom(
  "Auto_Draft",
  "Draft_And_Request_Evidence",
  "Escalate_To_Human",
);
const intakeTypeArb = fc.constantFrom(
  "denial_letter",
  "new_pa_request",
  "phone_note",
  "whatsapp_patient_note",
);
const rawIntakeArb = fc.string({ minLength: 1, maxLength: 120 });

/**
 * Assert the earliest-timestamp keys are non-decreasing in the stage order:
 * for every pair of executed stages A, B with rank(A) < rank(B), key(A) ≤ key(B)
 * (equality allowed — Medical_Review/Policy_Review share a rank and may
 * interleave). This is exactly design Property 36 / Requirement 20.1.
 */
function assertNonDecreasing(earliest: Map<PipelineStage, number>): void {
  const executed = ALL_STAGES.filter((s) => earliest.has(s));
  for (const a of executed) {
    for (const b of executed) {
      if (STAGE_RANK[a] < STAGE_RANK[b]) {
        expect(earliest.get(a)!).toBeLessThanOrEqual(earliest.get(b)!);
      }
    }
  }
}

// ─── Property 36 ──────────────────────────────────────────────────────────────

describe("runAgent — pipeline stage ordering (Task 11.27, Property 36)", () => {
  it(
    "orders each stage's earliest Trace_Step timestamp in the required stage order (Req 20.1)",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          resolutionPathArb,
          intakeTypeArb,
          rawIntakeArb,
          fc.boolean(),
          async (path, intakeType, rawIntakeText, urgent) => {
            const caseId = await seedCase(intakeType, rawIntakeText, urgent);
            controller.decision = { path, status: statusForPath(path) };

            await runAgent(caseId);

            const earliest = await earliestStageTimestamps(caseId);

            // Every pipeline stage `runAgent` drives ran and emitted a labeled
            // Trace_Step (Req 20.5) — so the ordering key is well defined.
            for (const stage of PIPELINE_STAGES) {
              expect(earliest.has(stage)).toBe(true);
            }

            // Property 36 — keys are non-decreasing in stage order.
            assertNonDecreasing(earliest);
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});

// ─── Focused examples (deterministic, illustrative) ───────────────────────────

describe("runAgent — pipeline stage ordering (representative examples)", () => {
  it("a drafting run sequences all seven pipeline stages in order", async () => {
    const caseId = await seedCase("denial_letter", "a denial to appeal", false);
    controller.decision = { path: "Auto_Draft", status: "AwaitingApproval" };

    await runAgent(caseId);

    const earliest = await earliestStageTimestamps(caseId);

    // Intake is strictly first; both reviews come after Intake and before
    // Strategy; the tail is strictly ordered.
    const intake = earliest.get("Intake_And_Extraction")!;
    const medical = earliest.get("Medical_Review")!;
    const policy = earliest.get("Policy_Review")!;
    const strategy = earliest.get("Strategy")!;
    const decision = earliest.get("Decision_Intelligence")!;
    const appeal = earliest.get("Appeal_Generation")!;
    const verification = earliest.get("Verification_QA")!;

    expect(intake).toBeLessThanOrEqual(medical);
    expect(intake).toBeLessThanOrEqual(policy);
    expect(medical).toBeLessThanOrEqual(strategy);
    expect(policy).toBeLessThanOrEqual(strategy);
    expect(strategy).toBeLessThanOrEqual(decision);
    expect(decision).toBeLessThanOrEqual(appeal);
    expect(appeal).toBeLessThanOrEqual(verification);
  });

  it("an escalation run still records the stages it runs in order", async () => {
    const caseId = await seedCase("phone_note", "a low-confidence case", false);
    controller.decision = { path: "Escalate_To_Human", status: "NeedsHumanInput" };

    await runAgent(caseId);

    const earliest = await earliestStageTimestamps(caseId);
    for (const stage of PIPELINE_STAGES) {
      expect(earliest.has(stage)).toBe(true);
    }
    assertNonDecreasing(earliest);
  });
});
