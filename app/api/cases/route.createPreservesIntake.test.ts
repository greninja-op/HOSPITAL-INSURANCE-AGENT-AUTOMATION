// =============================================================================
// app/api/cases/route.createPreservesIntake.test.ts
//
// Property 1 — Case creation preserves intake (Validates: Requirements 1.1).
//
// For ANY valid intake, POST /api/cases must persist the intake EXACTLY: the
// created Case carries the same rawIntakeText (the documented behaviour trims
// surrounding whitespace — Req 1.1 stores the raw intake text), the same
// intakeType, and the same urgent flag — nothing lost or altered.
//
// The POST handler kicks off `runAgent(caseId)` asynchronously (fire-and-forget,
// Req 1.5). We MUST prevent the real agent/model from running, so we mock
// `@/lib/agentRunner` → `runAgent` as a no-op. Persistence goes through the
// shared `prisma` singleton in `lib/db.ts`, which binds to DATABASE_URL when it
// is constructed on import; we therefore provision an isolated throwaway schema
// via `createTestDb` and repoint DATABASE_URL BEFORE dynamically importing the
// route, so every created Case lands in the disposable schema.
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

// The four valid intake types (Req 1.1).
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

  // 3. Import AFTER repointing so the route + shared prisma persist into the
  //    test schema. The route reads the same singleton we read back through.
  db = await import("@/lib/db");
  route = await import("@/app/api/cases/route");
}, 120_000);

afterAll(async () => {
  await db?.prisma.$disconnect().catch(() => {});
  await testDb?.cleanup();
});

/** Build a JSON POST Request the route handler accepts (Req 1.1 create path). */
function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/cases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/cases — Property 1: case creation preserves intake (Req 1.1)", () => {
  it("persists rawIntakeText, intakeType and urgent flag exactly for any valid intake", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Intake text that is non-empty after trimming, so it is a VALID intake
        // (Req 1.3) — the property is about preservation, not the empty guard.
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        fc.constantFrom<IntakeType>(...INTAKE_TYPES),
        fc.boolean(),
        async (text, intakeType, urgent) => {
          const res = await route.POST(jsonRequest({ text, intakeType, urgent }));

          // Create path returns 201 with the new caseId (Req 1.5).
          expect(res.status).toBe(201);
          const payload = (await res.json()) as { caseId: string };
          expect(typeof payload.caseId).toBe("string");
          expect(payload.caseId.length).toBeGreaterThan(0);

          // Read the persisted Case back through the same singleton.
          const created = await db.prisma.case.findUnique({
            where: { id: payload.caseId },
          });

          expect(created).not.toBeNull();
          // Intake preserved EXACTLY — nothing lost or altered. rawIntakeText is
          // the raw intake text (Req 1.1); the documented create path trims
          // surrounding whitespace, so the persisted value equals text.trim().
          expect(created!.rawIntakeText).toBe(text.trim());
          expect(created!.intakeType).toBe(intakeType);
          expect(created!.isUrgent).toBe(urgent);
          // The Case is created with status New (Req 1.1 context).
          expect(created!.status).toBe("New");
        },
      ),
      FC_CONFIG,
    );
  }, 300_000);
});
