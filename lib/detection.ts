// =============================================================================
// lib/detection.ts
//
// Contradiction, gap, and stale-note detection (Requirements 4.1, 4.2, 4.3).
//
// These are the pure, deterministic detection helpers the Agent_Runner uses to
// flag what is missing or conflicting before it decides a Resolution_Path. Each
// function takes plain inputs and returns plain structured result objects — it
// performs NO I/O, issues NO Qwen call, imports NO Prisma client, and writes NO
// Trace_Step. The caller (the pipeline in `lib/agentRunner.ts`) is responsible
// for turning each result into a `Trace_Step` and/or a `Finding`.
//
// Keeping detection pure makes it trivially testable (property + unit tests) and
// deterministic: the same inputs always produce the same findings. Anything that
// varies at runtime — the reference "now"/case-creation instant and the staleness
// threshold — is injected as an explicit argument rather than read from a clock.
//
//   detectContradictions() → where an extracted value conflicts with an
//                            investigated source, carrying BOTH sources (Req 4.1)
//   detectEvidenceGaps()   → policy-required evidence absent from the available
//                            sources (Req 4.2)
//   detectStaleNotes()     → Chart_Notes dated MORE THAN 90 days before case
//                            creation, including the note date (Req 4.3)
// =============================================================================

import type { FindingSeverity, SourceType } from "./types";

// ─── Shared source reference ─────────────────────────────────────────────────

/**
 * A reference to one side of a comparison: which kind of source the value came
 * from, plus a human-readable label used in the recorded Trace_Step/Finding.
 */
export interface SourceRef {
  /** Provenance of the value (raw_intake, chart_note, payer_policy, …). */
  sourceType: SourceType;
  /** Human-readable label, e.g. "raw_intake" or "Chart_Note 2024-01-05". */
  label: string;
}

// ─── Contradiction detection (Requirement 4.1) ───────────────────────────────

/**
 * An extracted value the Agent_Runner derived, tagged with where it came from.
 */
export interface ExtractedValue {
  /** Logical field name, e.g. "diagnosisCode", "payer", "procedureCode". */
  fieldName: string;
  /** The extracted value ("unknown" or empty means undetermined). */
  value: string;
  /** Where the value was extracted from. */
  source: SourceRef;
}

/**
 * A fact observed in an investigated source (chart note, payer policy, code
 * lookup) that an extracted value can be checked against.
 */
export interface InvestigatedFact {
  /** Logical field name; compared against `ExtractedValue.fieldName`. */
  fieldName: string;
  /** The value the investigated source asserts for that field. */
  value: string;
  /** Where the fact was observed. */
  source: SourceRef;
}

/**
 * A detected conflict between an extracted value and an investigated source.
 * It carries BOTH conflicting sources (Requirement 4.1) so the caller can record
 * a Trace_Step that references each side of the contradiction.
 */
export interface ContradictionResult {
  /** Stable finding id: "contradiction:<fieldName>". */
  findingId: string;
  fieldName: string;
  /** The value the extraction produced. */
  extractedValue: string;
  /** The conflicting value the investigated source asserts. */
  sourceValue: string;
  /** The source of the extracted value. */
  extractedSource: SourceRef;
  /** The investigated source that conflicts with it. */
  investigatedSource: SourceRef;
  /** Contradictions are always blocking (Req 29.2). */
  severity: FindingSeverity;
  /** Precise phrasing for the audit/technical view. */
  technicalMessage: string;
  /** Operator-friendly phrasing. */
  friendlyMessage: string;
}

/**
 * Detect where an `ExtractedValue` conflicts with an `InvestigatedFact` for the
 * same field (Requirement 4.1).
 *
 * Two values conflict when they refer to the same `fieldName`, both are
 * determined (non-empty and not "unknown"), and their normalized forms differ.
 * Comparison is trimmed and case-insensitive so "ICD J45.909" and "icd j45.909"
 * are treated as equal. Each detected conflict yields one `ContradictionResult`
 * carrying both the extracted source and the investigated source.
 *
 * Pure and deterministic: results are returned in a stable order (by field name,
 * then by investigated source label).
 */
