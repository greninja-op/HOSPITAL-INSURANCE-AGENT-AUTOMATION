/**
 * lib/agentTools.dispatchTool.test.ts
 *
 * Property test (Task 7.8): resilient, always-traced tool dispatch.
 *
 * Feature: authpilot, Property 9: Tool dispatch is resilient and always traced.
 *
 *   For ANY tool invocation — whether the tool succeeds or throws (unknown tool,
 *   missing/invalid arguments, or a tool that fails at runtime) — `dispatchTool`
 *   NEVER throws: it records a "tool_call" Trace_Step capturing the call (tool
 *   name, input, output/error, reasoning, timestamp) on BOTH success and
 *   failure, and returns an observation to the loop instead of propagating an
 *   exception that would terminate the Case.
 *
 * Strategy: provision a fresh, isolated PostgreSQL schema (via `createTestDb`)
 * and seed a real Case so the persisted `tool_call` Trace_Step has a valid FK.
 * `dispatchTool` uses the shared Prisma client from `lib/db.ts`, so we point
 * `DATABASE_URL` at the throwaway schema BEFORE importing the module (dynamic
 * import in `beforeAll`), ensuring both the seed and the traced writes hit the
 * same isolated data.
 *
 * `dispatchTool` maps a tool name to a concrete implementation internally (there
 * is no hook to inject a failing implementation), so the resilient/failure path
 * is exercised by driving:
 *   • unknown tool names            → invoke throws "Unknown tool ..."
 *   • known tools with missing args → `requireStringArg` throws
 *   • known tools that fail at run  → e.g. fetchPatientRecord on a missing id
 * and the success path by driving:
 *   • fetchPayerPolicy (no match)   → resolves to null
 *   • checkPriorAuthHistory         → resolves to []
 *   • fetchPatientRecord (seeded)   → resolves to the seeded record
 *
 * The two side-effecting/external tools (`lookupDiagnosisCode`,
 * `generateAppealPdf`) are only ever generated with arguments that fail fast
 * BEFORE any network/filesystem access, keeping the test hermetic.
 *
 * Uses Vitest + fast-check (numRuns 100), consistent with the rest of the suite.
 *
 * Validates: Requirements 3.5, 3.6
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";

let testDb: TestDb;
let prisma: PrismaClient;
let dispatchTool: typeof import("./agentTools").dispatchTool;

/** Case id used as the FK owner for every traced `tool_call` step. */
let caseId: string;
/** Seeded patient id, used to exercise the fetchPatientRecord success path. */
let seededPatientId: string;

beforeAll(async () => {
  // Provision an isolated schema, then bind the shared Prisma client to it so
  // the tool-under-test writes into the same isolated data we seed. Env must be
  // set BEFORE the dynamic import that constructs the PrismaClient in lib/db.ts.
  testDb = await createTestDb();
  process.env.DATABASE_URL = testDb.databaseUrl;

  const agentTools = await import("./agentTools");
  dispatchTool = agentTools.dispatchTool;

  const db = await import("./db");
  prisma = db.prisma;

  // Seed a payer + patient + Case. The Case supplies the Trace_Step FK; the
  // patient lets the property exercise a genuine tool-success path.
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
      rawIntakeText: "raw intake for dispatch tracing test",
      status: "New",
      slaDeadline: new Date("2099-01-01T00:00:00.000Z"),
    },
  });
  caseId = seededCase.id;
}, 120_000);

afterAll(async () => {
  await testDb?.cleanup();
});

// ─── Generators ──────────────────────────────────────────────────────────────

const KNOWN_TOOLS = [
  "fetchPatientRecord",
  "fetchPayerPolicy",
  "checkPriorAuthHistory",
  "lookupDiagnosisCode",
  "generateAppealPdf",
] as const;

/** A single dispatch scenario: the tool name and the argument bag to dispatch. */
interface DispatchScenario {
  name: string;
  args: Record<string, unknown>;
}

const nonEmptyString = fc.string({ minLength: 1, maxLength: 20 });

/** Arbitrary values that survive a JSON round-trip (what dispatch persists). */
const jsonArgValue = fc.oneof(nonEmptyString, fc.integer(), fc.boolean());
const jsonArgs = fc.dictionary(fc.string({ maxLength: 10 }), jsonArgValue, {
  maxKeys: 4,
});

/**
 * Scenarios that resolve to a SUCCESS observation — none touch the network or
 * filesystem (payer-policy lookup with no match → null; history → []; and the
 * seeded-patient fetch → a real record, injected at build time via `patientId`).
 */
function successScenarioArb(patientId: string): fc.Arbitrary<DispatchScenario> {
  return fc.oneof(
    fc.record({
      name: fc.constant("fetchPayerPolicy"),
      args: fc.record({ payerId: nonEmptyString, procedureCode: nonEmptyString }),
    }),
    fc.record({
      name: fc.constant("checkPriorAuthHistory"),
      args: fc.record({ patientId: nonEmptyString }),
    }),
    fc.record({
      name: fc.constant("fetchPatientRecord"),
      args: fc.constant({ patientId }),
    }),
  );
}

/**
 * Scenarios that resolve to a FAILURE observation (dispatch catches the throw,
 * records a failure Trace_Step, and returns `{ ok: false }`). Every branch
 * fails BEFORE any external side effect.
 */
