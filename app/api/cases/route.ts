// =============================================================================
// app/api/cases/route.ts
//
// GET /api/cases — list every Case for the Dashboard Kanban board and the
// denials analytics widget (Requirement 10.1).
//
// Returns a flat list of lightweight Case summaries. The Dashboard groups the
// list by `status` client-side into the seven Case_Status columns (New,
// Investigating, NeedsHumanInput, AwaitingApproval, AppealSent, Resolved,
// DeniedFinal). Each summary carries exactly the fields a Case card needs:
// patient name (for initials), payer, procedure/denial reason, the overall
// Confidence_Score, the urgency flag, and the SLA_Clock deadline.
//
// Uses the shared Prisma client (`lib/db.ts`) so we reuse the single connection
// pool. Runs on the Node.js runtime because Prisma is not edge-compatible.
// =============================================================================

import { NextResponse } from "next/server";
import { z } from "zod";
import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { prisma } from "@/lib/db";
import { slaDeadline } from "@/lib/sla";
import { runAgent } from "@/lib/agentRunner";
import type { CaseStatus, IntakeType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One Case as rendered on a Dashboard Kanban card + denials widget. */
export interface CaseSummary {
  id: string;
  status: CaseStatus;
  payerName: string | null;
  isUrgent: boolean;
  slaDeadline: string;
  overallConfidence: number | null;
  denialReason: string | null;
  /** Patient display name; the client derives initials for the avatar. */
  patientName: string | null;
  createdAt: string;
}

export type ListCasesResponse = CaseSummary[];

export async function GET(): Promise<NextResponse<ListCasesResponse>> {
  const cases = await prisma.case.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      payerName: true,
      isUrgent: true,
      slaDeadline: true,
      overallConfidence: true,
      denialReason: true,
      createdAt: true,
      patient: { select: { name: true } },
    },
  });

  const summaries: ListCasesResponse = cases.map((c) => ({
    id: c.id,
    status: c.status as CaseStatus,
    payerName: c.payerName,
    isUrgent: c.isUrgent,
    slaDeadline: c.slaDeadline.toISOString(),
    overallConfidence: c.overallConfidence,
    denialReason: c.denialReason,
    patientName: c.patient?.name ?? null,
    createdAt: c.createdAt.toISOString(),
  }));

  return NextResponse.json(summaries);
}

// =============================================================================
// POST /api/cases — create a Case from an Intake and kick off the agent.
//
// Ingests a messy trigger (denial letter, prior-auth request, phone note, or a
// WhatsApp patient note) submitted either as JSON or as multipart/form-data with
// an optional uploaded PDF. It:
//
//   1. Validates the intake with zod (Requirements 1.3, 1.4, 1.7):
//        • rejects empty/whitespace text with NO uploaded file, returning a 400
//          that identifies the missing intake CONTENT (Req 1.3);
//        • rejects a missing/invalid intake TYPE, returning a 400 that identifies
//          the missing/invalid intake type (Req 1.4);
//        • accepts an optional `urgent` boolean that defaults to false (Req 1.7).
//   2. On a PDF upload, extracts the document's text via pdf-lib and stores that
//      as the Case raw Intake text (Req 1.2).
//   3. Creates the Case with status "New", stores the raw Intake text (Req 1.1),
//      sets `Case.isUrgent` from `urgent`, and computes the SLA_Clock deadline as
//      `slaDeadline(createdAt, urgent)` — 72h urgent / 7d standard (Req 1.8, 1.9,
//      12.1).
//   4. Kicks off `runAgent(caseId)` ASYNCHRONOUSLY (fire-and-forget, never
//      awaited) and returns the caseId to the Operator immediately without
//      waiting for the agent run to complete (Req 1.5).
//
// Runs on the Node.js runtime (declared above) because Prisma, pdf-lib, and the
// Agent_Runner are not edge-compatible.
// =============================================================================

/** The four valid intake types (Req 1.1); mirrors `IntakeType` in lib/types. */
const INTAKE_TYPES = [
  "denial_letter",
  "new_pa_request",
  "phone_note",
  "whatsapp_patient_note",
] as const satisfies readonly IntakeType[];

/** zod schema for the intake type (Req 1.4). */
const intakeTypeSchema = z.enum(INTAKE_TYPES);

/** Successful create response: the new Case identifier (Req 1.5). */
export interface CreateCaseResponse {
  caseId: string;
}

/** Validation / error response with a field-identifying message. */
export interface CreateCaseErrorResponse {
  error: string;
}

/** Normalized intake extracted from the request body (JSON or form-data). */
interface ParsedIntake {
  text: string;
  intakeTypeRaw: unknown;
  urgentRaw: unknown;
  pdfBytes: Uint8Array | null;
  hasFile: boolean;
}

/**
 * Coerce a raw `urgent` value (boolean from JSON, or string "true"/"on"/"1"
 * from form-data) into a boolean. Anything else — including an omitted value —
 * is treated as not urgent, so the flag defaults to false (Req 1.7).
 */
function coerceUrgent(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    return v === "true" || v === "on" || v === "1" || v === "yes";
  }
  return false;
}

