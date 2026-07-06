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

import { Prisma } from "@prisma/client";
import type {
  ChartNote,
  Patient,
  PayerPolicy,
} from "@prisma/client";

import { generateAppealPdf } from "./appealPdf";
import { getConfig } from "./config";
import {
  createTraceStep,
  prisma,
  type CreateTraceStepInput,
  type CreateTraceStepResult,
} from "./db";
import type {
  AppealContent,
  CaseStatus,
  PipelineStage,
  ResolutionPath,
} from "./types";

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

// ─── Centralized dispatch + tracing (Requirements 3.5, 3.6) ──────────────────

/**
 * The Qwen-visible tool names dispatch understands. This is the single source
 * of truth mapping a tool name string (as it appears in a Qwen tool call) to a
 * concrete Agent_Tool implementation.
 */
export type ToolName =
  | "fetchPatientRecord"
  | "fetchPayerPolicy"
  | "checkPriorAuthHistory"
  | "lookupDiagnosisCode"
  | "generateAppealPdf";

/**
 * The observation returned to the agent loop for a single tool invocation.
 * `dispatchTool` NEVER throws: a failed tool resolves to `{ ok: false, error }`
 * so the loop can continue (Requirement 3.6).
 */
export type ToolObservation =
  | { ok: true; tool: string; result: unknown }
  | { ok: false; tool: string; error: string };

/**
 * Injectable dependencies for `dispatchTool`, so tests can capture the recorded
 * Trace_Steps without a database. `persistTraceStep` defaults to the guarded
 * `createTraceStep` from `lib/db.ts`.
 */
export interface DispatchDeps {
  persistTraceStep?: (
    input: CreateTraceStepInput,
  ) => Promise<CreateTraceStepResult>;
}

/**
 * Convert an arbitrary tool input/output value into a Prisma-storable JSON
 * value. A JSON round-trip normalizes `Date`s (→ ISO strings) and drops
 * `undefined`, keeping the Trace_Step payload persistable. `undefined`/`null`
 * map to `null` so `createTraceStep` records a JSON null.
 */
function toJsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Read a required string argument from a Qwen tool-call argument bag. */
function requireStringArg(
  args: Record<string, unknown>,
  key: string,
  toolName: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Tool "${toolName}" requires a non-empty string argument "${key}".`,
    );
  }
  return value;
}

/**
 * Run the concrete Agent_Tool for `name`, extracting its arguments from the
 * Qwen tool-call argument bag. Throws for an unknown tool or missing/invalid
 * arguments; `dispatchTool` catches every throw and turns it into a failure
 * observation + Trace_Step.
 *
 * `caseId` is the dispatch-scoped Case, used as the identity for tools that key
 * off the current Case (e.g. `generateAppealPdf`).
 */
async function invokeTool(
  name: string,
  args: Record<string, unknown>,
  caseId: string,
): Promise<unknown> {
  switch (name) {
    case "fetchPatientRecord":
      return fetchPatientRecord(requireStringArg(args, "patientId", name));
    case "fetchPayerPolicy":
      return fetchPayerPolicy(
        requireStringArg(args, "payerId", name),
        requireStringArg(args, "procedureCode", name),
      );
    case "checkPriorAuthHistory":
      return checkPriorAuthHistory(requireStringArg(args, "patientId", name));
    case "lookupDiagnosisCode":
      return lookupDiagnosisCode(requireStringArg(args, "code", name));
    case "generateAppealPdf":
      return generateAppealPdf(caseId, args.content as AppealContent);
    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}

/**
 * Centralized dispatch + tracing for every Agent_Tool call the Agent_Runner
 * makes. Maps a Qwen tool `name` to its implementation, invokes it with the
 * supplied `args`, and — on BOTH success and failure — records a `"tool_call"`
 * Trace_Step carrying the tool name, input, output, reasoning, and timestamp
 * via `createTraceStep` (Requirement 3.5). The Trace_Step's timestamp is the
 * persisted row's own creation time.
 *
 * Every tool call is wrapped in try/catch. On failure — an unknown tool, an
 * invalid argument, or a thrown tool error — dispatch records a failure
 * `"tool_call"` Trace_Step describing the error and returns an error
 * observation instead of throwing, so the agent loop continues without
 * terminating the Case (Requirement 3.6). `dispatchTool` NEVER throws.
 *
 * The persistence dependency is injectable via `deps.persistTraceStep` (default
 * `createTraceStep`) for testability.
 *
 * EXTENSION POINT (Task 11.3 — stage-scoped allow-lists): the optional `stage`
 * parameter is threaded through so a later task can gate dispatch on a
 * per-stage `STAGE_TOOLS` allow-list — refusing (and recording a failure
 * `Trace_Step` for) any tool not permitted in the active stage (Requirements
 * 3.8, 3.9). The base dispatch here does NOT yet enforce any allow-list.
 */
export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  caseId: string,
  stage?: PipelineStage,
  deps: DispatchDeps = {},
): Promise<ToolObservation> {
  const persistTraceStep = deps.persistTraceStep ?? createTraceStep;
  const stageLabel = stage ? ` during ${stage}` : "";

  try {
    const result = await invokeTool(name, args, caseId);

    // Success Trace_Step: tool name, input, output, reasoning (Req 3.5).
    await persistTraceStep({
      caseId,
      stepType: "tool_call",
      toolName: name,
      input: toJsonValue(args),
      output: toJsonValue(result),
      reasoning: `Invoked tool "${name}"${stageLabel}; call succeeded.`,
    });

    return { ok: true, tool: name, result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    // Failure Trace_Step describing the failure; loop continues (Req 3.6).
    // Guard the persistence itself so a tracing failure can never throw out of
    // dispatch and terminate the Case.
    try {
      await persistTraceStep({
        caseId,
        stepType: "tool_call",
        toolName: name,
        input: toJsonValue(args),
        output: toJsonValue({ error }),
        reasoning: `Tool "${name}"${stageLabel} failed: ${error}`,
      });
    } catch (persistErr) {
      const detail =
        persistErr instanceof Error ? persistErr.message : String(persistErr);
      console.error(
        `[dispatchTool] Failed to record failure Trace_Step for tool "${name}": ${detail}`,
      );
    }

    return { ok: false, tool: name, error };
  }
}
