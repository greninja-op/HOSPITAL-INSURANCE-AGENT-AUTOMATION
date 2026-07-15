// =============================================================================
// app/api/cases/route.invalidIntake.test.ts
//
// Property 2 — Invalid intake is rejected (Validates: Requirements 1.3, 1.4).
//
// For ANY invalid intake submission, POST /api/cases must reject it with a
// field-identifying HTTP 400 and create NO Case:
//   • blank / whitespace-only text with NO uploaded file → 400 identifying the
//     missing intake CONTENT (Req 1.3);
//   • a missing or invalid intake TYPE (with otherwise valid content) → 400
//     identifying the missing/invalid intake TYPE (Req 1.4).
//
// The POST handler kicks off `runAgent(caseId)` asynchronously (fire-and-forget,
// Req 1.5); a rejected intake never reaches that path, but we still mock
// `@/lib/agentRunner` → `runAgent` as a no-op so the suite stays hermetic even
// if the guard ever regresses. Persistence goes through the shared `prisma`
// singleton in `lib/db.ts`, which binds to DATABASE_URL when constructed on
// import; we provision an isolated throwaway schema via `createTestDb` and
// repoint DATABASE_URL BEFORE dynamically importing the route so any (unwanted)
// Case would land in the disposable schema where we can assert none was created.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { FC_CONFIG } from "@/lib/testConfig";
import { createTestDb, type TestDb } from "@/lib/testDb";
import type { IntakeType } from "@/lib/types";

// Prevent the real agent/model pipeline from running: the route fires
// `runAgent(caseId)` without awaiting it. A no-op keeps the test hermetic.
vi.mock("@/lib/agentRunner", () => ({
  runAgent: vi.fn(async () => undefined),
}));

// The four valid intake types (Req 1.1); anything else is invalid (Req 1.4).
const INTAKE_TYPES = [
  "denial_letter",
  "new_pa_request",
  "phone_note",
  "whatsapp_patient_note",
] as const satisfies readonly IntakeType[];

// Bound after DATABASE_URL is repointed (see beforeAll).
type RouteModule = typeof import("@/app/api/cases/route");
type DbModule = typeof import("@/lib/db");

let testDb: TestDb;
let route: RouteModule;
let db: DbModule;

beforeAll(async () => {
  // 1. Provision an isolated, disposable schema with the AuthPilot schema applied.
  testDb = await createTestDb();

  // 2. Repoint DATABASE_URL at the throwaway schema so the `lib/db.ts` singleton
  //    (used by the route) connects there when it is constructed on import.
  process.env.DATABASE_URL = testDb.databaseUrl;

  // 3. Import AFTER repointing so the route + shared prisma target the test
  //    schema. We read Case counts back through the same singleton.
  db = await import("@/lib/db");
  route = await import("@/app/api/cases/route");
}, 120_000);

afterAll(async () => {
  await db?.prisma.$disconnect().catch(() => {});
  await testDb?.cleanup();
});

/** Build a JSON POST Request the route handler accepts. */
function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/cases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A generated invalid intake plus which field the 400 must identify. */
interface InvalidIntake {
  body: Record<string, unknown>;
  /** "content" → Req 1.3 (missing intake content); "type" → Req 1.4. */
  offendingField: "content" | "type";
}

// Whitespace-only (or empty) text: blank after trimming (Req 1.3 trigger).
const blankText = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"), { maxLength: 8 })
  .map((chars) => chars.join(""));

// Non-empty, valid intake content (so the ONLY defect is the intake type).
const validText = fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0);

const validIntakeType = fc.constantFrom<IntakeType>(...INTAKE_TYPES);

// A missing or invalid intake type: omitted, null, a non-string, or any string
// that is not one of the four allowed values (Req 1.4 trigger).
const invalidIntakeType = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.integer(),
  fc.boolean(),
  fc.string().filter((s) => !(INTAKE_TYPES as readonly string[]).includes(s)),
);

// Case A (Req 1.3): blank/whitespace text, NO file. Because the route validates
// content BEFORE type, a valid type still yields a "missing content" rejection.
const blankContentIntake: fc.Arbitrary<InvalidIntake> = fc.record({
  text: blankText,
  intakeType: validIntakeType,
}).map((b) => ({ body: b, offendingField: "content" as const }));

// Case B (Req 1.4): valid content, but a missing/invalid intake type.
const invalidTypeIntake: fc.Arbitrary<InvalidIntake> = fc
  .record({ text: validText, intakeType: invalidIntakeType })
  .map((b) => {
    // Omit `intakeType` entirely when the generator picked `undefined`, to also
    // cover the "missing type" case (Req 1.4) rather than an explicit undefined.
    const body: Record<string, unknown> = { text: b.text };
    if (b.intakeType !== undefined) body.intakeType = b.intakeType;
    return { body, offendingField: "type" as const };
  });

const invalidIntake = fc.oneof(blankContentIntake, invalidTypeIntake);

describe("POST /api/cases — Property 2: invalid intake is rejected (Req 1.3, 1.4)", () => {
  it("returns a field-identifying 400 and creates NO Case for any invalid intake", async () => {
    await fc.assert(
      fc.asyncProperty(invalidIntake, async ({ body, offendingField }) => {
        const before = await db.prisma.case.count();

        const res = await route.POST(jsonRequest(body));

        // Rejected with HTTP 400 (Req 1.3 / 1.4).
        expect(res.status).toBe(400);

        // The message identifies the offending field.
        const payload = (await res.json()) as { error: string };
        expect(typeof payload.error).toBe("string");
        if (offendingField === "content") {
          expect(payload.error).toMatch(/intake content/i);
        } else {
          expect(payload.error).toMatch(/intake type/i);
        }

        // NO Case was created — the count is unchanged after the rejection.
        const after = await db.prisma.case.count();
        expect(after).toBe(before);
      }),
      FC_CONFIG,
    );
  }, 300_000);
});
