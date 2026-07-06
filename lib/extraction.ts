// =============================================================================
// lib/extraction.ts
//
// Extracted_Field construction for the Intake_And_Extraction stage.
//
// This module is intentionally PURE and DETERMINISTIC: no I/O, no database
// access, and no calls to the LLM. The Qwen-powered extraction call proposes
// raw entity values, confidences, and reasoning; this module turns those raw
// proposals into well-formed `Extracted_Field` records the Agent_Runner then
// persists via Prisma.
//
// It builds the five entity fields AuthPilot resolves from an Intake
// (Requirement 2.1):
//   - patient
//   - payer
//   - procedure code
//   - diagnosis code
//   - denial reason
//
// Each record carries the field name, extracted value, Confidence_Score,
// source type, reasoning, timestamp, and an originating step reference
// (Requirements 2.2, 9.1). When an entity value cannot be determined from the
// available sources, the record is recorded with value "unknown" and a
// Confidence_Score of 0 (Requirement 2.3). The source type is constrained to
// the allowed provenance set (Requirement 2.4).
//
// Determinism: the current time is supplied through an injectable `Clock` so
// callers (and tests) get identical output for identical inputs. The
// Agent_Runner passes the real clock; tests pass a fixed one.
// =============================================================================

import type { PipelineStage, SourceType } from "@/lib/types";

// ─── Field names ─────────────────────────────────────────────────────────────

/**
 * The five entities the Intake_And_Extraction stage resolves as
 * Extracted_Field records (Requirement 2.1).
 */
export type EntityFieldName =
  | "patient"
  | "payer"
  | "procedureCode"
  | "diagnosisCode"
  | "denialReason";

/** The five entity field names as a runtime tuple, for iteration/generators. */
export const ENTITY_FIELD_NAMES: readonly EntityFieldName[] = [
  "patient",
  "payer",
  "procedureCode",
  "diagnosisCode",
  "denialReason",
] as const;

// ─── Undeterminable sentinel (Requirement 2.3) ───────────────────────────────

/** Value stored when an entity cannot be determined from available sources. */
export const UNKNOWN_VALUE = "unknown";
/** Confidence_Score stored alongside an undeterminable value. */
export const UNKNOWN_CONFIDENCE = 0;

// ─── Confidence bounds (Requirement 2.2) ─────────────────────────────────────

const CONFIDENCE_MIN = 0;
const CONFIDENCE_MAX = 100;

// ─── Originating step reference (Requirement 9.1) ────────────────────────────

/**
 * A reference to the tool or agent step that produced an Extracted_Field
 * (Requirement 9.1 — "originating tool or agent step"). The `stage` is always
 * present; `tool` is set when the value came from a specific Agent_Tool
 * observation (e.g. a diagnosis-code lookup), and omitted when the value came
 * from the stage's own reasoning over the raw Intake.
 */
export interface OriginatingStep {
  /** The Pipeline_Stage that produced the field (typically Intake_And_Extraction). */
  stage: PipelineStage;
  /** The Agent_Tool name, when the value originated from a tool observation. */
  tool?: string;
}

// ─── Extracted_Field record ──────────────────────────────────────────────────

/**
 * A structured Extracted_Field as produced by the extraction stage, before
 * persistence. Mirrors the `ExtractedField` Prisma model fields (fieldName,
 * value, confidence, sourceType, reasoning, timestamp) and additionally carries
 * the `originatingStep` reference required by the audit trail (Requirement 9.1).
 */
export interface ExtractedFieldRecord {
  /** Which entity this record describes. */
  fieldName: EntityFieldName;
  /** The extracted value, or `UNKNOWN_VALUE` when undeterminable (Req 2.3). */
  value: string;
  /** Confidence_Score in [0, 100]; 0 when undeterminable (Req 2.2, 2.3). */
  confidence: number;
  /** Provenance of the value — one of the allowed source types (Req 2.4). */
  sourceType: SourceType;
  /** Human-readable basis for the extraction (Req 2.2). */
  reasoning: string;
  /** When the record was constructed, from the injected clock (Req 2.2). */
  timestamp: Date;
  /** The originating tool or agent step (Req 9.1). */
  originatingStep: OriginatingStep;
}

/**
 * A single raw entity proposal fed to the builder. `value` is whatever the
 * extraction call proposed for the entity; a null/undefined/blank value — or an
 * explicit "unknown" — is treated as undeterminable (Req 2.3).
 */
export interface EntityProposal {
  fieldName: EntityFieldName;
  /** Raw proposed value; undeterminable when null/undefined/blank/"unknown". */
  value?: string | null;
  /** Proposed Confidence_Score; clamped to [0, 100]. Ignored when undeterminable. */
  confidence?: number;
  /** Provenance of the value (Req 2.4). */
  sourceType: SourceType;
  /** Basis for the extraction (Req 2.2). */
  reasoning: string;
  /** Originating tool or agent step (Req 9.1). */
  originatingStep: OriginatingStep;
}

// ─── Clock ────────────────────────────────────────────────────────────────────

/** Injectable time source so construction is deterministic and testable. */
export type Clock = () => Date;