export function detectContradictions(
  extractedValues: ExtractedValue[],
  investigatedFacts: InvestigatedFact[],
): ContradictionResult[] {
  const results: ContradictionResult[] = [];

  for (const extracted of extractedValues) {
    if (!isDetermined(extracted.value)) {
      continue;
    }

    for (const fact of investigatedFacts) {
      if (fact.fieldName !== extracted.fieldName) {
        continue;
      }
      if (!isDetermined(fact.value)) {
        continue;
      }
      if (normalize(extracted.value) === normalize(fact.value)) {
        continue;
      }

      results.push({
        findingId: `contradiction:${extracted.fieldName}`,
        fieldName: extracted.fieldName,
        extractedValue: extracted.value,
        sourceValue: fact.value,
        extractedSource: extracted.source,
        investigatedSource: fact.source,
        severity: "blocking",
        technicalMessage:
          `Contradiction on "${extracted.fieldName}": extracted value ` +
          `"${extracted.value}" (from ${describeSource(extracted.source)}) ` +
          `conflicts with "${fact.value}" (from ${describeSource(fact.source)}).`,
        friendlyMessage:
          `The ${humanizeField(extracted.fieldName)} we read ` +
          `("${extracted.value}") does not match what the ` +
          `${humanizeSourceType(fact.source.sourceType)} says ` +
          `("${fact.value}").`,
      });
    }
  }

  return results.sort(
    (a, b) =>
      a.fieldName.localeCompare(b.fieldName) ||
      a.investigatedSource.label.localeCompare(b.investigatedSource.label),
  );
}

// ─── Evidence-gap detection (Requirement 4.2) ────────────────────────────────

/**
 * A single piece of evidence a Payer_Policy requires. Presence is determined by
 * whether any available source text contains one of `matchTerms` (a deterministic,
 * non-LLM check), so the caller supplies the terms that would satisfy it.
 */
export interface PolicyEvidenceRequirement {
  /** Stable id for the requirement, e.g. "prior-conservative-therapy". */
  id: string;
  /** Human-readable description of the required evidence. */
  description: string;
  /**
   * Terms that, if found (case-insensitively) in any available source text,
   * indicate the requirement is satisfied. When empty, the requirement can
   * never be satisfied by text matching and is always reported as a gap.
   */
  matchTerms: string[];
}

/**
 * A piece of evidence available to the case from an investigated source, whose
 * text is scanned to satisfy policy requirements.
 */
export interface AvailableEvidence {
  source: SourceRef;
  /** The evidence text (chart-note content, code lookup name, etc.). */
  text: string;
}

/**
 * A Payer_Policy evidence requirement that is absent from the available sources.
 */
export interface EvidenceGapResult {
  /** Stable finding id: "gap:<requirementId>". */
  findingId: string;
  requirementId: string;
  /** Description of the missing evidence. */
  description: string;
  technicalMessage: string;
  friendlyMessage: string;
}

/**
 * Detect Payer_Policy-required evidence that is absent from the available
 * sources (Requirement 4.2).
 *
 * For each requirement, the available evidence texts are scanned (trimmed,
 * case-insensitive substring match) for any of the requirement's `matchTerms`.
 * A requirement with no matching term in any available source is reported as a
 * gap. Pure and deterministic; results preserve the requirement input order.
 */
export function detectEvidenceGaps(
  requirements: PolicyEvidenceRequirement[],
  availableEvidence: AvailableEvidence[],
): EvidenceGapResult[] {
  const haystacks = availableEvidence.map((e) => normalize(e.text));

  const gaps: EvidenceGapResult[] = [];

  for (const requirement of requirements) {
    const satisfied = requirement.matchTerms.some((term) => {
      const needle = normalize(term);
      return needle.length > 0 && haystacks.some((hay) => hay.includes(needle));
    });

    if (satisfied) {
      continue;
    }

    gaps.push({
      findingId: `gap:${requirement.id}`,
      requirementId: requirement.id,
      description: requirement.description,
      technicalMessage:
        `Evidence gap: the payer policy requires "${requirement.description}" ` +
        `(${requirement.id}), but no available source provides it.`,
      friendlyMessage:
        `The insurer's policy asks for ${requirement.description}, ` +
        `which we could not find in the available records.`,
    });
  }

  return gaps;
}

