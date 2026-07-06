// =============================================================================
// lib/agentTools.ts
//
// Agent_Tools — the callable functions the Agent_Runner invokes during the
// nine-stage pipeline. Each tool is a plain async TypeScript function backed by
// a Prisma query (or, for the diagnosis-code lookup, an external API). Qwen sees
// each tool through a JSON schema exposed via the chat-completions `tools`
// parameter; dispatch/tracing is centralized elsewhere (see `dispatchTool`).
//
// This module is intentionally structured so the remaining tools can be added
// without touching the Prisma-backed tools below:
//   • lookupDiagnosisCode  (NIH lookup, graceful degradation) — Task 7.5
//   • dispatchTool         (centralized dispatch + tracing)   — Task 7.7
//
// All queries go through the shared `prisma` client from `lib/db.ts`, so the
// datastore stays provider-agnostic: nothing here depends on a specific
// database engine — switching the Prisma datasource requires no change here.
// =============================================================================

import type {
  ChartNote,
  Patient,
  PayerPolicy,
} from "@prisma/client";

import { getConfig } from "./config";
import { prisma } from "./db";
import type { CaseStatus, ResolutionPath } from "./types";

// ─── Tool result shapes ──────────────────────────────────────────────────────

/**
 * The patient record plus the associated Chart_Notes, returned by
 * `fetchPatientRecord` (Requirement 3.1).
 */
export interface PatientRecord {
  patient: Patient;
  chartNotes: ChartNote[];
}

/**
 * A compact, prior-auth-history view of a past Case, returned by
 * `checkPriorAuthHistory` (Requirement 3.4). It carries only Case-level fields
 * (no chart notes / policy text) so it can summarize a patient's history.
 */
export interface CaseSummary {
  id: string;
  status: CaseStatus;
  intakeType: string;
  payerId: string | null;
  payerName: string | null;
  denialReason: string | null;
  resolutionPath: ResolutionPath | null;
  overallConfidence: number | null;
  isUrgent: boolean;
  createdAt: Date;
  resolvedAt: Date | null;
}

// Re-export the Prisma `PayerPolicy` row type under the tool's name so callers
// (and Qwen tool schemas) reference a single, stable shape.
export type { PayerPolicy };

/**
 * The result of validating a diagnosis code against the NIH Clinical Tables
 * ICD-10-CM API (Requirement 3.3). `validated` is `true` only when the external
 * service confirmed the code; a network error or non-200 response degrades the
 * result to `{ name: "", validated: false }` (Requirement 3.7).
 */
export interface CodeLookupResult {
  code: string;
  name: string;
  validated: boolean;
}

/**
 * Injectable dependencies for `lookupDiagnosisCode`, so tests can drive the tool
 * without any network access. Both default to production values: the global
 * `fetch` and the configured NIH base URL.
 */
export interface DiagnosisLookupDeps {
  /** HTTP implementation. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** NIH Clinical Tables ICD-10-CM search base URL. Defaults to config. */
  baseUrl?: string;
}

// ─── Prisma-backed tools (Requirements 3.1, 3.2, 3.4) ────────────────────────

/**
 * Fetch a patient's record and every associated Chart_Note (Requirement 3.1).
 *
 * Scoped to Medical_Review. Throws when no patient matches the id; the caller
 * (`dispatchTool`) catches tool errors, records a failure Trace_Step, and
 * returns an error observation rather than terminating the Case (Req 3.6).
 */
export async function fetchPatientRecord(
  patientId: string,
): Promise<PatientRecord> {
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    include: { chartNotes: true },
  });

  if (!patient) {
    throw new Error(`No patient record found for patientId "${patientId}"`);
  }

  const { chartNotes, ...patientFields } = patient;
  return { patient: patientFields, chartNotes };
}

/**
 * Fetch the medical-necessity Payer_Policy matching a payer + procedure code,
 * or `null` when no policy matches (Requirement 3.2).
 *
 * Scoped to Policy_Review.
 */
