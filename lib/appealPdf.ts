// =============================================================================
// lib/appealPdf.ts
//
// Appeal_Packet generator (Agent_Tool `generateAppealPdf`).
//
// Renders an evidence-cited appeal letter as a PDF using pdf-lib and persists it
// to a local, servable location under `public/appeals/<caseId>.pdf`. Next.js
// serves everything in `public/` from the site root, so a file written to
// `public/appeals/<caseId>.pdf` is reachable at the URL `/appeals/<caseId>.pdf`,
// which is what this function returns as the Appeal_Packet location reference.
//
// The rendered PDF cites the three pieces of evidence required by Requirement 7.3:
//   1. the denial reason,
//   2. the referenced Payer_Policy clause, and
//   3. the supporting Chart_Note evidence for the Case.
//
// Design constraints honored here:
//   - Deterministic: identical `content` (for a given caseId) produces the same
//     bytes — no timestamps, random ids, or ambient state leak into the document.
//   - Side-effect-contained: the only side effect is writing the PDF file (and
//     creating the target directory if missing). NO database access — the caller
//     passes a fully-assembled `AppealContent` (Requirement 7.2).
// =============================================================================

import { promises as fs } from "fs";
import path from "path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import type { AppealContent } from "./types";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Directory (relative to the project root) that Next.js serves statically. */
const APPEALS_DIR = path.join(process.cwd(), "public", "appeals");

/** Public URL prefix that maps to `public/appeals/`. */
const APPEALS_URL_PREFIX = "/appeals";

const PAGE_WIDTH = 612; // US Letter, 72dpi
const PAGE_HEIGHT = 792;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const TITLE_SIZE = 18;
const HEADING_SIZE = 12;
const BODY_SIZE = 10.5;
const LINE_GAP = 4;

// A fixed metadata date keeps generated documents byte-deterministic.
const FIXED_DATE = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Generate the Appeal_Packet PDF for a Case and persist it to a servable path.
 *
 * @param caseId  The Case identifier; used to name the output file.
 * @param content The appeal content derived from the Decision_Intelligence stage.
 * @returns       `{ url }` — a non-empty location reference to the stored PDF
 *                (Requirement 7.4).
 */