// ─── Stale chart-note detection (Requirement 4.3) ────────────────────────────

/** Days after which a supporting Chart_Note is considered potentially stale. */
export const STALE_NOTE_THRESHOLD_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The minimal Chart_Note shape needed to evaluate staleness. Accepting a plain
 * shape (rather than the Prisma `ChartNote`) keeps this module free of any data
 * layer dependency.
 */
export interface ChartNoteForStaleness {
  id: string;
  /** The date the note was authored. */
  noteDate: Date;
  diagnosisCode?: string;
}

/**
 * A Chart_Note flagged as potentially stale, including the note date so the
 * caller can record it in the Trace_Step (Requirement 4.3).
 */
export interface StaleNoteResult {
  /** Stable finding id: "stale-note:<noteId>". */
  findingId: string;
  noteId: string;
  /** The note date, included in the flag (Requirement 4.3). */
  noteDate: Date;
  /** Whole days the note predates case creation (floored). */
  ageDays: number;
  technicalMessage: string;
  friendlyMessage: string;
}

/**
 * Flag any Chart_Note dated MORE THAN 90 days before the Case creation date
 * (Requirement 4.3).
 *
 * The boundary is strict (`> 90 days`): a note dated exactly 90 days before
 * creation is NOT stale; a note dated 90 days + 1ms before creation IS. The
 * comparison uses the raw millisecond difference between `caseCreatedAt` and the
 * note date, so it is unaffected by time-of-day or DST. Notes dated on or after
 * `caseCreatedAt` are never stale.
 *
 * The threshold is injectable via `thresholdDays` (defaulting to 90) so it can
 * be exercised at and around the boundary in tests. Pure and deterministic;
 * results preserve the input note order.
 */
export function detectStaleNotes(
  chartNotes: ChartNoteForStaleness[],
  caseCreatedAt: Date,
  thresholdDays: number = STALE_NOTE_THRESHOLD_DAYS,
): StaleNoteResult[] {
  const thresholdMs = thresholdDays * MS_PER_DAY;
  const results: StaleNoteResult[] = [];

  for (const note of chartNotes) {
    const diffMs = caseCreatedAt.getTime() - note.noteDate.getTime();

    // Strict boundary: only flag when the note is MORE THAN thresholdDays old.
    if (diffMs <= thresholdMs) {
      continue;
    }

    const ageDays = Math.floor(diffMs / MS_PER_DAY);
    const noteDateIso = note.noteDate.toISOString();

    results.push({
      findingId: `stale-note:${note.id}`,
      noteId: note.id,
      noteDate: note.noteDate,
      ageDays,
      technicalMessage:
        `Potentially stale Chart_Note ${note.id} dated ${noteDateIso} ` +
        `(${ageDays} days before case creation, threshold ${thresholdDays} days).`,
      friendlyMessage:
        `A supporting chart note from ${formatDate(note.noteDate)} is more ` +
        `than ${thresholdDays} days old and may be out of date.`,
    });
  }

  return results;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Trimmed, lower-cased form used for all textual comparisons. */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** A value is "determined" when it is non-empty and not the sentinel "unknown". */
function isDetermined(value: string): boolean {
  const n = normalize(value);
  return n.length > 0 && n !== "unknown";
}

function describeSource(source: SourceRef): string {
  return `${source.label} [${source.sourceType}]`;
}

function humanizeField(fieldName: string): string {
  // Split camelCase / snake_case into spaced words for friendly messaging.
  return fieldName
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
}

function humanizeSourceType(sourceType: SourceType): string {
  switch (sourceType) {
    case "raw_intake":
      return "intake";
    case "chart_note":
      return "chart note";
    case "payer_policy":
      return "payer policy";
    case "code_lookup":
      return "code lookup";
    case "human_provided":
      return "information you provided";
    default:
      return sourceType;
  }
}

function formatDate(date: Date): string {
  // Stable, locale-independent YYYY-MM-DD for user-facing messages.
  return date.toISOString().slice(0, 10);
}
