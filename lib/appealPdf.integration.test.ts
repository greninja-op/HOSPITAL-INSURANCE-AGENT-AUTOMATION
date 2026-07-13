// =============================================================================
// lib/appealPdf.integration.test.ts
//
// Integration test (example-based) for the Appeal_Packet generator
// `generateAppealPdf` (lib/appealPdf.ts).
//
// Feature: authpilot, Task 8.3 — appeal PDF generation and storage.
//
// Requirement 7.4: WHEN the Appeal_Packet is generated, THE system SHALL persist
// it to a servable location and return a non-empty location reference.
//
// Unlike the property test in `lib/appealPdf.test.ts` (which verifies citation
// completeness), this test exercises the full generate-and-store path end to
// end: it renders a PDF for a concrete sample Case, asserts a non-empty stored
// location reference is returned, and confirms the referenced file actually
// exists on disk with non-zero size. The PDF written to public/appeals/ is
// removed in afterAll so the test leaves no artifacts behind.
// =============================================================================

import { promises as fs } from "fs";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";

import { generateAppealPdf } from "@/lib/appealPdf";
import type { AppealContent } from "@/lib/types";

// A distinct caseId keeps this integration test's artifact separate from the
// property test's file, so their afterAll cleanups never race.
const TEST_CASE_ID = "task83-integration-appeal";

/** Resolve the on-disk path for a returned `/appeals/<file>.pdf` url. */
function pdfPathForUrl(url: string): string {
  return path.join(process.cwd(), "public", url);
}

const sampleContent: AppealContent = {
  patientName: "Jane Doe",
  denialReason: "Service denied as not medically necessary (code 197).",
  policyClause: "LCD L34567 section 4.a — imaging coverage criteria.",
  supportingEvidence: [
    "Chart note 2026-02-10: MRI confirms L4-L5 herniation.",
    "Chart note 2026-01-05: six weeks of failed conservative therapy documented.",
  ],
  argument:
    "The documented imaging and failed conservative therapy satisfy the payer's " +
    "coverage criteria; the denial should be overturned.",
};

afterAll(async () => {
  // Remove the PDF this test persisted under public/appeals/.
  await fs.rm(pdfPathForUrl(`/appeals/${TEST_CASE_ID}.pdf`), { force: true });
});

describe("generateAppealPdf integration: generation and storage (Req 7.4)", () => {
  it("returns a non-empty stored location reference for a sample case", async () => {
    const result = await generateAppealPdf(TEST_CASE_ID, sampleContent);

    // A non-empty location reference is returned.
    expect(result.url).toBeTruthy();
    expect(typeof result.url).toBe("string");
    expect(result.url.length).toBeGreaterThan(0);
    expect(result.url).toBe(`/appeals/${TEST_CASE_ID}.pdf`);
  });

  it("persists the Appeal_Packet to the servable location with non-zero size", async () => {
    const { url } = await generateAppealPdf(TEST_CASE_ID, sampleContent);

    // The referenced file exists on disk.
    const filePath = pdfPathForUrl(url);
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);

    // The stored file has non-zero size.
    expect(stat.size).toBeGreaterThan(0);

    // Sanity: the stored bytes are a PDF document.
    const bytes = await fs.readFile(filePath);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
