// =============================================================================
// lib/agentRunner.ts
//
// Agent_Runner — the ordered nine-stage AuthPilot pipeline (Requirement 20).
//
// This module owns pipeline SCAFFOLDING and STAGE ORCHESTRATION (Task 11.1):
//
//   • `PipelineStage` — the nine ordered stages (re-exported from lib/types).
//   • `runStage(...)` — a reusable, bounded (<= 8 iteration) plan → tool_call →
//     observe cycle that runs under a stage-specific system prompt and the
//     stage's tool allow-list, tagging every Trace_Step it writes with the
//     stage. It NEVER throws for a Qwen_Client failure or a loop cap; it
//     resolves to a structured `StageOutcome` the orchestrator interprets.
//   • `runAgent(caseId, extraContext?)` — sequences the pipeline in order:
//     Intake_And_Extraction → (Medical_Review || Policy_Review) → Strategy →
//     Decision_Intelligence → Appeal_Generation → Verification_QA, persisting
//     each iteration's Trace_Steps before the next call, and returns a
//     `RunResult`.
//
// Cross-cutting control rules wired here (Requirements 6.1–6.4, 6.9, 20.1,
// 20.5, 20.6):
//   • Req 6.1 / 6.2 — the loop runs asynchronously off Case creation; while it
//     runs the Case_Status is `Investigating`.
//   • Req 6.3       — each stage persists its iteration's Trace_Steps before
//     the next Qwen call (`dispatchTool` awaits each `tool_call` Trace_Step).
//   • Req 6.4       — a stage that exhausts its bounded loop without a decision
//     forces `Escalate_To_Human` and records a Trace_Step reasoning
//     "needs manual review".
//   • Req 6.9       — when `callQwen` reports a structured `QwenFailure`, the
//     calling stage degrades gracefully to `Escalate_To_Human`
//     (`NeedsHumanInput`) rather than terminating the run abnormally.
//   • Req 20.6      — if any stage throws, a failure Trace_Step naming the
//     affected stage is recorded, `Escalate_To_Human` is set, and NO
//     subsequent stage runs.
//
// SEAMS: the individual stage BODIES (the real prompts, entity resolution,
// win-probability computation, decision persistence, PDF generation, and
// verification) are deliberately left as thin, clearly-marked seams filled by
// the later tasks (11.5 / 11.7 / 11.9 / 11.13 / 11.15 / 11.18). Each seam here
// records exactly one stage-labeled Trace_Step (so Req 20.5 / stage ordering in
// Req 20.1 hold end to end) and returns a minimal summary. When a later task
// fills a seam, it does so by calling the `runStage` engine below.
// =============================================================================

import { callQwen, type ChatMessage, type ToolSchema } from "./qwen";
import {
  dispatchTool,
  type ToolName,
  type ToolObservation,
} from "./agentTools";
import { createTraceStep, prisma } from "./db";
import { assertTransition } from "./caseStatus";
import type {
  CaseStatus,
  PipelineStage,
  QwenFailure,
  ResolutionPath,
  StepType,
} from "./types";

// Re-export so downstream stage tasks and tests import the stage union from the
// Agent_Runner without reaching into lib/types directly.
export type { PipelineStage } from "./types";

// ─── RunResult (design → Agent_Runner) ───────────────────────────────────────

/** The outcome the Agent_Runner reports to its caller (design shape). */
export interface RunResult {
  resolutionPath: ResolutionPath;
  overallConfidence: number;
  status: CaseStatus;
}

// ─── Loop bound (Requirement 6.4) ────────────────────────────────────────────

/**
 * The hard upper bound on plan → tool_call → observe iterations within a single
 * stage. A stage that reaches this cap without producing a final answer is
 * treated as "exhausted" and forces escalation (Req 6.4).
 */
export const MAX_STAGE_ITERATIONS = 8;

// ─── Stage-scoped tool allow-lists (prompt exposure) ──────────────────────────
//
// `runStage` exposes ONLY the active stage's permitted tools to Qwen. This is
// the "stage's tool allow-list" referenced by Task 11.1: it governs which tool
// schemas are offered to the model per stage. Task 11.3 additionally ENFORCES
// the same allow-list inside `dispatchTool` (refusing + tracing any tool not
// permitted in the active stage). The values mirror the design's STAGE_TOOLS.

