// =============================================================================
// app/api/cases/[id]/audit/export/route.ts
//
// GET /api/cases/[id]/audit/export — Audit_Trail export (Requirement 9.4).
//
// Loads the Case's Extracted_Field and Trace_Step records via the shared Prisma
// client, merges them chronologically with `mergeAuditTrail` (Requirement 9.3),
// and renders the full merged Audit_Trail — together with the persisted
// Strategy_Options and Verification_Result stored on the Case (Requirement 23.4)
// — as a PDF using pdf-lib. Returns the bytes as `application/pdf`.
//
// Returns 404 for an unknown Case id. Runs on the Node.js runtime because
// pdf-lib performs Buffer/stream work not available on the edge runtime.
// =============================================================================

import { NextResponse } from "next/server";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

import { prisma } from "@/lib/db";
import {
  mergeAuditTrail,
  type MergedAuditEntry,
  type TraceStepRecord,
} from "@/lib/audit";
import type { StrategyOptions, VerificationResult } from "@/lib/types";

export const runtime = "nodejs";

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const caseId = params.id;

  const caseRecord = await prisma.case.findUnique({
    where: { id: caseId },
    include: { extractedFields: true, traceSteps: true },
  });

  // 404 for an unknown Case (Requirement 9.4 targets an existing Case).
  if (!caseRecord) {
    return NextResponse.json({ error: "Case not found" }, { status: 404 });
  }

  const merged = mergeAuditTrail(
    caseRecord.extractedFields,
    caseRecord.traceSteps,
  );

  const pdfBytes = await renderAuditPdf(caseId, merged, {
    status: caseRecord.status,
    intakeType: caseRecord.intakeType,
    payerName: caseRecord.payerName,
    resolutionPath: caseRecord.resolutionPath,
    overallConfidence: caseRecord.overallConfidence,
    // Persisted, unchanged from what the Strategy / Verification_QA stages
    // stored, retrievable independently of the recommendation (Req 23.4).
    strategyOptions: caseRecord.strategyOptions as StrategyOptions | null,
    verificationResult: caseRecord.verificationResult as VerificationResult | null,
  });

  // Copy into a fresh ArrayBuffer-backed view so the body is a concrete
  // BlobPart regardless of the ArrayBufferLike backing pdf-lib returns.
  const body = new Uint8Array(pdfBytes);
  return new NextResponse(new Blob([body], { type: "application/pdf" }), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="audit-${sanitizeCaseId(caseId)}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}

// ─── PDF rendering ─────────────────────────────────────────────────────────────

const PAGE_WIDTH = 612; // US Letter, 72dpi
const PAGE_HEIGHT = 792;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const TITLE_SIZE = 18;
const HEADING_SIZE = 12;
const LABEL_SIZE = 10.5;
const BODY_SIZE = 10;
const LINE_GAP = 4;

interface CaseSummary {
  status: string;
  intakeType: string;
  payerName: string | null;
  resolutionPath: string | null;
  overallConfidence: number | null;
  strategyOptions: StrategyOptions | null;
  verificationResult: VerificationResult | null;
}

/** Build the Audit_Trail PDF bytes for a Case. */
async function renderAuditPdf(
  caseId: string,
  merged: MergedAuditEntry[],
  summary: CaseSummary,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`AuthPilot Audit Trail — Case ${caseId}`);
  doc.setAuthor("AuthPilot");
  doc.setProducer("AuthPilot");
  doc.setCreator("AuthPilot");

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const writer = new PdfWriter(doc, font, bold);

  writer.title("AuthPilot Audit Trail");
  writer.gap(4);
  writer.label(`Case ID: ${caseId}`);
  writer.label(`Status: ${summary.status}`);
  writer.label(`Intake type: ${summary.intakeType}`);
  if (summary.payerName) writer.label(`Payer: ${summary.payerName}`);
  if (summary.resolutionPath) {
    writer.label(`Resolution path: ${summary.resolutionPath}`);
  }
  if (summary.overallConfidence != null) {
    writer.label(`Overall confidence: ${summary.overallConfidence}`);
  }
  writer.gap(8);

  // ── Merged chronological trail (Requirements 9.3, 9.4) ──────────────────────
  writer.heading(`Chronological Audit Trail (${merged.length} records)`);
  writer.gap(2);

  if (merged.length === 0) {
    writer.body("(No audit records recorded for this case.)");
  } else {
    merged.forEach((entry, index) => {
      const ts = formatTimestamp(entry.timestamp);
      if (entry.kind === "extracted_field") {
        const f = entry.field;
        writer.label(
          `${index + 1}. [${ts}] EXTRACTED_FIELD — ${f.fieldName}`,
        );
        writer.body(`Value: ${f.value}`);
        writer.body(
          `Confidence: ${f.confidence}   Source: ${f.sourceType}`,
        );
        if (f.reasoning) writer.body(`Reasoning: ${f.reasoning}`);
      } else {
        const s = entry.step;
        const toolSuffix = s.toolName ? ` — ${s.toolName}` : "";
        writer.label(
          `${index + 1}. [${ts}] TRACE_STEP — ${s.stepType}${toolSuffix}`,
        );
        if (s.reasoning) writer.body(`Reasoning: ${s.reasoning}`);
        const inputText = stringifyJson(s.input);
        if (inputText) writer.body(`Input: ${inputText}`);
        const outputText = stringifyJson(s.output);
        if (outputText) writer.body(`Output: ${outputText}`);
      }
      writer.gap(4);
    });
  }

  // ── Persisted Strategy_Options (Requirement 23.4) ───────────────────────────
  writer.gap(6);
  writer.heading("Strategy Options");
  const strategy = summary.strategyOptions;
  if (!strategy || !Array.isArray(strategy.options) || strategy.options.length === 0) {
    writer.body("(No strategy options stored for this case.)");
  } else {
    writer.body(
      `Used prior-auth history: ${strategy.usedPriorAuthHistory ? "yes" : "no"}`,
    );
    if (strategy.payerTrackRecordSummary) {
      writer.body(`Payer track record: ${strategy.payerTrackRecordSummary}`);
    }
    strategy.options.forEach((opt, i) => {
      writer.body(
        `${i + 1}. (${opt.winProbability}% win) ${opt.approach}`,
      );
      if (opt.rationale) writer.body(`   Rationale: ${opt.rationale}`);
    });
  }

  // ── Persisted Verification_Result (Requirement 23.4) ────────────────────────
  writer.gap(6);
  writer.heading("Verification Result");
  const verification = summary.verificationResult;
  if (!verification) {
    writer.body("(No verification result stored for this case.)");
  } else {
    writer.body(`Status: ${verification.status}`);
    const issues = Array.isArray(verification.flaggedIssues)
      ? verification.flaggedIssues
      : [];
    if (issues.length === 0) {
      writer.body("No flagged issues.");
    } else {
      issues.forEach((issue, i) => {
        writer.body(
          `${i + 1}. [${issue.severity}] ${issue.type} — ${issue.reference}`,
        );
        if (issue.detail) writer.body(`   ${issue.detail}`);
      });
    }
  }

  return doc.save();
}

