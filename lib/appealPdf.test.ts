// =============================================================================
// lib/appealPdf.test.ts
//
// Tests for the Appeal_Packet generator `generateAppealPdf` (lib/appealPdf.ts).
//
// Feature: authpilot, Property 20: Appeal packet cites required evidence
//
// Requirement 7.3: WHEN the generate-appeal-PDF Agent_Tool produces an
// Appeal_Packet, THE Appeal_Packet SHALL cite the denial reason, the referenced
// Payer_Policy clause, and the supporting Chart_Note evidence for the Case.
//
// The tool renders a PDF and returns only a `{ url }` location reference, so we
// read the persisted file back and extract its rendered text to verify every
// required citation is present. pdf-lib draws text as hex-encoded show operators
// inside (Flate-compressed) content streams, so the extractor inflates each
// stream and decodes the `<hex> Tj` / literal `(...)` string tokens. Because the
// renderer word-wraps long lines across multiple show operators, both the
// extracted text and the search needles are whitespace-normalized before the
// substring check — a wrapped citation still reconstructs contiguously.
// =============================================================================

import { promises as fs } from "fs";
import path from "path";
import zlib from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";

import { generateAppealPdf } from "@/lib/appealPdf";
import { FC_CONFIG } from "@/lib/testConfig";
import type { AppealContent } from "@/lib/types";

// A single, stable caseId keeps the property loop writing to one file, which is
// overwritten each iteration and removed after the suite runs.
const TEST_CASE_ID = "prop20-appeal-cite";

/** Resolve the on-disk path for a returned `/appeals/<file>.pdf` url. */
function pdfPathForUrl(url: string): string {
  return path.join(process.cwd(), "public", url);
}

/**
 * Extract the human-readable text rendered into a pdf-lib PDF.
 *
 * pdf-lib emits text via hex show-strings (`<...> Tj`) inside content streams
 * that `save()` Flate-compresses. We concatenate the raw bytes with every
 * inflatable stream, decode all hex/literal string tokens, drop bullet glyphs,
 * and collapse whitespace so wrapped lines rejoin into contiguous text.
 */
function extractPdfText(bytes: Uint8Array): string {
  const latin1 = Buffer.from(bytes).toString("latin1");
  const chunks: string[] = [latin1];

  const streamRe = /stream([\s\S]*?)endstream/g;
  let sm: RegExpExecArray | null;
  while ((sm = streamRe.exec(latin1)) !== null) {
    const body = sm[1].replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    const raw = Buffer.from(body, "latin1");
    for (const inflate of [zlib.inflateSync, zlib.inflateRawSync]) {
      try {
        chunks.push(inflate(raw).toString("latin1"));
        break;
      } catch {
        /* stream is not Flate-encoded; ignore */
      }
    }
  }

  const all = chunks.join("\n");
  const pieces: string[] = [];

  // Hex show-strings: <48454C...> Tj
  const hexRe = /<([0-9A-Fa-f\s]+)>/g;
  let hm: RegExpExecArray | null;
  while ((hm = hexRe.exec(all)) !== null) {
    const hex = hm[1].replace(/\s+/g, "");
    if (hex.length === 0 || hex.length % 2 !== 0) continue;
    pieces.push(Buffer.from(hex, "hex").toString("latin1"));
  }

  // Literal strings: (text) Tj — handled for completeness.
  const litRe = /\(((?:\\.|[^\\()])*)\)/g;
  let lm: RegExpExecArray | null;
  while ((lm = litRe.exec(all)) !== null) pieces.push(lm[1]);

  return normalize(pieces.join(" "));
}

/** Drop bullet glyphs and collapse all whitespace to single spaces. */
function normalize(text: string): string {
  return text.replace(/\u2022/g, " ").replace(/\s+/g, " ").trim();
}

/** Render `content` to a PDF and return its extracted, normalized text. */
async function renderAndExtract(content: AppealContent): Promise<string> {
  const { url } = await generateAppealPdf(TEST_CASE_ID, content);
  const bytes = await fs.readFile(pdfPathForUrl(url));
  return extractPdfText(bytes);
}

