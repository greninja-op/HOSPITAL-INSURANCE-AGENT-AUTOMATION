/**
 * lib/agentTools.stageScopedTools.test.ts
 *
 * Property test (Task 11.4): stage-scoped tool access.
 *
 * Feature: authpilot
 * Property 42: Stage-scoped tool access —
 *   For ANY (stage, toolName) pair, `dispatchTool(name, args, caseId, stage)`
 *   PERMITS the call IF AND ONLY IF the tool is in that stage's `STAGE_TOOLS`
 *   allow-list. A tool that is NOT in the active stage's allow-list is REFUSED
 *   before invocation: dispatch records a failure `"tool_call"` Trace_Step, the
 *   tool never executes, and dispatch returns an error observation (never
 *   throws). In particular Medical_Review permits only `fetchPatientRecord`
 *   (Req 3.8) and Policy_Review permits only `fetchPayerPolicy` (Req 3.9).
 *
 * **Validates: Requirements 3.8, 3.9**
 *
 * Strategy: provision a fresh, isolated PostgreSQL schema (via `createTestDb`)
 * and expose its client as the shared `globalThis.prisma` BEFORE importing the
 * module, so `dispatchTool` and its `createTraceStep` persistence hit the same
 * isolated data. Seed a payer + patient + Case so every persisted `tool_call`
 * Trace_Step has a valid Case FK.
 *
 * fast-check generates every (stage, toolName) combination across the nine
 * pipeline stages and the five known tools. Each pair is checked against the
 * AUTHORITATIVE `STAGE_TOOLS` map:
 *   • PERMITTED  → dispatch does NOT refuse (the tool is actually invoked); any
 *                  error observation is the tool's own error, never the
 *                  stage-refusal message, and the reasoning is never a refusal.
 *   • REFUSED    → dispatch returns `{ ok: false }` with the exact refusal
 *                  message, and the recorded Trace_Step's output IS that refusal
 *                  — proving no tool execution occurred (the refusal message is
 *                  produced ONLY on the pre-invocation branch).
 *
 * To make the "no tool execution on refusal" claim concrete, the DB-backed
 * tools are dispatched with arguments that WOULD SUCCEED if executed: seeing an
 * `ok: false` refusal instead of that success proves the tool never ran. The
 * two side-effecting tools (`lookupDiagnosisCode`, `generateAppealPdf`) are
 * dispatched with arguments that fail fast BEFORE any network/filesystem
 * access, keeping the test hermetic on the permitted path.
 *
 * Uses Vitest + fast-check (numRuns 100), consistent with the rest of the suite.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type { PipelineStage } from "./types";
import type { ToolName } from "./agentTools";

type GlobalWithPrisma = { prisma?: PrismaClient };

let testDb: TestDb;
let prisma: PrismaClient;
let dispatchTool: typeof import("./agentTools").dispatchTool;
let STAGE_TOOLS: typeof import("./agentTools").STAGE_TOOLS;

/** Case id used as the FK owner for every traced `tool_call` step. */
let caseId: string;
/** Seeded patient id, so a permitted `fetchPatientRecord`/history call succeeds. */
let seededPatientId: string;

beforeAll(async () => {
  // Provision an isolated schema and expose its client as the shared instance
  // BEFORE loading the tool module, so `lib/db.ts` binds to the test schema and
  // dispatchTool's createTraceStep writes there.
  testDb = await createTestDb();
  prisma = testDb.prisma;
  (globalThis as unknown as GlobalWithPrisma).prisma = prisma;

  const agentTools = await import("./agentTools");
  dispatchTool = agentTools.dispatchTool;
  STAGE_TOOLS = agentTools.STAGE_TOOLS;

  // Seed a payer + patient + Case. The Case supplies the Trace_Step FK; the
  // patient lets refused DB-backed tools be dispatched with args that WOULD
  // succeed if they ran.
  const payer = await prisma.payer.create({ data: { name: "Test Payer" } });
  const patient = await prisma.patient.create({
    data: {
      name: "Test Patient",
      dob: new Date("1990-01-01T00:00:00.000Z"),
      payerId: payer.id,
    },
  });
  seededPatientId = patient.id;

  const seededCase = await prisma.case.create({
    data: {
      patientId: patient.id,
      intakeType: "new_pa_request",
      rawIntakeText: "raw intake for stage-scoped tool access test",
      status: "New",
      slaDeadline: new Date("2099-01-01T00:00:00.000Z"),
    },
  });
  caseId = seededCase.id;
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
  delete (globalThis as unknown as GlobalWithPrisma).prisma;
});

// ─── Generators ──────────────────────────────────────────────────────────────

/** The nine ordered pipeline stages. */
const STAGES: readonly PipelineStage[] = [
  "Intake_And_Extraction",
  "Medical_Review",
  "Policy_Review",
  "Strategy",
  "Decision_Intelligence",
  "Appeal_Generation",
  "Verification_QA",
  "Human_Approval",
  "Submission_And_Tracking",
];

/** The five Qwen-visible tool names dispatch understands. */
const TOOL_NAMES: readonly ToolName[] = [
  "fetchPatientRecord",
  "fetchPayerPolicy",
  "checkPriorAuthHistory",
  "lookupDiagnosisCode",
  "generateAppealPdf",
];

const stageArb = fc.constantFrom(...STAGES);
const toolArb = fc.constantFrom(...TOOL_NAMES);

/**
 * Arguments for a dispatched tool. The DB-backed tools get arguments that WOULD
 * SUCCEED if executed (so a refusal observation proves the tool never ran). The
 * two side-effecting tools get empty args that fail fast BEFORE any network or
 * filesystem access, keeping the permitted path hermetic.
 */
