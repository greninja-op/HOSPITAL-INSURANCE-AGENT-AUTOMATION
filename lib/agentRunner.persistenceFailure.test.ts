/**
 * lib/agentRunner.persistenceFailure.test.ts
 *
 * Property test (Task 11.26): persistence failure preserves the recommendation.
 *
 * Feature: authpilot, Property 52: Persistence failure preserves the recommendation.
 *
 *   For ANY Case in which persisting Strategy_Options or Verification_Result
 *   fails, the Agent_Runner records a failure Trace_Step and the Case's existing
 *   `recommendation` is retained unchanged (never overwritten).
 *
 * **Validates: Requirements 23.5**
 *
 * Strategy: drive the real `runAgent` pipeline end to end against an isolated,
 * throwaway PostgreSQL schema (via `createTestDb`), replacing only the network /
 * side-effecting seams with deterministic fakes (mirroring
 * `agentRunner.appealConditional.test.ts`):
 *
 *   • `./qwen`.callQwen is mocked to always COMPLETE a stage on its first
 *     iteration (`{ ok: true, toolCalls: [], content: "{}" }`) — no network.
 *   • `./decisionEngine`.decide is mocked to FORCE a DRAFTING Resolution_Path so
 *     the Decision_Intelligence stage assembles + persists a real
 *     `Case.recommendation` and the pipeline reaches the guarded
 *     Strategy / Verification_QA persistence writes.
 *   • `./appealPdf`.generateAppealPdf is stubbed (records the caseId, returns a
 *     fake url) so Appeal_Generation stores an `appealPdfUrl` and Verification_QA
 *     runs its full path (including the `verificationResult` write).
 *
 * To force a persistence failure we spy on the SHARED `prisma.case.update`
 * (the exact instance the runner imports from `./db`) and make ONLY the guarded
 * write whose `data` carries `strategyOptions` (Task 11.25 / Req 23.1) or
 * `verificationResult` (Req 23.2) throw. Every other Case update — including the
 * Decision_Intelligence write that persists `recommendation` — passes through to
 * the real client. At the moment of the injected failure we snapshot the Case's
 * current `recommendation`; after the run we assert it is byte-for-byte
 * unchanged and that a failure-describing Trace_Step was recorded.
 *
 * Uses Vitest + fast-check (numRuns 100), consistent with the rest of the suite.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { PrismaClient } from "@prisma/client";

import { FC_CONFIG } from "./testConfig";
import { createTestDb, type TestDb } from "./testDb";
import type { CaseStatus, QwenOutcome, ResolutionPath } from "./types";

// ─── Hoisted controller shared with the module mocks + the prisma spy ─────────
//
// `vi.mock` factories are hoisted above imports, so the mutable state they close
// over must be created with `vi.hoisted`. Each property sample re-configures the
// controller before invoking `runAgent`.
type GuardedField = "strategyOptions" | "verificationResult";

const controller = vi.hoisted(() => ({
  /** The decision the mocked `decide` returns for the current sample. */
  decision: null as { path: string; status: string } | null,
  /** Which guarded Case-update write should throw for the current sample. */
  failOn: null as GuardedField | null,
  /** Set true once the injected write actually threw (sanity guard). */
  failureInjected: false,
  /** The Case `recommendation` snapshot taken at the instant of the failure. */
  recommendationAtFailure: undefined as unknown,
  /** The injected error message, embedded into the failure Trace_Step. */
  injectedMessage: "",
}));

// FAKE Qwen: every stage completes immediately (no tool calls). Content "{}" is
// valid JSON so the JSON-parsing stages degrade cleanly to their empty/fallback
// shapes. Preserve every other `./qwen` export.
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

// FORCE the Resolution_Path so Decision_Intelligence persists a real
// recommendation and the pipeline reaches the guarded persistence writes.
// Preserve `computeOverallConfidence` and everything else via importActual.
vi.mock("./decisionEngine", async (importActual) => {
  const actual = await importActual<typeof import("./decisionEngine")>();
  return {
    ...actual,
    decide: () => controller.decision,
  };
});

// Stub the generate-appeal-PDF tool so a drafting path stores an appealPdfUrl
// and Verification_QA runs its full path. Preserve every other export.
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
  // Provision an isolated schema and bind the shared Prisma client to it BEFORE
  // importing the runner, so `lib/db.ts` and the runner write to the test schema.
  testDb = await createTestDb();
  process.env.DATABASE_URL = testDb.databaseUrl;

  const runner = await import("./agentRunner");
  runAgent = runner.runAgent;

  const db = await import("./db");
  prisma = db.prisma;

  // Spy on the SHARED prisma.case.update the runner uses. Capture the real
  // implementation first so non-targeted writes pass straight through.
  const originalUpdate = prisma.case.update.bind(prisma.case);
  vi.spyOn(prisma.case, "update").mockImplementation((async (args: {
    where: { id: string };
    data: Record<string, unknown>;
    select?: unknown;
  }) => {
    const data = args?.data ?? {};
    const target = controller.failOn;
    // Fail ONLY the specific guarded write (the one persisting the sampled
    // structured field); everything else — including the recommendation write —
    // is delegated to the real client unchanged.
    if (target && data[target] !== undefined) {
      // Snapshot the CURRENT (pre-failure) recommendation so we can prove it is
      // retained unchanged after the run.
      const current = await prisma.case.findUnique({
        where: args.where,
        select: { recommendation: true },
      });
      controller.recommendationAtFailure = current?.recommendation ?? null;
      controller.failureInjected = true;
      throw new Error(controller.injectedMessage);
    }
    return originalUpdate(args as never);
  }) as never);
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await testDb?.cleanup();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** The Case_Status the Decision_Engine derives for a drafting path. */
const DRAFTING_STATUS: CaseStatus = "AwaitingApproval";