export async function fetchPayerPolicy(
  payerId: string,
  procedureCode: string,
): Promise<PayerPolicy | null> {
  return prisma.payerPolicy.findFirst({
    where: { payerId, procedureCode },
  });
}

/**
 * Return the given patient's past Cases as prior-auth history (Requirement 3.4).
 *
 * The query is filtered strictly by `patientId`, so a patient's history never
 * includes another patient's Cases (prior-auth history isolation). Results are
 * newest-first.
 */
export async function checkPriorAuthHistory(
  patientId: string,
): Promise<CaseSummary[]> {
  const cases = await prisma.case.findMany({
    where: { patientId },
    orderBy: { createdAt: "desc" },
  });

  return cases.map((c) => ({
    id: c.id,
    status: c.status as CaseStatus,
    intakeType: c.intakeType,
    payerId: c.payerId,
    payerName: c.payerName,
    denialReason: c.denialReason,
    resolutionPath: c.resolutionPath as ResolutionPath | null,
    overallConfidence: c.overallConfidence,
    isUrgent: c.isUrgent,
    createdAt: c.createdAt,
    resolvedAt: c.resolvedAt,
  }));
}

// ─── External tool: NIH diagnosis-code lookup (Requirements 3.3, 3.7) ─────────

/**
 * Validate an ICD-10-CM diagnosis code against the NIH Clinical Tables API
 * (Requirement 3.3), degrading gracefully when the service is unavailable
 * (Requirement 3.7).
 *
 * On success the tool returns `{ code, name, validated: true }` using the
 * canonical name the API returns for the code. Any failure mode — a thrown
 * network error, a non-200 response, or a body that does not confirm the code —
 * is treated as "could not validate": the tool returns
 * `{ code, name: "", validated: false }` rather than throwing, so the diagnosis
 * field simply stays unvalidated and never blocks the pipeline.
 *
 * The HTTP call is injectable via `deps` so tests need no network: `fetchImpl`
 * defaults to the global `fetch` and `baseUrl` defaults to the configured
 * `NIH_CLINICAL_TABLES_BASE`.
 *
 * The NIH search endpoint responds with the shape
 * `[total, [codes], null, [[code, name], ...]]`; we match `code` against the
 * returned code column and read its paired display name.
 */
export async function lookupDiagnosisCode(
  code: string,
  deps: DiagnosisLookupDeps = {},
): Promise<CodeLookupResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const baseUrl = deps.baseUrl ?? getConfig().nihClinicalTablesBase;

  // Graceful degradation: any failure resolves to an unvalidated result.
  const unvalidated: CodeLookupResult = { code, name: "", validated: false };

  try {
    const url = new URL(baseUrl);
    // Search by the code column and ask for [code, name] display pairs.
    url.searchParams.set("sf", "code");
    url.searchParams.set("terms", code);
    url.searchParams.set("df", "code,name");

    const response = await fetchImpl(url.toString());

    if (!response || !response.ok) {
      return unvalidated;
    }

    const body = (await response.json()) as unknown;

    // Expected shape: [total, [codes], hashOrNull, [[code, name], ...]].
    if (!Array.isArray(body) || body.length < 4) {
      return unvalidated;
    }

    const rows = body[3];
    if (!Array.isArray(rows)) {
      return unvalidated;
    }

    // Prefer an exact code match; fall back to the first returned row.
    const normalized = code.trim().toUpperCase();
    const match =
      rows.find(
        (row): row is unknown[] =>
          Array.isArray(row) &&
          typeof row[0] === "string" &&
          row[0].trim().toUpperCase() === normalized,
      ) ?? undefined;

    if (!match) {
      return unvalidated;
    }

    const matchedCode = match[0];
    const matchedName = match[1];
    if (typeof matchedCode !== "string" || typeof matchedName !== "string") {
      return unvalidated;
    }

    return { code: matchedCode, name: matchedName, validated: true };
  } catch {
    // Network errors, malformed JSON, bad URLs — all degrade gracefully.
    return unvalidated;
  }
}