/**
 * Stateful helper that lays out text top-to-bottom across as many pages as
 * needed, wrapping each line to the content width and adding pages on overflow.
 */
class PdfWriter {
  private page: PDFPage;
  private cursorY: number;

  constructor(
    private readonly doc: PDFDocument,
    private readonly font: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.cursorY = PAGE_HEIGHT - MARGIN;
  }

  title(text: string): void {
    this.draw(text, this.bold, TITLE_SIZE, MARGIN);
  }

  heading(text: string): void {
    this.ensureSpace(HEADING_SIZE + LINE_GAP);
    this.draw(text, this.bold, HEADING_SIZE, MARGIN);
  }

  label(text: string): void {
    this.draw(text, this.bold, LABEL_SIZE, MARGIN);
  }

  body(text: string): void {
    this.draw(text, this.font, BODY_SIZE, MARGIN);
  }

  gap(size: number): void {
    this.cursorY -= size;
  }

  private draw(text: string, font: PDFFont, size: number, x: number): void {
    const lines = wrapText(sanitize(text), font, size, CONTENT_WIDTH - (x - MARGIN));
    for (const line of lines) {
      this.ensureSpace(size + LINE_GAP);
      this.cursorY -= size;
      this.page.drawText(line, {
        x,
        y: this.cursorY,
        size,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });
      this.cursorY -= LINE_GAP;
    }
  }

  private ensureSpace(needed: number): void {
    if (this.cursorY - needed < MARGIN) {
      this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      this.cursorY = PAGE_HEIGHT - MARGIN;
    }
  }
}

// ─── Text helpers ──────────────────────────────────────────────────────────────

/** Word-wrap `text` to `maxWidth`, preserving newlines and hard-breaking long words. */
function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line.length > 0) {
        out.push(line);
        line = "";
      }
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        let chunk = "";
        for (const ch of word) {
          const next = chunk + ch;
          if (font.widthOfTextAtSize(next, size) > maxWidth && chunk.length > 0) {
            out.push(chunk);
            chunk = ch;
          } else {
            chunk = next;
          }
        }
        line = chunk;
      } else {
        line = word;
      }
    }
    if (line.length > 0) out.push(line);
  }
  return out;
}

/** Normalize common Unicode punctuation and drop non-WinAnsi code points. */
function sanitize(text: string): string {
  const replaced = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2018\u2019\u201A\u2039\u203A]/g, "'")
    .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, "-")
    .replace(/[\u2026]/g, "...")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/\t/g, "    ");

  let cleaned = "";
  for (const ch of replaced) {
    const code = ch.codePointAt(0)!;
    if (ch === "\n" || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      cleaned += ch;
    } else {
      cleaned += "?";
    }
  }
  return cleaned;
}

/** Compactly stringify a Trace_Step input/output JSON value, or "" when empty. */
function stringifyJson(value: TraceStepRecord["input"]): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** ISO-8601 timestamp; falls back to the raw value if not a valid Date. */
function formatTimestamp(timestamp: Date): string {
  const time = timestamp instanceof Date ? timestamp.getTime() : NaN;
  return Number.isNaN(time) ? String(timestamp) : timestamp.toISOString();
}

/** Reduce a caseId to a filename-safe stem for the Content-Disposition header. */
function sanitizeCaseId(caseId: string): string {
  const stem = caseId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return stem.length > 0 ? stem : "case";
}
