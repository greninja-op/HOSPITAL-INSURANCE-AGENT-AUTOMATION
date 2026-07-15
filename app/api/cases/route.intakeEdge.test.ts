// =============================================================================
// app/api/cases/route.intakeEdge.test.ts
//
// Example / integration tests for two intake edge behaviours of POST /api/cases
// (NOT property tests):
//
//   • Req 1.5 — When a Case is created, the endpoint returns the caseId to the
//     Operator IMMEDIATELY, without waiting for the agent run to finish. We mock
//     `@/lib/agentRunner` → `runAgent` with a promise that never resolves during
//     the test; the POST must still return 201 with a caseId while that promise
//     is still pending (proving the handler fires the agent as fire-and-forget
//     and does not await it).
//
//   • Req 1.2 — When a PDF is uploaded, the route extracts the PDF's text via
//     pdf-lib and stores it as the Case raw Intake text. We build a small real
//     PDF with pdf-lib carrying a distinctive marker, POST it as multipart/form
//     -data, and assert the persisted Case.rawIntakeText contains that marker.
//
// Setup mirrors `route.createPreservesIntake.test.ts`: mock the agent runner so
// the real model pipeline never runs, provision an isolated throwaway schema via
// `createTestDb`, repoint DATABASE_URL BEFORE dynamically importing the route so
// the shared `lib/db.ts` prisma singleton persists into the disposable schema.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createTestDb, type TestDb } from "@/lib/testDb";

// Hoisted control for the mocked agent runner. `runAgent` returns a promise that
// stays PENDING for the duration of the test unless `complete()` is called, so a
// POST that returns while `isCompleted()` is still false proves the handler did
// not await the agent run (Req 1.5).
const agentControl = vi.hoisted(() => {
  let completed = false;
  let resolveFn: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = () => {
      completed = true;
      resolve();
    };
  });
  return {
    promise,
    isCompleted: () => completed,
    complete: () => resolveFn?.(),
  };
});

vi.mock("@/lib/agentRunner", () => ({
  runAgent: vi.fn(() => agentControl.promise),
}));

// Bound after DATABASE_URL is repointed (see beforeAll).
type RouteModule = typeof import("@/app/api/cases/route");
type DbModule = typeof import("@/lib/db");
type AgentModule = typeof import("@/lib/agentRunner");

let testDb: TestDb;
let route: RouteModule;
let db: DbModule;
let agent: AgentModule;

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
  agent = await import("@/lib/agentRunner");
}, 120_000);

afterAll(async () => {
  // Release the pending agent promise so nothing is left dangling, then tear the
  // schema down.
  agentControl.complete();
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

/**
 * Build a small, real PDF whose visible text contains `marker`, returned as the
 * raw bytes the route would receive from an uploaded file (Req 1.2).
 */
async function buildPdfBytes(marker: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(marker, { x: 72, y: 700, size: 18, font });
  return doc.save();
}

/**
 * Build a multipart/form-data POST Request carrying an uploaded PDF `file`, an
 * intake type, and (optionally) typed text — the shape the route's form-data
 * branch parses (Req 1.2 upload path).
 */
function pdfUploadRequest(
  pdfBytes: Uint8Array,
  intakeType: string,
  text = "",
): Request {
  const form = new FormData();
  form.set("intakeType", intakeType);
  if (text) form.set("text", text);
  const blob = new Blob([pdfBytes], { type: "application/pdf" });
  form.set("file", blob, "denial.pdf");
  return new Request("http://localhost/api/cases", {
    method: "POST",
    body: form,
  });
}

describe("POST /api/cases — intake edge behaviours", () => {
  // Req 1.5 — immediate caseId return without waiting for the agent run.
  it("returns 201 with the caseId immediately, without waiting for runAgent to finish (Req 1.5)", async () => {
    const runAgent = vi.mocked(agent.runAgent);
    runAgent.mockClear();

    const res = await route.POST(
      jsonRequest({ text: "Payer denied MRI for lower back pain.", intakeType: "denial_letter" }),
    );

    // The create path returns 201 with the new caseId (Req 1.5).
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { caseId: string };
    expect(typeof payload.caseId).toBe("string");
    expect(payload.caseId.length).toBeGreaterThan(0);

    // The agent run was kicked off with the new caseId ...
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledWith(payload.caseId);

    // ... but its promise is STILL pending: the response came back before the
    // agent run completed, proving the handler did not await runAgent (Req 1.5).
    expect(agentControl.isCompleted()).toBe(false);

    // The Case was persisted with status "New".
    const created = await db.prisma.case.findUnique({ where: { id: payload.caseId } });
    expect(created).not.toBeNull();
    expect(created!.status).toBe("New");
  }, 60_000);

  // Req 1.2 — PDF upload: text extracted via pdf-lib and stored as raw intake.
  it("extracts uploaded PDF text via pdf-lib and stores it as the Case rawIntakeText (Req 1.2)", async () => {
    const marker = "PriorAuthDenialMarker7788";
    const pdfBytes = await buildPdfBytes(marker);

    const res = await route.POST(pdfUploadRequest(pdfBytes, "denial_letter"));

    expect(res.status).toBe(201);
    const payload = (await res.json()) as { caseId: string };
    expect(typeof payload.caseId).toBe("string");
    expect(payload.caseId.length).toBeGreaterThan(0);

    // The persisted raw intake text is the text extracted from the uploaded PDF.
    const created = await db.prisma.case.findUnique({ where: { id: payload.caseId } });
    expect(created).not.toBeNull();
    expect(created!.rawIntakeText).toContain(marker);
    expect(created!.intakeType).toBe("denial_letter");
  }, 60_000);
});
