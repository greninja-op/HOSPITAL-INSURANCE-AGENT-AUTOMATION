// =============================================================================
// lib/agentRunner.decisionTrace.test.ts
//
// Property 16: Decisions are traced.
//
// **Validates: Requirements 5.6**
//
// Requirement 5.6 mandates that WHEN the Decision_Engine sets a Resolution_Path,
// THE Agent_Runner records a Trace_Step of type "decision" storing the overall
// Confidence_Score, the selected Resolution_Path, and the reasoning. Property 16
// generalizes this: *for any* Resolution_Path the Decision_Engine sets, the
// Agent_Runner records a "decision" Trace_Step capturing the overall
// Confidence_Score, the selected Resolution_Path, and (non-empty) reasoning.
//
// The Decision_Intelligence stage (`lib/agentRunner.ts`) is PURE reasoning — its
// tool allow-list is empty, so it makes NO Qwen call: it aggregates the Case's
// Extracted_Field confidences into an overall score (Req 5.1), routes via the
// deterministic `Decision_Engine` (`lib/decisionEngine.ts`), and writes the
// single `decision` Trace_Step by hand. To reach that stage the pipeline must
// first complete Intake_And_Extraction, Medical_Review, Policy_Review, and
// Strategy — every one of which DOES call the Qwen_Client.
//
// Strategy of this test (mirrors lib/agentRunner.reviewOverlap.test.ts):
//   • We replace `callQwen` with a fake (via `vi.mock`) that routes by the
//     stage's system prompt. The Intake fake returns an extraction whose five
//     fields carry a CONTROLLED per-run confidence `c ∈ [0, 1]`; since the
//     overall score is the mean of the per-field confidences scaled to 0..100,
//     this drives `overallConfidence = c * 100` — which in turn selects the
//     Resolution_Path across all three bands (Auto_Draft / Draft_And_Request_
//     Evidence / Escalate_To_Human) as `c` varies. Medical/Policy/Strategy fakes
//     return benign summaries so those stages complete. Anything AFTER Strategy
//     (i.e. Appeal_Generation) is degraded so `runAgent` halts right after the
//     decision is traced (Req 6.9) — keeping each run lean. The `decision`
//     Trace_Step is already persisted by then.
//   • No blocking Findings are produced in this seam (unresolved fields surface
//     only as WARNING gap findings), so `contradictionCount = 0` and the traced
//     path must equal `decide({ overallConfidence, 0, false }).path` exactly.
//
// Persistence uses an isolated, throwaway PostgreSQL schema (`createTestDb`),
// bound as the shared `globalThis.prisma` BEFORE importing the runner so both
// `runAgent` and its `createTraceStep` writes land in the disposable schema.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import { decide } from "@/lib/decisionEngine";
import type { ResolutionPath } from "@/lib/types";

// ─── Per-run coordinator shared with the hoisted mock ─────────────────────────
//
// The mock factory is hoisted above imports; give it a stable handle it reads
// the CURRENT run's controlled confidence from. The test body swaps `current`
// each run.
const hoisted = vi.hoisted(() => ({
  current: null as { confidence: number } | null,
}));

// ─── Mock the Qwen_Client: route by stage prompt ──────────────────────────────

vi.mock("@/lib/qwen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/qwen")>();

  const success = (content: string) =>
    ({ ok: true as const, toolCalls: [], content });

  // A structured transient failure so the FIRST post-Strategy stage
  // (Appeal_Generation) degrades and `runAgent` halts (Req 6.9) — keeping each
  // run lean. The `decision` Trace_Step has already been written by then.
  const degrade = () =>
    ({
      ok: false as const,
      kind: "network" as const,
      transient: true,
      attempts: 3,
      detail: "fake degrade to short-circuit the pipeline after Decision_Intelligence",
    });

  return {
    ...actual,
    callQwen: async (
      messages: import("@/lib/qwen").ChatMessage[],
    ): Promise<import("@/lib/types").QwenOutcome> => {
      const sys =
        typeof messages[0]?.content === "string" ? messages[0].content : "";
      const c = hoisted.current?.confidence ?? 0;

      // Intake_And_Extraction — return a five-field extraction whose confidences
      // are all `c`, so overallConfidence = c * 100 (drives the Resolution_Path).
      if (sys.includes("the Intake_And_Extraction stage")) {
        const field = (value: string) => ({
          value,
          confidence: c,
          reasoning: "controlled by the decision-trace property test",
        });
        return success(
          JSON.stringify({
            patient: field("Test Patient"),
            payer: field("Test Payer"),
            procedureCode: field("12345"),
            diagnosisCode: field("M17.11"),
            denialReason: field("not medically necessary"),
          }),
        );
      }

      // Medical_Review / Policy_Review — benign plain-text assessments so both
      // review stages complete without tool calls.
      if (sys.includes("the Medical_Review stage")) {
        return success("Chart assessed: clinical medical necessity is supported.");
      }
      if (sys.includes("the Policy_Review stage")) {
        return success("Payer medical-necessity criteria assessed against the chart.");
      }

      // Strategy — a single valid candidate approach so the stage completes.
      if (sys.includes("the Strategy stage")) {
        return success(
          JSON.stringify({
            options: [
              {
                approach: "Cite chart evidence against the payer policy clause.",
                winProbability: 70,
                rationale: "Chart supports medical necessity.",
              },
            ],
            payerTrackRecordSummary: "Payer historically overturns similar denials.",
          }),
        );
      }

      // Appeal_Generation (or anything else) — degrade to halt post-Decision.
      return degrade();
    },
  };
});