function argsFor(tool: ToolName): Record<string, unknown> {
  switch (tool) {
    case "fetchPatientRecord":
      // Valid seeded id → would resolve to a real record if executed.
      return { patientId: seededPatientId };
    case "checkPriorAuthHistory":
      // Valid seeded id → would resolve to [] if executed.
      return { patientId: seededPatientId };
    case "fetchPayerPolicy":
      // Valid (non-matching) args → would resolve to null (success) if executed.
      return { payerId: "no-match", procedureCode: "00000" };
    case "lookupDiagnosisCode":
      // No "code" arg → throws in requireStringArg BEFORE any NIH network call.
      return {};
    case "generateAppealPdf":
      // No "content" arg → throws while rendering BEFORE any file is written.
      return {};
  }
}

/** The exact refusal message dispatch emits on the pre-invocation branch. */
function refusalMessage(tool: ToolName, stage: PipelineStage): string {
  return `Tool "${tool}" is not permitted during ${stage}.`;
}

// ─── Property 42: Stage-scoped tool access (Req 3.8, 3.9) ──────────────────────

describe("Property 42: Stage-scoped tool access (Task 11.4, Req 3.8, 3.9)", () => {
  // **Validates: Requirements 3.8, 3.9**
  it("permits a tool IFF it is in the active stage's allow-list; otherwise refuses with a failure trace and no execution", async () => {
    await fc.assert(
      fc.asyncProperty(stageArb, toolArb, async (stage, tool) => {
        const permitted = STAGE_TOOLS[stage].includes(tool);

        // Snapshot the Case's existing Trace_Steps so we isolate the row this
        // single dispatch adds.
        const before = await prisma.traceStep.findMany({
          where: { caseId },
          select: { id: true },
        });
        const beforeIds = new Set(before.map((s) => s.id));

        // Dispatch MUST NOT throw for any (stage, tool) pair.
        const observation = await dispatchTool(
          tool,
          argsFor(tool),
          caseId,
          stage,
        );

        // An observation is always returned for the dispatched tool.
        expect(observation.tool).toBe(tool);
        expect(typeof observation.ok).toBe("boolean");

        // Exactly one new "tool_call" Trace_Step is recorded either way.
        const after = await prisma.traceStep.findMany({ where: { caseId } });
        const added = after.filter((s) => !beforeIds.has(s.id));
        expect(added).toHaveLength(1);
        const step = added[0];
        expect(step.stepType).toBe("tool_call");
        expect(step.toolName).toBe(tool);
        expect(step.reasoning.length).toBeGreaterThan(0);
        expect(step.timestamp).toBeInstanceOf(Date);

        const refusal = refusalMessage(tool, stage);

        if (permitted) {
          // PERMITTED: the tool is actually invoked. The dispatch is NOT a
          // stage refusal — any error observation is the tool's own error, and
          // the reasoning is never a refusal.
          if (!observation.ok) {
            expect(observation.error).not.toBe(refusal);
          }
          expect(step.reasoning).not.toContain("refused: not in the");
          const output = step.output as { error?: unknown } | null;
          if (output && typeof output.error === "string") {
            expect(output.error).not.toBe(refusal);
          }
        } else {
          // REFUSED: dispatch returns the exact refusal message and never runs
          // the tool. The recorded Trace_Step's output IS that refusal — the
          // refusal message is produced ONLY on the pre-invocation branch, so
          // seeing it (instead of the would-succeed tool result) proves no
          // execution occurred.
          expect(observation.ok).toBe(false);
          if (!observation.ok) {
            expect(observation.error).toBe(refusal);
          }
          expect(step.reasoning).toContain("refused: not in the");
          const output = step.output as { error?: unknown };
          expect(output.error).toBe(refusal);
        }
      }),
      FC_CONFIG,
    );
  }, 300_000);
});

// ─── Focused unit tests (Req 3.8 / 3.9 named restrictions) ─────────────────────

describe("stage-scoped tool access — representative examples (Req 3.8, 3.9)", () => {
  it("Medical_Review permits fetchPatientRecord (Req 3.8)", async () => {
    const obs = await dispatchTool(
      "fetchPatientRecord",
      { patientId: seededPatientId },
      caseId,
      "Medical_Review",
    );
    // Permitted and actually invoked → the seeded patient resolves to a record.
    expect(obs.ok).toBe(true);
  });

  it("Medical_Review refuses fetchPayerPolicy (Req 3.8 — chart only)", async () => {
    const obs = await dispatchTool(
      "fetchPayerPolicy",
      { payerId: "no-match", procedureCode: "00000" },
      caseId,
      "Medical_Review",
    );
    expect(obs.ok).toBe(false);
    if (!obs.ok) {
      expect(obs.error).toBe(
        'Tool "fetchPayerPolicy" is not permitted during Medical_Review.',
      );
    }
  });

  it("Policy_Review permits fetchPayerPolicy (Req 3.9)", async () => {
    const obs = await dispatchTool(
      "fetchPayerPolicy",
      { payerId: "no-match", procedureCode: "00000" },
      caseId,
      "Policy_Review",
    );
    // Permitted and actually invoked → no matching policy resolves to null.
    expect(obs.ok).toBe(true);
    if (obs.ok) expect(obs.result).toBeNull();
  });

  it("Policy_Review refuses fetchPatientRecord (Req 3.9 — policy only)", async () => {
    const obs = await dispatchTool(
      "fetchPatientRecord",
      { patientId: seededPatientId },
      caseId,
      "Policy_Review",
    );
    // Refused despite valid args that WOULD succeed → proves no execution.
    expect(obs.ok).toBe(false);
    if (!obs.ok) {
      expect(obs.error).toBe(
        'Tool "fetchPatientRecord" is not permitted during Policy_Review.',
      );
    }
  });
});