const STAGE_TOOL_ALLOWLIST: Record<PipelineStage, readonly ToolName[]> = {
  Intake_And_Extraction: ["lookupDiagnosisCode"],
  Medical_Review: ["fetchPatientRecord"], // Req 3.8 — chart only
  Policy_Review: ["fetchPayerPolicy"], // Req 3.9 — policy only
  Strategy: ["checkPriorAuthHistory", "fetchPayerPolicy"], // history + payer diff (Req 17.3)
  Decision_Intelligence: [], // pure reasoning over summaries (Req 5.2)
  Appeal_Generation: ["generateAppealPdf"],
  Verification_QA: ["fetchPatientRecord", "fetchPayerPolicy"], // re-read to verify (Req 22)
  Human_Approval: [],
  Submission_And_Tracking: [],
};

/**
 * Minimal JSON-schema descriptors for the five existing Agent_Tools, exposed to
 * Qwen via the `tools` parameter. No new tools are introduced for the pipeline
 * (Requirement 20.11) — Strategy / Verification are prompt + scope changes over
 * these same five tools.
 */
const TOOL_SCHEMAS: Record<ToolName, ToolSchema> = {
  fetchPatientRecord: {
    type: "function",
    function: {
      name: "fetchPatientRecord",
      description: "Fetch a patient record and its associated chart notes.",
      parameters: {
        type: "object",
        properties: { patientId: { type: "string" } },
        required: ["patientId"],
      },
    },
  },
  fetchPayerPolicy: {
    type: "function",
    function: {
      name: "fetchPayerPolicy",
      description:
        "Fetch the payer medical-necessity policy matching a procedure code.",
      parameters: {
        type: "object",
        properties: {
          payerId: { type: "string" },
          procedureCode: { type: "string" },
        },
        required: ["payerId", "procedureCode"],
      },
    },
  },
  checkPriorAuthHistory: {
    type: "function",
    function: {
      name: "checkPriorAuthHistory",
      description: "Return the prior-auth case history for a patient.",
      parameters: {
        type: "object",
        properties: { patientId: { type: "string" } },
        required: ["patientId"],
      },
    },
  },
  lookupDiagnosisCode: {
    type: "function",
    function: {
      name: "lookupDiagnosisCode",
      description:
        "Validate a diagnosis code against the NIH Clinical Tables API.",
      parameters: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
    },
  },
  generateAppealPdf: {
    type: "function",
    function: {
      name: "generateAppealPdf",
      description:
        "Render an evidence-cited appeal PDF for the Case and return its URL.",
      parameters: {
        type: "object",
        properties: { content: { type: "object" } },
        required: ["content"],
      },
    },
  },
};

/** Build the ToolSchema[] offered to Qwen for a stage from its allow-list. */
function toolSchemasFor(stage: PipelineStage): ToolSchema[] {
  return STAGE_TOOL_ALLOWLIST[stage].map((name) => TOOL_SCHEMAS[name]);
}

// ─── runStage — the bounded plan → tool_call → observe engine ─────────────────

/**
 * A stage plan handed to `runStage`. The stage BODY (a later task) supplies the
 * stage-specific system prompt, the initial user prompt, and a `finalize`
 * function that folds the model's final text + the tool transcript into the
 * stage's compact summary object.
 */
export interface StagePlan<S> {
  /** The Pipeline_Stage this plan runs as (governs tool scope + labeling). */
  stage: PipelineStage;
  /** Stage-specific system prompt. */
  systemPrompt: string;
  /** Initial user prompt (the Case context the stage reasons over). */
  userPrompt: string;
  /**
   * Fold the final model content + accumulated tool observations into the
   * stage summary consumed downstream.
   */
  finalize: (final: {
    content: string | null;
    observations: ToolObservation[];
  }) => S;
  /** Per-stage iteration cap; hard-capped at `MAX_STAGE_ITERATIONS` (Req 6.4). */
  maxIterations?: number;
}

