// =============================================================================
// lib/whatsapp/mediaGate.ts
//
// WhatsApp media intake quality/type gate (Requirement 41).
//
// Every inbound WhatsApp image or PDF is run through THIS gate BEFORE any
// extracted text is used for intake, so an unreadable or wrong-type file yields
// clear, reason-specific resend guidance instead of a wrongly-processed Case
// (Requirements 41.1–41.6).
//
// The gate produces a `Media_Quality_Result` per file:
//   - usable === true  → carries the `extractedText` for the intake path (Req 41.4)
//   - usable === false → carries a specific `reason` ∈ blurry | too_dark | cropped |
//                        not_a_document | wrong_document_type (Req 41.2) so the
//                        router can send a reason-specific corrective reply (Req 41.3)
//
// The actual quality assessment + OCR/PDF text extraction is I/O- and
// library-bound (a vision/OCR service), so it is injected as a **port**
// (`MediaClassifier`). This keeps the gate deterministically testable with an
// in-memory classifier and no network. A deterministic default classifier is
// provided so callers that do not wire a real vision/OCR backend still get a
// safe, predictable result.
//
// FAIL-SAFE CONTRACT: `classifyMedia` NEVER throws. Any error thrown by the
// injected classifier (or the default) during the check/extraction is caught and
// converted to a not-usable result, and no extraction results from a failed check
// are ever used (Requirement 41.5).
// =============================================================================

// ─── Result + input shapes (mirror the design + Media_Quality_Result glossary) ─

/** The five allowed not-usable reasons (Requirement 41.2). */
export type MediaQualityReason =
  | "blurry"
  | "too_dark"
  | "cropped"
  | "not_a_document"
  | "wrong_document_type";

/**
 * The outcome of the pre-extraction quality/type check for one inbound file.
 *
 * Invariants enforced by {@link classifyMedia}:
 *   - `usable === true`  ⇒ `reason` is absent and `extractedText` is a string.
 *   - `usable === false` ⇒ `extractedText` is absent; `reason` is present when the
 *     classifier determined one (it is only ever absent on a fail-safe error path,
 *     Requirement 41.5).
 */
export interface MediaQualityResult {
  usable: boolean;
  /** Present iff not usable and a specific reason was determined (Req 41.2). */
  reason?: MediaQualityReason;
  /** Present iff usable — the text routed to the intake path (Req 41.4). */
  extractedText?: string;
}

/** An inbound WhatsApp media attachment handed to the gate. */
export interface InboundMedia {
  /** Provider media handle (e.g. Meta media id) used to fetch the bytes. */
  ref: string;
  /** Declared MIME type, e.g. "image/jpeg" or "application/pdf". */
  mimeType: string;
  /** Coarse kind as parsed from the inbound message. */
  kind: "image" | "pdf";
}

/**
 * The injectable vision/OCR port. Given one inbound file it returns a raw
 * assessment. It MAY throw or reject — {@link classifyMedia} treats any failure
 * as not usable (Requirement 41.5), so implementations need not be defensive.
 */
export type MediaClassifier = (
  file: InboundMedia,
) => Promise<MediaQualityResult> | MediaQualityResult;

// ─── Accepted document MIME types ────────────────────────────────────────────

/**
 * MIME types we accept as a document photo or PDF. Anything else is treated as
 * `not_a_document` by the default classifier (Requirement 41.2).
 */
const DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