/** Seed a fresh, independent Case (status New) for one property sample. */
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

/** Read the persisted recommendation for a Case (null when unset). */
async function readRecommendation(caseId: string): Promise<unknown> {
  const kase = await prisma.case.findUnique({
    where: { id: caseId },
    select: { recommendation: true },
  });
  return kase?.recommendation ?? null;
}

/** True iff some Trace_Step for the Case describes the injected failure. */
async function hasFailureTraceStep(
  caseId: string,
  needle: string,
): Promise<boolean> {
  const steps = await prisma.traceStep.findMany({
    where: { caseId },
    select: { reasoning: true },
  });
  return steps.some((s) => s.reasoning.includes(needle));
}

// ─── Generators ───────────────────────────────────────────────────────────────

/** Which guarded structured field's persistence write fails this sample. */
const guardedFieldArb: fc.Arbitrary<GuardedField> = fc.constantFrom(
  "strategyOptions",
  "verificationResult",
);

/** Drafting Resolution_Paths — force one so a recommendation is assembled. */
const draftingPathArb: fc.Arbitrary<ResolutionPath> = fc.constantFrom(
  "Auto_Draft",
  "Draft_And_Request_Evidence",
);

const intakeTypeArb = fc.constantFrom(
  "denial_letter",
  "new_pa_request",
  "phone_note",
  "whatsapp_patient_note",
);
const rawIntakeArb = fc.string({ minLength: 1, maxLength: 120 });

// ─── Property 52 ───────────────────────────────────────────────────────────────

describe("runAgent — persistence failure preserves the recommendation (Task 11.26, Property 52)", () => {
  it(
    "retains the existing recommendation unchanged and records a failure Trace_Step when a guarded persistence write fails",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          guardedFieldArb,
          draftingPathArb,
          intakeTypeArb,
          rawIntakeArb,
          fc.boolean(),
          async (failOn, path, intakeType, rawIntakeText, urgent) => {
            // Arrange: a fresh Case, a forced drafting decision, and the guarded
            // write that should fail this sample.
            const caseId = await seedCase(intakeType, rawIntakeText, urgent);
            controller.decision = { path, status: DRAFTING_STATUS };
            controller.failOn = failOn;
            controller.failureInjected = false;
            controller.recommendationAtFailure = undefined;
            controller.injectedMessage = `injected persistence failure on ${failOn} for ${caseId}`;

            // Act: run the real pipeline end to end. The guarded failure must be
            // absorbed by the runner rather than propagating.
            const result = await runAgent(caseId);

            // (0) The injected write actually fired (the property is meaningful).
            expect(controller.failureInjected).toBe(true);

            // (1) A failure-describing Trace_Step was recorded (Req 23.5).
            expect(
              await hasFailureTraceStep(caseId, controller.injectedMessage),
            ).toBe(true);

            // (2) The existing recommendation is retained unchanged — the stored
            //     value after the run deep-equals the pre-failure snapshot; the
            //     guarded write never overwrote it (Req 23.5).
            const after = await readRecommendation(caseId);
            expect(after).toEqual(controller.recommendationAtFailure);

            // (3) A persistence fault escalates to human rather than corrupting
            //     the run (Req 20.6 halt path).
            expect(result.resolutionPath).toBe("Escalate_To_Human");

            // (4) When the Verification_Result write fails, a real recommendation
            //     had already been persisted by Decision_Intelligence — so the
            //     "not overwritten" guarantee is exercised against a NON-null
            //     recommendation, not merely an absent one.
            if (failOn === "verificationResult") {
              expect(controller.recommendationAtFailure).not.toBeNull();
            }
          },
        ),
        FC_CONFIG,
      );
    },
    300_000,
  );
});

// ─── Focused examples (deterministic, illustrative) ───────────────────────────

describe("runAgent — persistence failure preserves the recommendation (representative examples)", () => {
  it("verificationResult write failure keeps the assembled recommendation intact", async () => {
    const caseId = await seedCase("denial_letter", "high-confidence denial", false);
    controller.decision = { path: "Auto_Draft", status: DRAFTING_STATUS };
    controller.failOn = "verificationResult";
    controller.failureInjected = false;
    controller.recommendationAtFailure = undefined;
    controller.injectedMessage = `injected persistence failure on verificationResult for ${caseId}`;

    await runAgent(caseId);

    expect(controller.failureInjected).toBe(true);
    // A real recommendation existed before the failure and survives unchanged.
    expect(controller.recommendationAtFailure).not.toBeNull();
    expect(await readRecommendation(caseId)).toEqual(
      controller.recommendationAtFailure,
    );
    expect(
      await hasFailureTraceStep(caseId, controller.injectedMessage),
    ).toBe(true);
  });

  it("strategyOptions write failure records a failure step and leaves the recommendation unchanged", async () => {
    const caseId = await seedCase("new_pa_request", "medium-confidence request", true);
    controller.decision = {
      path: "Draft_And_Request_Evidence",
      status: DRAFTING_STATUS,
    };
    controller.failOn = "strategyOptions";
    controller.failureInjected = false;
    controller.recommendationAtFailure = undefined;
    controller.injectedMessage = `injected persistence failure on strategyOptions for ${caseId}`;

    const result = await runAgent(caseId);

    expect(controller.failureInjected).toBe(true);
    // Strategy runs before Decision_Intelligence, so no recommendation is set;
    // the "unchanged" guarantee holds (null before and after).
    expect(await readRecommendation(caseId)).toEqual(
      controller.recommendationAtFailure,
    );
    expect(
      await hasFailureTraceStep(caseId, controller.injectedMessage),
    ).toBe(true);
    expect(result.resolutionPath).toBe("Escalate_To_Human");
  });
});