/**
 * The structured result of running a stage. `runStage` NEVER throws for a
 * Qwen_Client failure or a loop-cap exhaustion — it reports them here so the
 * orchestrator can degrade / escalate deterministically:
 *
 *   • `completed`  — the stage produced a final answer; `summary` is set.
 *   • `degraded`   — `callQwen` reported a structured `QwenFailure`; the caller
 *                    degrades the stage to `Escalate_To_Human` (Req 6.9).
 *   • `exhausted`  — the bounded loop hit its cap without a final answer; the
 *                    caller forces `Escalate_To_Human` with "needs manual
 *                    review" (Req 6.4).
 */
export type StageOutcome<S> =
  | { status: "completed"; summary: S; iterations: number }
  | { status: "degraded"; failure: QwenFailure; iterations: number }
  | { status: "exhausted"; observations: ToolObservation[]; iterations: number };

/** Injectable dependencies for `runStage`, so tests need no network. */
export interface RunStageDeps {
  callQwen?: typeof callQwen;
  dispatchTool?: typeof dispatchTool;
}

/**
 * Run one Pipeline_Stage as a bounded plan → tool_call → observe cycle.
 *
 * The loop, per iteration:
 *   1. calls `callQwen(messages, tools)` with ONLY the stage's allow-listed
 *      tools exposed;
 *   2. if the model requests tool calls, dispatches each through `dispatchTool`
 *      (which records a stage-tagged `tool_call` Trace_Step and returns an
 *      observation), appends the observations, and iterates again — every
 *      Trace_Step is persisted before the next call (Req 6.3);
 *   3. if the model returns a final answer (no tool calls), the stage completes
 *      and `finalize` produces the summary.
 *
 * A `QwenFailure` short-circuits to `degraded` (Req 6.9); reaching the iteration
 * cap without a final answer yields `exhausted` (Req 6.4).
 */
export async function runStage<S>(
  caseId: string,
  plan: StagePlan<S>,
  deps: RunStageDeps = {},
): Promise<StageOutcome<S>> {
  const callModel = deps.callQwen ?? callQwen;
  const dispatch = deps.dispatchTool ?? dispatchTool;
  const cap = Math.min(
    plan.maxIterations ?? MAX_STAGE_ITERATIONS,
    MAX_STAGE_ITERATIONS,
  );
  const tools = toolSchemasFor(plan.stage);

  const messages: ChatMessage[] = [
    { role: "system", content: plan.systemPrompt },
    { role: "user", content: plan.userPrompt },
  ];
  const observations: ToolObservation[] = [];

  let iterations = 0;
  while (iterations < cap) {
    iterations += 1;

    const outcome = await callModel(messages, tools);

    // Qwen_Client failure — degrade gracefully, never terminate abnormally (Req 6.9).
    if (!outcome.ok) {
      return { status: "degraded", failure: outcome, iterations };
    }

    // The model requested tools: dispatch each (tracing them), then observe.
    if (outcome.toolCalls.length > 0) {
      messages.push({ role: "assistant", content: outcome.content });
      for (const call of outcome.toolCalls) {
        // `dispatchTool` records the stage-tagged `tool_call` Trace_Step and
        // is awaited, so each iteration's Trace_Steps persist before the next
        // Qwen call (Req 6.3). It never throws.
        const observation = await dispatch(
          call.name,
          call.arguments,
          caseId,
          plan.stage,
        );
        observations.push(observation);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify(observation),
        });
      }
      continue;
    }

    // Final answer with no tool calls: the stage is done.
    return {
      status: "completed",
      summary: plan.finalize({ content: outcome.content, observations }),
      iterations,
    };
  }

  // Bounded loop exhausted without a final answer (Req 6.4).
  return { status: "exhausted", observations, iterations };
}

