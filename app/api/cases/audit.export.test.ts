// =============================================================================
// app/api/cases/audit.export.test.ts
//
// Integration test (example-based) for GET /api/cases/[id]/audit/export
// (Validates: Requirement 9.4 — export the full Audit_Trail as a PDF).
//
// Seeds a Case with several Extracted_Field and Trace_Step records (plus the
// persisted Strategy_Options / Verification_Result the route also renders),
// calls the real export GET handler, and asserts the response is a valid,
// non-empty PDF (application/pdf + `%PDF-` magic header) that re-parses with
// pages and carries the Case id in its embedded title — confirming the export
// was built from THIS Case's full trail rather than an empty document.
//
// Persistence flows through the shared `prisma` singleton in `lib/db.ts`, which
// binds to DATABASE_URL when constructed on import. We therefore provision an
// isolated throwaway schema via `createTestDb` and repoint DATABASE_URL BEFORE
// dynamically importing the route, so every seeded row lands in the disposable
// schema and the route reads back through the same singleton.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createTestDb, type TestDb } from "@/lib/testDb";

// Bound after DATABASE_URL is repointed (see beforeAll).
type RouteModule = typeof import("@/app/api/cases/[id]/audit/export/route");
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

  // 3. Import AFTER repointing so the route + shared prisma read/write the test schema.
  db = await import("@/lib/db");
  route = await import("@/app/api/cases/[id]/audit/export/route");
}, 120_000);

afterAll(async () => {
  await db?.prisma.$disconnect().catch(() => {});
  await testDb?.cleanup();
});

/** Fixed base epoch for generated timestamps: 2026-01-01T00:00:00.000Z. */
const BASE_EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
const STEP_MS = 1_000;

/** Build the export GET request URL for a given Case id. */
function exportRequest(caseId: string): Request {
  return new Request(`http://localhost/api/cases/${caseId}/audit/export`);
}

/** Read a Response body as raw bytes regardless of Blob/stream backing. */
async function bodyBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

describe("GET /api/cases/[id]/audit/export — audit PDF export (Req 9.4)", () => {
  it("returns a valid, non-empty PDF built from the Case's full audit trail", async () => {
    // ── Seed a Case with a full trail: several extracted fields + trace steps,
    //    plus the persisted Strategy_Options / Verification_Result. ────────────
    const created = await db.prisma.case.create({
      data: {
        intakeType: "denial_letter",
        rawIntakeText: "Payer denied prior auth for CPT 27447 citing missing conservative therapy.",
        status: "Investigating",
        payerName: "Acme Health",
        resolutionPath: "Draft_And_Request_Evidence",
        overallConfidence: 0.82,
        slaDeadline: new Date(BASE_EPOCH + 10_000 * STEP_MS),
        strategyOptions: {
          usedPriorAuthHistory: true,
          payerTrackRecordSummary: "Acme approves 70% of orthopedic appeals",
          options: [
            {
              approach: "Cite LCD L34567 with documented 6-week PT trial",
              winProbability: 74,
              rationale: "Strongest match to payer criteria",
            },
            {
              approach: "Request peer-to-peer review",
              winProbability: 55,
              rationale: "Fallback if documentation is contested",
            },
          ],
        },
        verificationResult: {
          status: "fail",
          flaggedIssues: [
            {
              type: "missing_evidence",
              severity: "high",
              reference: "PT trial documentation",
              detail: "No chart note confirming 6 weeks of physical therapy",
            },
          ],
        },
      },
    });

    try {
      // Extracted_Field records at distinct timestamps.
      const fields = [
        { fieldName: "procedureCode", value: "27447", sourceType: "raw_intake" },
        { fieldName: "denialReason", value: "missing conservative therapy", sourceType: "raw_intake" },
        { fieldName: "diagnosisCode", value: "M17.11", sourceType: "chart_note" },
      ];
      for (let i = 0; i < fields.length; i++) {
        await db.prisma.extractedField.create({
          data: {
            caseId: created.id,
            fieldName: fields[i].fieldName,
            value: fields[i].value,
            confidence: 0.9,
            sourceType: fields[i].sourceType,
            reasoning: `extracted ${fields[i].fieldName}`,
            timestamp: new Date(BASE_EPOCH + i * STEP_MS),
          },
        });
      }

      // Trace_Step records at distinct (later) timestamps.
      const steps = [
        { stepType: "tool_call", toolName: "fetchPayerPolicy", reasoning: "looked up payer policy" },
        { stepType: "medical_review", toolName: null, reasoning: "assessed medical necessity" },
        { stepType: "strategy", toolName: null, reasoning: "ranked appeal approaches" },
        { stepType: "verification", toolName: null, reasoning: "checked for grounding issues" },
      ];
      for (let i = 0; i < steps.length; i++) {
        await db.prisma.traceStep.create({
          data: {
            caseId: created.id,
            stepType: steps[i].stepType,
            toolName: steps[i].toolName,
            input: { note: `input ${i}` },
            output: { note: `output ${i}` },
            reasoning: steps[i].reasoning,
            prevHash: `prev-${i}`,
            hash: `hash-${i}`,
            timestamp: new Date(BASE_EPOCH + (100 + i) * STEP_MS),
          },
        });
      }

      // ── Call the real export handler. ───────────────────────────────────────
      const res = await route.GET(exportRequest(created.id), {
        params: { id: created.id },
      });

      // Valid PDF response: 200 + application/pdf content type.
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");

      // Non-empty body with the PDF magic header.
      const bytes = await bodyBytes(res);
      expect(bytes.byteLength).toBeGreaterThan(0);
      const header = new TextDecoder("latin1").decode(bytes.subarray(0, 5));
      expect(header).toBe("%PDF-");

      // Re-parse the bytes to confirm a structurally valid, multi-record PDF and
      // that it was built for THIS Case (title embeds the case id) — i.e. the
      // export reflects the seeded trail, not an empty document.
      const reloaded = await PDFDocument.load(bytes);
      expect(reloaded.getPageCount()).toBeGreaterThan(0);
      expect(reloaded.getTitle() ?? "").toContain(created.id);
    } finally {
      // Isolate: remove this run's rows.
      await db.prisma.extractedField.deleteMany({ where: { caseId: created.id } });
      await db.prisma.traceStep.deleteMany({ where: { caseId: created.id } });
      await db.prisma.case.delete({ where: { id: created.id } });
    }
  }, 120_000);

  it("returns 404 for an unknown Case id", async () => {
    const res = await route.GET(exportRequest("does-not-exist"), {
      params: { id: "does-not-exist" },
    });
    expect(res.status).toBe(404);
  });
});