// ─── Test-DB wiring (bound before importing the runner) ───────────────────────

type GlobalWithPrisma = { prisma?: PrismaClient };
type RunnerModule = typeof import("@/lib/agentRunner");

const VALID_PATHS: ReadonlySet<ResolutionPath> = new Set<ResolutionPath>([
  "Auto_Draft",
  "Draft_And_Request_Evidence",
  "Escalate_To_Human",
]);

let testDb: TestDb;
let prisma: PrismaClient;
let runner: RunnerModule;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  // Bind the isolated schema's client as the shared singleton BEFORE importing
  // the runner, so `runAgent` and its `createTraceStep` persistence hit it.
  process.env.DATABASE_URL = testDb.databaseUrl;
  (globalThis as unknown as GlobalWithPrisma).prisma = prisma;

  runner = await import("@/lib/agentRunner");
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

/** Seed a fresh `New` Case the pipeline can run against. */
async function seedCase(): Promise<string> {
  const kase = await prisma.case.create({
    data: {
      intakeType: "denial_letter",
      rawIntakeText: "seed intake for the decision-trace property test",
      status: "New",
      slaDeadline: new Date("2026-01-15T12:00:00.000Z"),
    },
  });
  return kase.id;
}

/** Read the single `decision` Trace_Step for a Case (asserts exactly one). */
async function readDecisionStep(caseId: string) {
  const steps = await prisma.traceStep.findMany({
    where: { caseId, stepType: "decision" },
  });
  return steps;
}

describe("Property 16: Decisions are traced (Req 5.6)", () => {
  it("records a 'decision' Trace_Step capturing confidence, path, and reasoning for any Resolution_Path", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Vary confidence across the full range so the Decision_Engine selects
        // every Resolution_Path band (Auto_Draft / Draft_And_Request_Evidence /
        // Escalate_To_Human) across runs.
        fc.double({ min: 0, max: 1, noNaN: true }),
        async (confidence) => {
          hoisted.current = { confidence };

          const caseId = await seedCase();
          await runner.runAgent(caseId);

          // Req 5.6 — EXACTLY one "decision" Trace_Step is recorded.
          const steps = await readDecisionStep(caseId);
          expect(steps).toHaveLength(1);
          const step = steps[0];

          // Req 5.6 — the step stores the REASONING (non-empty string).
          expect(typeof step.reasoning).toBe("string");
          expect(step.reasoning.trim().length).toBeGreaterThan(0);

          // Req 5.6 — the step's output stores the overall Confidence_Score and
          // the selected Resolution_Path.
          const output = step.output as {
            overallConfidence?: unknown;
            resolutionPath?: unknown;
          } | null;
          expect(output).not.toBeNull();

          const tracedConfidence = output?.overallConfidence;
          expect(typeof tracedConfidence).toBe("number");
          const conf = tracedConfidence as number;
          expect(Number.isFinite(conf)).toBe(true);
          expect(conf).toBeGreaterThanOrEqual(0);
          expect(conf).toBeLessThanOrEqual(100);
          // The traced score reflects the per-field confidences (mean = c*100).
          expect(conf).toBeCloseTo(confidence * 100, 4);

          const tracedPath = output?.resolutionPath;
          expect(typeof tracedPath).toBe("string");
          expect(VALID_PATHS.has(tracedPath as ResolutionPath)).toBe(true);

          // The traced path is exactly the deterministic Decision_Engine outcome
          // for the traced confidence (no blocking findings in this seam, so
          // contradictionCount = 0 and iterationsExhausted = false).
          const expected = decide({
            overallConfidence: conf,
            contradictionCount: 0,
            iterationsExhausted: false,
          }).path;
          expect(tracedPath).toBe(expected);

          // The decision is also persisted on the Case, consistent with the trace.
          const kase = await prisma.case.findUnique({
            where: { id: caseId },
            select: { resolutionPath: true, overallConfidence: true },
          });
          expect(kase?.resolutionPath).toBe(tracedPath);
          expect(kase?.overallConfidence).toBeCloseTo(conf, 6);
        },
      ),
      FC_CONFIG,
    );
  }, 300_000);
});
