/**
 * lib/agentTools.traceCompleteness.test.ts
 *
 * Property test (Task 7.9): trace step completeness.
 *
 * Feature: authpilot
 * Property 10: Trace step completeness — every `"tool_call"` Trace_Step recorded
 * by `dispatchTool` (lib/agentTools.ts) must be COMPLETE: it captures the tool
 * name, the input arguments, the output (or error observation), a non-empty
 * reasoning string, and a timestamp. For ANY dispatched tool call — success,
 * failure, or stage-refusal — the persisted Trace_Step has all required fields
 * populated (none missing/empty).
 *
 * **Validates: Requirements 9.2**
 *
 * Strategy: provision a fresh, isolated PostgreSQL schema (via `createTestDb`),
 * bind it as the shared `globalThis.prisma` BEFORE importing the module so both
 * `dispatchTool` and its `createTraceStep` persistence hit the same isolated
 * data, then seed a payer/patient/policy/Case. fast-check generates a sequence
 * of tool-call scenarios spanning the success path, several failure paths
 * (unknown tool, invalid argument, missing patient) and the stage-refusal path.
 * Each scenario is dispatched against a clean Trace_Step table for the Case, and
 * the single recorded Trace_Step is read back and asserted complete.
 *
 * NOTE: Task 7.8 covers dispatchTool resilience; THIS test stays focused on the
 * field completeness of the recorded Trace_Step and uses a distinct filename.
 *
 * Uses Vitest + fast-check (numRuns 100), consistent with the rest of the suite.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { PrismaClient, TraceStep } from "@prisma/client";
import type { PipelineStage } from "./types";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";

type GlobalWithPrisma = { prisma?: PrismaClient };

let testDb: TestDb;
let prisma: PrismaClient;
let dispatchTool: typeof import("./agentTools").dispatchTool;

// Seeded identities the scenarios reference (set in beforeAll).
let payerId: string;
let patientId: string;
let procedureCode: string;
let caseId: string;

beforeAll(async () => {
  // Provision an isolated schema and expose its client as the shared instance
  // BEFORE loading the tool module, so `lib/db.ts` binds to the test schema and
  // dispatchTool's createTraceStep writes there.
  testDb = await createTestDb();
  prisma = testDb.prisma;
  (globalThis as unknown as GlobalWithPrisma).prisma = prisma;

  ({ dispatchTool } = await import("./agentTools"));

  // Seed the minimal graph the success-path tools need: a payer, a patient with
  // a chart note, a matching payer policy, and a Case (also the Trace_Step FK
  // target and the patient's prior-auth history so history is non-empty).
  const payer = await prisma.payer.create({ data: { name: "Test Payer" } });
  payerId = payer.id;

  const patient = await prisma.patient.create({
    data: {
      name: "Test Patient",
      dob: new Date("1990-01-01T00:00:00.000Z"),
      payerId,
      chartNotes: {
        create: [
          {
            content: "Chart note content",
            diagnosisCode: "E11.9",
            noteDate: new Date("2024-01-01T00:00:00.000Z"),
          },
        ],
      },
    },
  });
  patientId = patient.id;

  procedureCode = "97110";
  await prisma.payerPolicy.create({
    data: {
      payerId,
      policyCode: "LCD L34567",
      procedureCode,
      criteriaText: "Medical necessity criteria text.",
    },
  });

  const seededCase = await prisma.case.create({
    data: {
      patientId,
      intakeType: "new_pa_request",
      rawIntakeText: "raw intake",
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

// ─── Scenario generator ───────────────────────────────────────────────────────
//
// A scenario is a template resolved to a concrete dispatch at runtime (so it can
// reference the seeded ids). Each scenario knows the tool name it will dispatch
// and whether that dispatch is expected to succeed — but EVERY scenario, success
// or failure, must yield a complete "tool_call" Trace_Step.

type Scenario =
  | { kind: "fetchPatientRecord_ok" }
  | { kind: "checkPriorAuthHistory_ok" }
  | { kind: "fetchPayerPolicy_ok" }
  | { kind: "fetchPatientRecord_missing"; badId: string }
  | { kind: "invalidArg"; junkKey: string; junkValue: string }
  | { kind: "unknownTool"; toolName: string }
  | { kind: "stageRefused" };

const scenarioArb: fc.Arbitrary<Scenario> = fc.oneof(
  fc.constant<Scenario>({ kind: "fetchPatientRecord_ok" }),
  fc.constant<Scenario>({ kind: "checkPriorAuthHistory_ok" }),
  fc.constant<Scenario>({ kind: "fetchPayerPolicy_ok" }),
  fc
    .string({ minLength: 1, maxLength: 24 })
    .map<Scenario>((badId) => ({ kind: "fetchPatientRecord_missing", badId })),
  fc
    .record({
      junkKey: fc.string({ minLength: 1, maxLength: 12 }),
      junkValue: fc.string({ maxLength: 12 }),
    })
    .map<Scenario>(({ junkKey, junkValue }) => ({
      kind: "invalidArg",
      junkKey,
      junkValue,
    })),
  // A non-empty tool name that is not one of the known ToolNames.
  fc
    .string({ minLength: 1, maxLength: 16 })
    .filter(
      (s) =>
        ![
          "fetchPatientRecord",
          "fetchPayerPolicy",
          "checkPriorAuthHistory",
          "lookupDiagnosisCode",
          "generateAppealPdf",
        ].includes(s),
    )
    .map<Scenario>((toolName) => ({ kind: "unknownTool", toolName })),
  fc.constant<Scenario>({ kind: "stageRefused" }),
);

interface Dispatch {
  name: string;
  args: Record<string, unknown>;
  stage?: PipelineStage;
  expectOk: boolean;
}

function resolveDispatch(scenario: Scenario): Dispatch {
  switch (scenario.kind) {
    case "fetchPatientRecord_ok":
      return { name: "fetchPatientRecord", args: { patientId }, expectOk: true };
    case "checkPriorAuthHistory_ok":
      return {
        name: "checkPriorAuthHistory",
        args: { patientId },
        expectOk: true,
      };
    case "fetchPayerPolicy_ok":
      return {
        name: "fetchPayerPolicy",
        args: { payerId, procedureCode },
        expectOk: true,
      };
    case "fetchPatientRecord_missing":
      return {
        name: "fetchPatientRecord",
        args: { patientId: `missing-${scenario.badId}` },
        expectOk: false,
      };
    case "invalidArg":
      // Known tool, but the required "patientId" string arg is absent → throws.
      return {
        name: "fetchPatientRecord",
        args: { [scenario.junkKey]: scenario.junkValue },
        expectOk: false,
      };
    case "unknownTool":
      return { name: scenario.toolName, args: { any: "value" }, expectOk: false };
    case "stageRefused":
      // fetchPayerPolicy is not in the Medical_Review allow-list → refused.
      return {
        name: "fetchPayerPolicy",
        args: { payerId, procedureCode },
        stage: "Medical_Review",
        expectOk: false,
      };
  }
}

// ─── Completeness assertion ────────────────────────────────────────────────────

function assertCompleteToolCallStep(step: TraceStep, expectedName: string): void {
  // Step type is the "tool_call" kind.
  expect(step.stepType).toBe("tool_call");

  // Tool name captured and non-empty.
  expect(typeof step.toolName).toBe("string");
  expect(step.toolName).toBe(expectedName);
  expect((step.toolName ?? "").length).toBeGreaterThan(0);

  // Input arguments captured (field present, not JSON null).
  expect(step.input).not.toBeNull();
  expect(step.input).toBeDefined();

  // Output (or error observation) captured (field present, not JSON null).
  expect(step.output).not.toBeNull();
  expect(step.output).toBeDefined();

  // Non-empty reasoning string.
  expect(typeof step.reasoning).toBe("string");
  expect(step.reasoning.length).toBeGreaterThan(0);

  // Well-formed timestamp.
  expect(step.timestamp).toBeInstanceOf(Date);
  expect(Number.isNaN(step.timestamp.getTime())).toBe(false);
}

// ─── Property 10: Trace step completeness (Req 9.2) ────────────────────────────

describe("Property 10: Trace step completeness for dispatchTool tool_call steps (Task 7.9, Req 9.2)", () => {
  // **Validates: Requirements 9.2**
  it("records a complete tool_call Trace_Step for every dispatched tool call", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(scenarioArb, { minLength: 1, maxLength: 6 }),
        async (scenarios) => {
          for (const scenario of scenarios) {
            const { name, args, stage, expectOk } = resolveDispatch(scenario);

            // Clean slate for this Case so exactly one recorded step is read back.
            await prisma.traceStep.deleteMany({ where: { caseId } });

            const observation = await dispatchTool(name, args, caseId, stage);

            // dispatchTool never throws; the observation reflects success/failure.
            expect(observation.ok).toBe(expectOk);
            expect(observation.tool).toBe(name);

            const steps = await prisma.traceStep.findMany({ where: { caseId } });

            // Exactly one tool_call Trace_Step is recorded per dispatch.
            expect(steps).toHaveLength(1);
            const step = steps[0];

            assertCompleteToolCallStep(step, name);

            // On a failure/refusal, the recorded output IS the error observation:
            // a non-empty error string, and the returned observation carries it.
            if (!expectOk) {
              const output = step.output as { error?: unknown };
              expect(typeof output.error).toBe("string");
              expect((output.error as string).length).toBeGreaterThan(0);
              if (observation.ok === false) {
                expect(observation.error.length).toBeGreaterThan(0);
              }
            }
          }

          // Leave the Case's trace table clean for the next iteration.
          await prisma.traceStep.deleteMany({ where: { caseId } });
        },
      ),
      FC_CONFIG,
    );
  }, 300_000);
});