afterAll(async () => {
  // Remove the single PDF the tests persisted under public/appeals/.
  await fs.rm(path.join(process.cwd(), "public", "appeals", `${TEST_CASE_ID}.pdf`), {
    force: true,
  });
});

// ─── Generators ───────────────────────────────────────────────────────────────
// Tokens are uppercase-letters + digits so they never collide with the letter
// document boilerplate ("denial reason", "appeal", "patient", ...), keeping the
// completeness check honest: a dropped citation genuinely will not appear.
// Word lengths stay well under a wrapped line width so no single word is
// hard-broken mid-token across two show operators.

const tokenArb = fc
  .stringOf(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")), {
    minLength: 4,
    maxLength: 12,
  });

/** A non-blank phrase of 1..5 space-separated tokens. */
const phraseArb = fc
  .array(tokenArb, { minLength: 1, maxLength: 5 })
  .map((words) => words.join(" "));

/** 0..8 distinct-looking supporting Chart_Note evidence lines. */
const evidenceArb = fc.array(phraseArb, { minLength: 0, maxLength: 8 });

const appealContentArb: fc.Arbitrary<AppealContent> = fc.record({
  patientName: phraseArb,
  denialReason: phraseArb,
  policyClause: phraseArb,
  supportingEvidence: evidenceArb,
  argument: phraseArb,
});

// ─── Property 20 ────────────────────────────────────────────────────────────────

describe("Property 20: Appeal packet cites required evidence (Req 7.3)", () => {
  // **Validates: Requirements 7.3**
  it("cites the denial reason, the referenced policy clause, and every supplied chart-note evidence item (none dropped)", async () => {
    await fc.assert(
      fc.asyncProperty(appealContentArb, async (content) => {
        const text = await renderAndExtract(content);

        // (1) Denial reason is cited.
        expect(text).toContain(normalize(content.denialReason));

        // (2) Referenced Payer_Policy clause is cited.
        expect(text).toContain(normalize(content.policyClause));

        // (3) Each supporting Chart_Note evidence item is cited — none dropped.
        for (const item of content.supportingEvidence) {
          expect(text).toContain(normalize(item));
        }
      }),
      FC_CONFIG,
    );
  });
});

// ─── Example-based coverage ─────────────────────────────────────────────────────

describe("generateAppealPdf", () => {
  it("returns a servable /appeals/<caseId>.pdf url and writes the file", async () => {
    const { url } = await generateAppealPdf(TEST_CASE_ID, {
      patientName: "Jane Doe",
      denialReason: "Not medically necessary",
      policyClause: "LCD L12345 section 3.b",
      supportingEvidence: ["MRI dated 2026-01-02 confirms herniation"],
      argument: "The imaging satisfies the payer criteria.",
    });
    expect(url).toBe(`/appeals/${TEST_CASE_ID}.pdf`);
    const stat = await fs.stat(pdfPathForUrl(url));
    expect(stat.size).toBeGreaterThan(0);
  });

  it("cites all three required elements for a concrete appeal", async () => {
    const content: AppealContent = {
      patientName: "John Smith",
      denialReason: "EXPERIMENTAL_TREATMENT_CODE",
      policyClause: "POLICYCLAUSE_SECTION_7B",
      supportingEvidence: [
        "CHARTNOTE_A confirms failed conservative therapy",
        "CHARTNOTE_B documents progressive symptoms",
      ],
      argument: "Coverage is warranted under the cited criteria.",
    };
    const text = await renderAndExtract(content);
    expect(text).toContain(content.denialReason);
    expect(text).toContain(content.policyClause);
    for (const e of content.supportingEvidence) expect(text).toContain(normalize(e));
  });

  it("still cites the denial reason and clause when no evidence is provided", async () => {
    const content: AppealContent = {
      patientName: "No Evidence Patient",
      denialReason: "DENIAL_NOEVIDENCE_MARKER",
      policyClause: "CLAUSE_NOEVIDENCE_MARKER",
      supportingEvidence: [],
      argument: "Argument body.",
    };
    const text = await renderAndExtract(content);
    expect(text).toContain(content.denialReason);
    expect(text).toContain(content.policyClause);
  });
});