// ─── Stage seam scaffolding ───────────────────────────────────────────────────
//
// Each stage BODY is a thin seam here. It records exactly ONE stage-labeled
// Trace_Step (satisfying "every executed stage emits a labeled trace step",
// Req 20.5, and making the stage ordering in Req 20.1 observable) and returns a
// minimal summary. The real stage logic is filled by the owning later task,
// which replaces the seam with a `runStage(...)` call (and stage-specific
// persistence of Extracted_Fields / decisions / PDFs / verification results).

/** SEAM summary placeholder. Later stage tasks specialize this per stage. */
export interface StageSummary {
  stage: PipelineStage;
  /** Compact human-readable note captured by the seam. */
  note: string;
}

/** The stepType each stage uses to label the Trace_Steps it writes. */
const STAGE_STEP_TYPE: Record<PipelineStage, StepType> = {
  Intake_And_Extraction: "tool_call",
  Medical_Review: "medical_review",
  Policy_Review: "policy_review",
  Strategy: "strategy",
  Decision_Intelligence: "decision",
  Appeal_Generation: "tool_call",
  Verification_QA: "verification",
  Human_Approval: "human_action",
  Submission_And_Tracking: "human_action",
};

/** Shared mutable context threaded through the pipeline stages. */
interface StageContext {
  caseId: string;
  extraContext?: string;
  summaries: Partial<Record<PipelineStage, StageSummary>>;
}

/**
 * Record the single stage-labeled Trace_Step for a seam and return its summary.
 * Later tasks replace this body with the real stage implementation (built on
 * `runStage`).
 */
async function runStageSeam(
  ctx: StageContext,
  stage: PipelineStage,
  ownerTask: string,
): Promise<StageSummary> {
  const note = `[${stage}] scaffolding seam — stage body implemented in Task ${ownerTask}.`;
  await createTraceStep({
    caseId: ctx.caseId,
    stepType: STAGE_STEP_TYPE[stage],
    reasoning: note,
  });
  return { stage, note };
}

// The six pipeline-driving stage seams (Human_Approval + Submission_And_Tracking
// are driven by the /action route + SLA tracker, not by runAgent).

/** SEAM — Task 11.5 fills real intake + entity resolution + Safety_Guard screening. */
function intakeAndExtractionStage(ctx: StageContext): Promise<StageSummary> {
  return runStageSeam(ctx, "Intake_And_Extraction", "11.5");
}

/** SEAM — Task 11.7 fills the chart-only Medical_Review body (scoped to fetchPatientRecord). */
function medicalReviewStage(ctx: StageContext): Promise<StageSummary> {
  return runStageSeam(ctx, "Medical_Review", "11.7");
}

/** SEAM — Task 11.7 fills the policy-only Policy_Review body (scoped to fetchPayerPolicy). */
function policyReviewStage(ctx: StageContext): Promise<StageSummary> {
  return runStageSeam(ctx, "Policy_Review", "11.7");
}

/** SEAM — Task 11.9 fills win-probability strategy options over prior-auth history. */
function strategyStage(ctx: StageContext): Promise<StageSummary> {
  return runStageSeam(ctx, "Strategy", "11.9");
}

/** SEAM — Task 11.13 fills the pure Decision_Engine call + decision persistence. */
function decisionIntelligenceStage(ctx: StageContext): Promise<StageSummary> {
  return runStageSeam(ctx, "Decision_Intelligence", "11.13");
}

/** SEAM — Task 11.15 fills conditional appeal-PDF generation on drafting paths. */
function appealGenerationStage(ctx: StageContext): Promise<StageSummary> {
  return runStageSeam(ctx, "Appeal_Generation", "11.15");
}

/** SEAM — Task 11.18 fills the independent citation/reference verification. */
function verificationQaStage(ctx: StageContext): Promise<StageSummary> {
  return runStageSeam(ctx, "Verification_QA", "11.18");
}

// ─── Orchestration helpers ────────────────────────────────────────────────────

/**
 * A normalized settlement of a stage attempt, so the orchestrator can interpret
 * every terminating condition uniformly (and escalate exactly once, even for
 * the concurrent Medical/Policy pair).
 */
type StageSettlement =
  | { kind: "completed"; summary: StageSummary }
  | { kind: "degraded"; failure: QwenFailure }
  | { kind: "exhausted" }
  | { kind: "threw"; message: string };