const failureScenarioArb: fc.Arbitrary<DispatchScenario> = fc.oneof(
  // Unknown tool name → invokeTool's default branch throws.
  fc.record({
    name: fc
      .string({ maxLength: 20 })
      .filter((s) => !(KNOWN_TOOLS as readonly string[]).includes(s)),
    args: jsonArgs,
  }),
  // Known tool, missing/invalid required args → requireStringArg throws.
  fc.record({ name: fc.constant("fetchPatientRecord"), args: fc.constant({}) }),
  fc.record({ name: fc.constant("fetchPayerPolicy"), args: fc.constant({}) }),
  fc.record({ name: fc.constant("checkPriorAuthHistory"), args: fc.constant({}) }),
  // lookupDiagnosisCode with no "code" arg → throws in requireStringArg
  // BEFORE any NIH network call (kept hermetic).
  fc.record({ name: fc.constant("lookupDiagnosisCode"), args: fc.constant({}) }),
  // generateAppealPdf with no "content" arg → throws while rendering BEFORE any
  // file is written (kept hermetic).
  fc.record({ name: fc.constant("generateAppealPdf"), args: fc.constant({}) }),
  // Known tool that runs but fails: fetch a patient id that does not exist.
  fc.record({
    name: fc.constant("fetchPatientRecord"),
    args: fc.record({ patientId: fc.constant("does-not-exist") }),
  }),
);

// ─── Property ─────────────────────────────────────────────────────────────────

describe("dispatchTool — resilient, always-traced dispatch (Task 7.8, Property 9)", () => {
  it("never throws, always returns an observation, and always writes a tool_call Trace_Step", async () => {
    const scenarioArb = fc.oneof(
      successScenarioArb(seededPatientId),
      failureScenarioArb,
    );

    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ name, args }) => {
        // Snapshot the Case's existing Trace_Steps so we can isolate the row
        // this single dispatch adds.
        const before = await prisma.traceStep.findMany({
          where: { caseId },
          select: { id: true },
        });
        const beforeIds = new Set(before.map((s) => s.id));

        // Dispatch MUST NOT throw. If it rejects, this await surfaces the
        // exception and fast-check reports the offending (name, args).
        const observation = await dispatchTool(name, args, caseId);

        // (1) An observation is always returned for the dispatched tool.
        expect(observation).toBeDefined();
        expect(observation.tool).toBe(name);
        expect(typeof observation.ok).toBe("boolean");
        if (observation.ok) {
          expect("result" in observation).toBe(true);
        } else {
          expect(typeof observation.error).toBe("string");
          expect(observation.error.length).toBeGreaterThan(0);
        }

        // (2) Exactly one new "tool_call" Trace_Step was recorded (Req 3.5/3.6).
        const after = await prisma.traceStep.findMany({ where: { caseId } });
        const added = after.filter((s) => !beforeIds.has(s.id));
        expect(added).toHaveLength(1);

        // (3) The Trace_Step captures the call: type, tool name, input, a
        //     non-empty reasoning, and a timestamp — on success AND failure.
        const step = added[0];
        expect(step.stepType).toBe("tool_call");
        expect(step.toolName).toBe(name);
        expect(step.input).toEqual(args);
        expect(typeof step.reasoning).toBe("string");
        expect(step.reasoning.length).toBeGreaterThan(0);
        expect(step.timestamp).toBeInstanceOf(Date);
        // A failure always records a non-null `{ error }` output describing the
        // failure (Req 3.6). A success records the tool's actual result, which
        // may legitimately be a JSON null (e.g. fetchPayerPolicy with no match),
        // so the non-null check applies only to the failure path.
        if (!observation.ok) {
          expect(step.output).not.toBeNull();
        }
      }),
      FC_CONFIG,
    );
  }, 300_000);
});

// ─── Focused unit tests (specific success / failure / resilience examples) ─────

describe("dispatchTool — representative examples", () => {
  it("returns a success observation and traces a successful tool call", async () => {
    const before = await prisma.traceStep.count({ where: { caseId } });
    const obs = await dispatchTool(
      "fetchPayerPolicy",
      { payerId: "no-such-payer", procedureCode: "00000" },
      caseId,
    );

    expect(obs.ok).toBe(true);
    if (obs.ok) expect(obs.result).toBeNull(); // no matching policy → null
    expect(await prisma.traceStep.count({ where: { caseId } })).toBe(before + 1);
  });

  it("returns an error observation (never throws) for an unknown tool and traces it", async () => {
    const obs = await dispatchTool("totallyUnknownTool", { foo: "bar" }, caseId);

    expect(obs.ok).toBe(false);
    if (!obs.ok) expect(obs.error).toContain("Unknown tool");

    const latest = await prisma.traceStep.findFirst({
      where: { caseId, toolName: "totallyUnknownTool" },
      orderBy: { timestamp: "desc" },
    });
    expect(latest?.stepType).toBe("tool_call");
  });

  it("returns an error observation (never throws) when a tool throws at runtime", async () => {
    const obs = await dispatchTool(
      "fetchPatientRecord",
      { patientId: "missing-patient" },
      caseId,
    );

    expect(obs.ok).toBe(false);
    if (!obs.ok) expect(obs.error).toContain("No patient record found");
  });

  it("traces the seeded-patient fetch as a success", async () => {
    const obs = await dispatchTool(
      "fetchPatientRecord",
      { patientId: seededPatientId },
      caseId,
    );

    expect(obs.ok).toBe(true);
  });
});