/** Default clock used when a caller does not inject one. */
const defaultClock: Clock = () => new Date();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Clamp a value into the inclusive [0, 100] Confidence_Score range. */
function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return CONFIDENCE_MIN;
  if (value < CONFIDENCE_MIN) return CONFIDENCE_MIN;
  if (value > CONFIDENCE_MAX) return CONFIDENCE_MAX;
  return value;
}

/**
 * Determine whether a proposed value is undeterminable (Req 2.3). A value is
 * undeterminable when it is null/undefined, blank (empty or whitespace-only),
 * or the literal sentinel "unknown" (case-insensitive).
 */
function isUndeterminable(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  return trimmed.toLowerCase() === UNKNOWN_VALUE;
}

/** Freeze the originating step so a returned record cannot be mutated in place. */
function normalizeStep(step: OriginatingStep): OriginatingStep {
  const normalized: OriginatingStep =
    step.tool === undefined ? { stage: step.stage } : { stage: step.stage, tool: step.tool };
  return Object.freeze(normalized);
}

// ─── Builders ──────────────────────────────────────────────────────────────────

/**
 * Construct a single Extracted_Field record from a raw entity proposal.
 *
 * PURE and deterministic: given the same proposal and clock, it always returns
 * an equal record.
 *
 * - When the proposed value is undeterminable, the record is normalized to
 *   value `"unknown"` and confidence `0`, regardless of any proposed confidence
 *   (Requirement 2.3).
 * - Otherwise the trimmed value is kept and the proposed confidence is clamped
 *   into the valid [0, 100] range (Requirement 2.2).
 *
 * @param proposal the raw entity proposal
 * @param clock injectable time source (defaults to the real clock)
 */
export function buildExtractedField(
  proposal: EntityProposal,
  clock: Clock = defaultClock,
): ExtractedFieldRecord {
  const timestamp = clock();
  const originatingStep = normalizeStep(proposal.originatingStep);

  if (isUndeterminable(proposal.value)) {
    // Req 2.3 — undeterminable entities are recorded as "unknown" / 0.
    return {
      fieldName: proposal.fieldName,
      value: UNKNOWN_VALUE,
      confidence: UNKNOWN_CONFIDENCE,
      sourceType: proposal.sourceType,
      reasoning: proposal.reasoning,
      timestamp,
      originatingStep,
    };
  }

  return {
    fieldName: proposal.fieldName,
    value: (proposal.value as string).trim(),
    confidence: clampConfidence(proposal.confidence ?? CONFIDENCE_MIN),
    sourceType: proposal.sourceType,
    reasoning: proposal.reasoning,
    timestamp,
    originatingStep,
  };
}

/**
 * Construct Extracted_Field records for a set of entity proposals, sharing a
 * single timestamp so every field produced in one extraction pass carries the
 * same construction time (the clock is read exactly once).
 *
 * @param proposals the raw entity proposals
 * @param clock injectable time source (defaults to the real clock)
 */
export function buildExtractedFields(
  proposals: ReadonlyArray<EntityProposal>,
  clock: Clock = defaultClock,
): ExtractedFieldRecord[] {
  // Read the clock once so all fields in a pass share the same timestamp.
  const frozenNow = clock();
  const fixedClock: Clock = () => frozenNow;
  return proposals.map((proposal) => buildExtractedField(proposal, fixedClock));
}

/**
 * The complete set of five entity proposals for one Intake, keyed by entity.
 * Any missing key is treated as an undeterminable field and produces an
 * "unknown" / 0 record, guaranteeing all five fields (Requirement 2.1) are
 * always present in the output.
 */
export type EntityProposalSet = Partial<
  Record<EntityFieldName, Omit<EntityProposal, "fieldName">>
>;

/**
 * The default originating step for entity extraction: the Intake_And_Extraction
 * stage's own reasoning, with no specific tool. Used to fill in undeterminable
 * fields that were never proposed.
 */
const DEFAULT_EXTRACTION_STEP: OriginatingStep = { stage: "Intake_And_Extraction" };

/**
 * Construct all five entity Extracted_Field records for one Intake
 * (Requirement 2.1), guaranteeing exactly one record per entity in the fixed
 * order of `ENTITY_FIELD_NAMES`.
 *
 * Entities absent from `proposals` — or present but undeterminable — are
 * recorded as value "unknown" with confidence 0 (Requirement 2.3), using the
 * Intake_And_Extraction stage as their originating step.
 *
 * @param proposals per-entity proposals (any subset of the five)
 * @param clock injectable time source (defaults to the real clock)
 */
export function buildEntityExtractionFields(
  proposals: EntityProposalSet,
  clock: Clock = defaultClock,
): ExtractedFieldRecord[] {
  const frozenNow = clock();
  const fixedClock: Clock = () => frozenNow;

  return ENTITY_FIELD_NAMES.map((fieldName) => {
    const proposal = proposals[fieldName];
    if (proposal === undefined) {
      // Entity was never proposed ⇒ undeterminable (Req 2.3).
      return buildExtractedField(
        {
          fieldName,
          value: null,
          sourceType: "raw_intake",
          reasoning: `No ${fieldName} could be determined from the available sources.`,
          originatingStep: DEFAULT_EXTRACTION_STEP,
        },
        fixedClock,
      );
    }
    return buildExtractedField({ fieldName, ...proposal }, fixedClock);
  });
}