/** Parse the request body, supporting both multipart/form-data and JSON. */
async function parseIntake(request: Request): Promise<ParsedIntake> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const textVal = form.get("text");
    const fileVal = form.get("file");

    let pdfBytes: Uint8Array | null = null;
    let hasFile = false;
    if (fileVal && typeof fileVal === "object" && "arrayBuffer" in fileVal) {
      const file = fileVal as File;
      if (file.size > 0) {
        hasFile = true;
        pdfBytes = new Uint8Array(await file.arrayBuffer());
      }
    }

    return {
      text: typeof textVal === "string" ? textVal : "",
      intakeTypeRaw: form.get("intakeType") ?? undefined,
      urgentRaw: form.get("urgent") ?? undefined,
      pdfBytes,
      hasFile,
    };
  }

  // Default: JSON body.
  const body: unknown = await request.json().catch(() => ({}));
  const obj = (body ?? {}) as Record<string, unknown>;
  return {
    text: typeof obj.text === "string" ? obj.text : "",
    intakeTypeRaw: obj.intakeType,
    urgentRaw: obj.urgent,
    pdfBytes: null,
    hasFile: false,
  };
}

/**
 * Extract the text content from an uploaded PDF using pdf-lib (Req 1.2).
 *
 * pdf-lib parses the document into indirect objects; the page content is held
 * in raw (usually Flate-compressed) content streams. We decode every content
 * stream (those containing a `BT` begin-text marker) and pull the operands of
 * the text-showing operators — literal `( … )` and hex `< … >` strings — which
 * together form the visible text. This is a best-effort extraction suitable for
 * the seeded/demo denial letters; it never throws, returning "" when the bytes
 * are not a parseable PDF so the caller can fall back to intake-content rules.
 */
async function extractPdfText(bytes: Uint8Array): Promise<string> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
    });
  } catch {
    return "";
  }

  const parts: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;

    let decoded: Uint8Array;
    try {
      decoded = decodePDFRawStream(obj).decode();
    } catch {
      continue;
    }

    const text = decodeContentStreamText(decoded);
    if (text.trim().length > 0) parts.push(text);
  }

  return parts.join("\n").replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * Pull the visible text out of a decoded PDF content stream. Only streams that
 * carry a `BT` (begin-text) marker are treated as content streams; for those we
 * collect every literal-string `( … )` and hex-string `< … >` operand (the
 * operands of `Tj`/`TJ`/`'`/`"`) in order and decode their escapes.
 */
function decodeContentStreamText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  if (!/\bBT\b/.test(raw)) return "";

  const pieces: string[] = [];
  // Literal string `( … )` (with escaped chars) OR hex string `< … >`.
  const tokenRe = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(raw)) !== null) {
    const token = match[0];
    if (token.startsWith("(")) {
      pieces.push(unescapePdfLiteral(token.slice(1, -1)));
    } else {
      pieces.push(decodePdfHexString(token.slice(1, -1)));
    }
  }
  return pieces.join("");
}

/** Decode PDF literal-string escape sequences (`\n`, `\(`, octal `\ddd`, …). */
function unescapePdfLiteral(input: string): string {
  return input.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (_all, esc: string) => {
    switch (esc) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "(":
        return "(";
      case ")":
        return ")";
      case "\\":
        return "\\";
      default:
        // Octal character code.
        return String.fromCharCode(parseInt(esc, 8));
    }
  });
}

/** Decode a PDF hex string (whitespace-tolerant; odd length pads a trailing 0). */
function decodePdfHexString(input: string): string {
  const hex = input.replace(/\s+/g, "");
  const padded = hex.length % 2 === 0 ? hex : `${hex}0`;
  let out = "";
  for (let i = 0; i < padded.length; i += 2) {
    out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  }
  return out;
}

export async function POST(
  request: Request,
): Promise<NextResponse<CreateCaseResponse | CreateCaseErrorResponse>> {
  const parsed = await parseIntake(request);

  // Resolve the raw Intake text: a PDF upload supplies the text via extraction
  // (Req 1.2), combined with any typed text so neither source is lost.
  let intakeText = parsed.text.trim();
  if (parsed.hasFile && parsed.pdfBytes) {
    const extracted = await extractPdfText(parsed.pdfBytes);
    intakeText = [intakeText, extracted.trim()].filter(Boolean).join("\n\n").trim();
  }

  // Req 1.3 — reject empty/whitespace text with no uploaded file, identifying
  // the missing intake content.
  if (intakeText.length === 0 && !parsed.hasFile) {
    return NextResponse.json(
      {
        error:
          "Missing intake content: provide intake text or upload a PDF file.",
      },
      { status: 400 },
    );
  }

  // Req 1.4 — reject a missing/invalid intake type, identifying the missing type.
  const intakeTypeResult = intakeTypeSchema.safeParse(parsed.intakeTypeRaw);
  if (!intakeTypeResult.success) {
    return NextResponse.json(
      {
        error: `Missing or invalid intake type. Expected one of: ${INTAKE_TYPES.join(", ")}.`,
      },
      { status: 400 },
    );
  }
  const intakeType = intakeTypeResult.data;

  // Req 1.7 — urgent flag defaults to false when omitted.
  const urgent = coerceUrgent(parsed.urgentRaw);

  // Req 1.1 / 1.8 / 1.9 / 12.1 — create the Case (status "New"), store the raw
  // Intake text, set isUrgent, and compute the SLA deadline from createdAt.
  const createdAt = new Date();
  const created = await prisma.case.create({
    data: {
      intakeType,
      rawIntakeText: intakeText,
      status: "New" satisfies CaseStatus,
      isUrgent: urgent,
      createdAt,
      slaDeadline: slaDeadline(createdAt, urgent),
    },
    select: { id: true },
  });

  // Req 1.5 — kick off the agent asynchronously; do NOT await it, so the caseId
  // is returned immediately without waiting for the agent run to complete.
  void runAgent(created.id).catch((err: unknown) => {
    console.error(
      `[POST /api/cases] runAgent failed for Case "${created.id}":`,
      err,
    );
  });

  return NextResponse.json({ caseId: created.id }, { status: 201 });
}