export async function generateAppealPdf(
  caseId: string,
  content: AppealContent,
): Promise<{ url: string }> {
  const fileName = `${sanitizeCaseId(caseId)}.pdf`;
  const filePath = path.join(APPEALS_DIR, fileName);

  const pdfBytes = await renderAppealPdf(content);

  // Ensure the servable directory exists, then persist the file.
  await fs.mkdir(APPEALS_DIR, { recursive: true });
  await fs.writeFile(filePath, pdfBytes);

  // Use POSIX-style separators for the URL regardless of host OS.
  return { url: `${APPEALS_URL_PREFIX}/${fileName}` };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/** Build the appeal PDF document bytes from the supplied content. */
async function renderAppealPdf(content: AppealContent): Promise<Uint8Array> {
  const doc = await PDFDocument.create();

  // Deterministic metadata — no wall-clock timestamps.
  doc.setTitle("Insurance Appeal Letter");
  doc.setAuthor("AuthPilot");
  doc.setProducer("AuthPilot");
  doc.setCreator("AuthPilot");
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const writer = new PdfWriter(doc, font, bold);

  writer.title("Insurance Appeal Letter");
  writer.gap(6);

  writer.paragraph(
    `On behalf of patient ${blankToPlaceholder(content.patientName)}, ` +
      "AuthPilot submits the following appeal in response to the payer's denial. " +
      "The determination is contested on the grounds set out below and is supported " +
      "by the cited payer policy and patient chart evidence.",
  );
  writer.gap(6);

  // (1) Denial reason (Requirement 7.3).
  writer.heading("Denial Reason");
  writer.paragraph(blankToPlaceholder(content.denialReason));
  writer.gap(4);

  // (2) Referenced Payer_Policy clause (Requirement 7.3).
  writer.heading("Referenced Payer Policy Clause");
  writer.paragraph(blankToPlaceholder(content.policyClause));
  writer.gap(4);

  // (3) Supporting Chart_Note evidence (Requirement 7.3).
  writer.heading("Supporting Chart Note Evidence");
  const evidence = content.supportingEvidence.filter((e) => e.trim().length > 0);
  if (evidence.length === 0) {
    writer.paragraph("(No supporting chart note evidence was provided.)");
  } else {
    for (const item of evidence) {
      writer.bullet(item);
    }
  }
  writer.gap(4);

  // Assembled argument body.
  writer.heading("Appeal Argument");
  writer.paragraph(blankToPlaceholder(content.argument));

  return doc.save();
}

/**
 * Stateful helper that lays out text top-to-bottom across as many pages as
 * needed, wrapping each line to the content width and adding new pages on
 * overflow.
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
    this.drawLines(wrapText(sanitize(text), this.bold, TITLE_SIZE, CONTENT_WIDTH), this.bold, TITLE_SIZE);
  }

  heading(text: string): void {
    this.ensureSpace(HEADING_SIZE + LINE_GAP);
    this.drawLines(wrapText(sanitize(text), this.bold, HEADING_SIZE, CONTENT_WIDTH), this.bold, HEADING_SIZE);
  }

  paragraph(text: string): void {
    this.drawLines(wrapText(sanitize(text), this.font, BODY_SIZE, CONTENT_WIDTH), this.font, BODY_SIZE);
  }

  bullet(text: string): void {
    const indent = 14;
    const lines = wrapText(sanitize(text), this.font, BODY_SIZE, CONTENT_WIDTH - indent);
    lines.forEach((line, i) => {
      const prefix = i === 0 ? "\u2022 " : "  ";
      this.drawLine(prefix + line, this.font, BODY_SIZE, MARGIN);
    });
  }

  gap(size: number): void {
    this.cursorY -= size;
  }

  private drawLines(lines: string[], font: PDFFont, size: number): void {
    for (const line of lines) {
      this.drawLine(line, font, size, MARGIN);
    }
  }

  private drawLine(text: string, font: PDFFont, size: number, x: number): void {
    this.ensureSpace(size + LINE_GAP);
    this.cursorY -= size;
    this.page.drawText(text, {
      x,
      y: this.cursorY,
      size,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
    this.cursorY -= LINE_GAP;
  }

  private ensureSpace(needed: number): void {
    if (this.cursorY - needed < MARGIN) {
      this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      this.cursorY = PAGE_HEIGHT - MARGIN;
    }
  }
}

// ─── Text helpers ────────────────────────────────────────────────────────────

/**
 * Word-wrap `text` to `maxWidth` using the metrics of `font` at `size`.
 * Preserves explicit newlines and hard-breaks single words longer than the line.
 */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  const paragraphs = text.split("\n");

  for (const paragraph of paragraphs) {
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
      // A single word wider than the line must be hard-broken by characters.
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

/**
 * Make `text` safe for the WinAnsi-encoded standard fonts: normalize common
 * Unicode punctuation and drop any remaining code points the encoding cannot
 * represent, so `drawText` never throws on exotic input. Deterministic.
 */
function sanitize(text: string): string {
  const replaced = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2018\u2019\u201A\u2039\u203A]/g, "'")
    .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, "-")
    .replace(/[\u2026]/g, "...")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/[\u2022\u2023\u25E6]/g, "\u2022")
    .replace(/\t/g, "    ");

  // Keep newlines plus printable Latin-1 (WinAnsi-representable) characters.
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

/** Present an empty/whitespace-only field as an explicit placeholder. */
function blankToPlaceholder(text: string): string {
  return text.trim().length > 0 ? text : "(not specified)";
}

/**
 * Reduce a caseId to a filesystem-safe file stem, preventing path traversal or
 * separator injection. Falls back to "appeal" if nothing usable remains.
 */
function sanitizeCaseId(caseId: string): string {
  const stem = caseId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return stem.length > 0 ? stem : "appeal";
}