/**
 * Run a stage thunk and normalize its result. Catches a thrown stage (Req 20.6)
 * and interprets `StageOutcome` degrade/exhaust signals — but performs NO
 * persistence or escalation itself, so the orchestrator stays the single place
 * that halts the pipeline.
 *
 * A seam returns a bare `StageSummary`; a `runStage`-backed body (later tasks)
 * returns a `StageOutcome`. Both are accepted here.
 */
async function settleStage(
  run: () => Promise<StageSummary | StageOutcome<StageSummary>>,
): Promise<StageSettlement> {
  try {
    const result = await run();

    // A bare summary (current seams) is a completion.
    if (!("status" in result)) {
      return { kind: "completed", summary: result };
    }

    switch (result.status) {
      case "completed":
        return { kind: "completed", summary: result.summary };
      case "degraded":
        return { kind: "degraded", failure: result.failure };
      case "exhausted":
        return { kind: "exhausted" };
    }
  } catch (err) {
    return {
      kind: "threw",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Force `Escalate_To_Human` for the Case: record the escalation Trace_Step,
 * set `resolutionPath = Escalate_To_Human`, and transition the Case_Status to
 * `NeedsHumanInput` (via the guarded `assertTransition`). Returns the resulting
 * `RunResult`. Used for graceful degradation (Req 6.9), loop exhaustion
 * (Req 6.4), and a thrown stage (Req 20.6).
 */
async function haltWithEscalation(
  caseId: string,
  reasoning: string,
): Promise<RunResult> {
  // The escalation Trace_Step (also the failure-describing step for Req 20.6).
  await createTraceStep({ caseId, stepType: "decision", reasoning });

  const current = await prisma.case.findUnique({
    where: { id: caseId },
    select: { status: true, overallConfidence: true },
  });
  const from = (current?.status as CaseStatus) ?? "Investigating";
  const transition = assertTransition(from, "NeedsHumanInput");

  const data: { resolutionPath: ResolutionPath; status?: CaseStatus } = {
    resolutionPath: "Escalate_To_Human",
  };
  if (transition.ok && !transition.noop) {
    data.status = "NeedsHumanInput";
  }
  await prisma.case.update({ where: { id: caseId }, data });

  return {
    resolutionPath: "Escalate_To_Human",
    overallConfidence: current?.overallConfidence ?? 0,
    status: transition.status,
  };
}

/** Build the escalation reasoning for a non-completed settlement. */
function escalationReason(
  settlement: Exclude<StageSettlement, { kind: "completed" }>,
  stage: PipelineStage,
): string {
  switch (settlement.kind) {
    case "degraded":
      // Req 6.9 — graceful degradation on a structured Qwen_Client failure.
      return `Qwen_Client reported a "${settlement.failure.kind}" failure during ${stage}; degrading Resolution_Path to Escalate_To_Human (needs human input) per Req 6.9.`;
    case "exhausted":
      // Req 6.4 — the exact reasoning the requirement mandates.
      return "needs manual review";
    case "threw":
      // Req 20.6 — Trace_Step describing the failure and the affected stage.
      return `Pipeline stage "${stage}" failed: ${settlement.message}. Escalating to human and halting the pipeline (Req 20.6).`;
  }
}

// ─── runAgent — the ordered pipeline (Requirements 6.1, 6.2, 20.1) ────────────

/**
 * Run the AuthPilot agent pipeline for a Case.
 *
 * Sequences the stages in order — Intake_And_Extraction → (Medical_Review ||
 * Policy_Review) → Strategy → Decision_Intelligence → Appeal_Generation →
 * Verification_QA — setting the Case_Status to `Investigating` while it runs
 * (Req 6.2). If any stage degrades (Req 6.9), exhausts its bounded loop
 * (Req 6.4), or throws (Req 20.6), the pipeline escalates to human and halts
 * without running subsequent stages.
 *
 * `extraContext` carries optional additional context for a re-run (e.g. evidence
 * appended by the request_more_evidence action, Requirement 16).
 */
export async function runAgent(
  caseId: string,
  extraContext?: string,
): Promise<RunResult> {
  const existing = await prisma.case.findUnique({
    where: { id: caseId },
    select: { status: true },
  });
  if (!existing) {
    throw new Error(`runAgent: Case "${caseId}" not found.`);
  }

  // Req 6.2 — the Case is Investigating while the loop runs.
  const start = assertTransition(existing.status as CaseStatus, "Investigating");
  if (start.ok && !start.noop) {
    await prisma.case.update({
      where: { id: caseId },
      data: { status: "Investigating" },
    });
  }

  const ctx: StageContext = { caseId, extraContext, summaries: {} };

  // 1. Intake_And_Extraction.
  {
    const settlement = await settleStage(() => intakeAndExtractionStage(ctx));
    if (settlement.kind !== "completed") {
      return haltWithEscalation(
        caseId,
        escalationReason(settlement, "Intake_And_Extraction"),
      );
    }
    ctx.summaries.Intake_And_Extraction = settlement.summary;
  }

  // 2 + 3. Medical_Review || Policy_Review — concurrent (Req 20.2). Settle both
  // before interpreting, so a failure in either escalates exactly once.
  {
    const [medical, policy] = await Promise.all([
      settleStage(() => medicalReviewStage(ctx)),
      settleStage(() => policyReviewStage(ctx)),
    ]);
    if (medical.kind !== "completed") {
      return haltWithEscalation(
        caseId,
        escalationReason(medical, "Medical_Review"),
      );
    }
    if (policy.kind !== "completed") {
      return haltWithEscalation(
        caseId,
        escalationReason(policy, "Policy_Review"),
      );
    }
    ctx.summaries.Medical_Review = medical.summary;
    ctx.summaries.Policy_Review = policy.summary;
  }

  // 4. Strategy.
  {
    const settlement = await settleStage(() => strategyStage(ctx));
    if (settlement.kind !== "completed") {
      return haltWithEscalation(caseId, escalationReason(settlement, "Strategy"));
    }
    ctx.summaries.Strategy = settlement.summary;
  }

  // 5. Decision_Intelligence.
  {
    const settlement = await settleStage(() => decisionIntelligenceStage(ctx));
    if (settlement.kind !== "completed") {
      return haltWithEscalation(
        caseId,
        escalationReason(settlement, "Decision_Intelligence"),
      );
    }
    ctx.summaries.Decision_Intelligence = settlement.summary;
  }

  // 6. Appeal_Generation.
  {
    const settlement = await settleStage(() => appealGenerationStage(ctx));
    if (settlement.kind !== "completed") {
      return haltWithEscalation(
        caseId,
        escalationReason(settlement, "Appeal_Generation"),
      );
    }
    ctx.summaries.Appeal_Generation = settlement.summary;
  }

  // 7. Verification_QA.
  {
    const settlement = await settleStage(() => verificationQaStage(ctx));
    if (settlement.kind !== "completed") {
      return haltWithEscalation(
        caseId,
        escalationReason(settlement, "Verification_QA"),
      );
    }
    ctx.summaries.Verification_QA = settlement.summary;
  }

  // Pipeline completed. The real Resolution_Path / Confidence_Score / status are
  // persisted by the Decision_Intelligence stage (Task 11.13) and reflected in
  // the Case; this finalizer reads that persisted state rather than fabricating
  // a decision (scaffolding: with no decision persisted yet, resolutionPath is
  // null → reported as Escalate_To_Human and status remains Investigating).
  return finalizeRunResult(caseId);
}

/** Read the pipeline outcome persisted on the Case into a `RunResult`. */
async function finalizeRunResult(caseId: string): Promise<RunResult> {
  const kase = await prisma.case.findUnique({
    where: { id: caseId },
    select: { resolutionPath: true, overallConfidence: true, status: true },
  });
  return {
    resolutionPath:
      (kase?.resolutionPath as ResolutionPath | null) ?? "Escalate_To_Human",
    overallConfidence: kase?.overallConfidence ?? 0,
    status: (kase?.status as CaseStatus | undefined) ?? "Investigating",
  };
}
