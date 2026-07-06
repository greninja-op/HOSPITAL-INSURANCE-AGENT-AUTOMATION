// =============================================================================
// lib/audit.ts
//
// Audit_Trail merge helper (Requirement 9.3).
//
// `mergeAuditTrail` combines the two audit record kinds recorded for a Case —
// Extracted_Field records and Trace_Step records — into a single list ordered
// chronologically (non-decreasing by timestamp). The merge is:
//
//   - Chronological: entries are sorted non-decreasing by their `timestamp`.
//   - Stable/deterministic: `Array.prototype.sort` is a stable sort (guaranteed
//     since ES2019), so records sharing an identical timestamp retain their
//     relative insertion order (extracted fields first, then trace steps),
//     giving a single deterministic ordering for identical input.
//   - Lossless: every input record appears in the output exactly once, tagged
//     with its `kind` so callers can render each record according to its type.
//
// This module is pure — no I/O, no database, no LLM — so it is directly
// unit- and property-testable (Property 27). The route handler
// `app/api/cases/[id]/audit/export/route.ts` loads the Case's fields + steps
// via Prisma and feeds them here before rendering the export PDF.
// =============================================================================

// ─── Input record shapes ─────────────────────────────────────────────────────
//
// Structural (minimal) shapes describing only the fields the merge and the audit
// renderer read. The Prisma `ExtractedField` and `TraceStep` row types are
// structurally assignable to these, so callers can pass Prisma records directly
// while tests can construct plain objects.

/** The Extracted_Field content needed to merge and render an audit entry. */
export interface ExtractedFieldRecord {
  fieldName: string;
  value: string;
  confidence: number;
  sourceType: string;
  reasoning: string;
  timestamp: Date;
}

/** The Trace_Step content needed to merge and render an audit entry. */
export interface TraceStepRecord {
  stepType: string;
  toolName?: string | null;
  input?: unknown;
  output?: unknown;
  reasoning: string;
  timestamp: Date;
}

// ─── Merged output ───────────────────────────────────────────────────────────

/** Discriminant tagging which record kind a merged entry carries. */
export type AuditRecordKind = "extracted_field" | "trace_step";

/**
 * A single entry in the merged Audit_Trail, tagged with its `kind` and carrying
 * the original record unchanged. `timestamp` is lifted to the top level so the
 * ordering key is uniform across both kinds.
 */
export type MergedAuditEntry =
  | { kind: "extracted_field"; timestamp: Date; field: ExtractedFieldRecord }
  | { kind: "trace_step"; timestamp: Date; step: TraceStepRecord };

/**
 * Merge Extracted_Field and Trace_Step records into one chronologically-ordered,
 * lossless Audit_Trail (Requirement 9.3).
 *
 * @param extractedFields The Case's Extracted_Field records.
 * @param traceSteps      The Case's Trace_Step records.
 * @returns A new array containing every input record exactly once, tagged with
 *          its kind and sorted non-decreasing by timestamp (stable on ties).
 */
export function mergeAuditTrail(
  extractedFields: readonly ExtractedFieldRecord[],
  traceSteps: readonly TraceStepRecord[],
): MergedAuditEntry[] {
  const entries: MergedAuditEntry[] = [
    ...extractedFields.map(
      (field): MergedAuditEntry => ({
        kind: "extracted_field",
        timestamp: field.timestamp,
        field,
      }),
    ),
    ...traceSteps.map(
      (step): MergedAuditEntry => ({
        kind: "trace_step",
        timestamp: step.timestamp,
        step,
      }),
    ),
  ];

  // Stable sort keeps equal-timestamp entries in insertion order (fields before
  // steps), so identical input always yields identical output (deterministic).
  return entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}