/** Normalize a MIME type: lower-case and strip any `; charset=…` parameters. */
function normalizeMime(mimeType: string): string {
  return (mimeType ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

// ─── Deterministic default classifier (no network) ───────────────────────────

/**
 * A deterministic, dependency-free default classifier used when no real
 * vision/OCR port is wired. It performs a TYPE check only — it cannot judge blur
 * or lighting without a real vision backend — and returns:
 *
 *   - `not_a_document` for any file whose MIME type is not a recognized document
 *     image or PDF (Requirement 41.2), and
 *   - a usable result carrying a deterministic placeholder `extractedText` for a
 *     recognized document type, so the intake path is exercised end-to-end in
 *     tests without a network call (Requirement 41.4).
 *
 * Real deployments inject a `MediaClassifier` backed by a vision/OCR service that
 * additionally detects blurry / too_dark / cropped and returns real extracted text.
 */
export function defaultMediaClassifier(file: InboundMedia): MediaQualityResult {
  const mime = normalizeMime(file.mimeType);

  if (!DOCUMENT_MIME_TYPES.has(mime)) {
    return { usable: false, reason: "not_a_document" };
  }

  // Recognized document type: deterministic placeholder text keyed off the media
  // handle so the same file always yields the same intake text.
  return { usable: true, extractedText: `[document ${file.ref}]` };
}

// ─── Result normalization (enforce the invariants) ───────────────────────────

/**
 * Coerce a raw classifier assessment into a well-formed {@link MediaQualityResult},
 * enforcing the usable/reason/extractedText invariants so downstream routing can
 * trust the shape regardless of how the injected classifier behaves.
 */
function normalizeResult(raw: MediaQualityResult): MediaQualityResult {
  if (raw && raw.usable === true) {
    // Usable ⇒ carry text only. Missing text degrades to an empty string so the
    // intake path always receives a string (Requirement 41.4).
    return { usable: true, extractedText: raw.extractedText ?? "" };
  }
  // Not usable ⇒ carry the reason only (when one was determined). extractedText
  // from a not-usable assessment is discarded so it can never reach intake.
  return raw && raw.reason
    ? { usable: false, reason: raw.reason }
    : { usable: false };
}

// ─── The gate ─────────────────────────────────────────────────────────────────

/**
 * Run the quality/type check over every inbound file and return one
 * {@link MediaQualityResult} per file, in order (Requirement 41.1).
 *
 * NEVER throws: each file is classified independently and any error thrown by the
 * classifier is caught and converted to a not-usable result, so a single bad file
 * cannot break the delivery and extraction results from a failed check are never
 * used (Requirement 41.5).
 *
 * @param files       inbound media attachments from a single WhatsApp delivery
 * @param classifier  vision/OCR port; defaults to {@link defaultMediaClassifier}
 */
export async function classifyMedia(
  files: InboundMedia[],
  classifier: MediaClassifier = defaultMediaClassifier,
): Promise<MediaQualityResult[]> {
  if (!Array.isArray(files) || files.length === 0) return [];

  const results: MediaQualityResult[] = [];
  for (const file of files) {
    try {
      const raw = await classifier(file);
      results.push(normalizeResult(raw));
    } catch {
      // Fail-safe: any thrown error ⇒ not usable, no extraction results used.
      results.push({ usable: false });
    }
  }
  return results;
}

// ─── Reason-specific corrective guidance (Requirement 41.3) ───────────────────

/**
 * Generic, PHI-free corrective guidance for each not-usable reason. Used by the
 * router to reply with guidance SPECIFIC to the `Media_Quality_Result.reason`
 * (Requirement 41.3). Kept here so the guidance and the reasons stay in lockstep.
 */
export const MEDIA_CORRECTIVE_MESSAGES: Record<MediaQualityReason, string> = {
  blurry:
    "The photo came through too blurry to read. Please resend a sharper, in-focus photo of the full page.",
  too_dark:
    "The photo is too dark to read. Please retake it in good lighting and resend the full page.",
  cropped:
    "Part of the page is cut off. Please make sure the whole page is in frame and resend it.",
  not_a_document:
    "That doesn't look like a document we can read. Please send your denial letter as a clear photo or PDF.",
  wrong_document_type:
    "That doesn't look like the right document. Please send your insurance denial letter as a clear photo or PDF.",
};

/**
 * Fallback corrective guidance when a file is not usable but no specific reason
 * was determined (e.g. the fail-safe error path, Requirement 41.5).
 */
export const MEDIA_CORRECTIVE_FALLBACK =
  "We couldn't read that file. Please resend your denial letter as a clear photo or PDF.";

/** Resolve the corrective reply for a not-usable result (Requirement 41.3). */
export function correctiveMessageFor(reason?: MediaQualityReason): string {
  return reason ? MEDIA_CORRECTIVE_MESSAGES[reason] : MEDIA_CORRECTIVE_FALLBACK;
}

// ─── Multi-file selection (Requirement 41.6) ──────────────────────────────────

/**
 * From the per-file results of a single delivery, select the usable document(s)
 * to drive intake and disregard clearly-unrelated / unusable files
 * (Requirement 41.6). Order is preserved.
 */
export function selectUsable(
  results: readonly MediaQualityResult[],
): MediaQualityResult[] {
  return results.filter((r) => r.usable === true);
}

/**
 * The combined intake text from all usable files in a delivery, in order, joined
 * by a blank line. Empty when nothing was usable — the caller then replies with
 * corrective guidance and creates no Case (Requirements 41.3, 41.4, 41.6).
 */
export function extractedTextForIntake(
  results: readonly MediaQualityResult[],
): string {
  return selectUsable(results)
    .map((r) => r.extractedText ?? "")
    .filter((t) => t.length > 0)
    .join("\n\n");
}

/**
 * When no file in a delivery is usable, the reason to use for the corrective
 * reply — the first determined reason, if any (Requirement 41.3). Returns
 * `undefined` when nothing usable and no reason was determined (fail-safe path),
 * in which case {@link correctiveMessageFor} yields the generic fallback.
 */
export function firstUnusableReason(
  results: readonly MediaQualityResult[],
): MediaQualityReason | undefined {
  for (const r of results) {
    if (r.usable === false && r.reason) return r.reason;
  }
  return undefined;
}
