// =============================================================================
// lib/db.ts
//
// Shared Prisma client module for AuthPilot. Every API route, the nine-stage
// Agent_Runner, and the hardening modules import the SAME `prisma` instance
// from here so the app opens exactly one connection pool.
//
// In development, Next.js hot-reloading re-evaluates modules on every change,
// which would otherwise spawn a new PrismaClient (and connection pool) each
// time. We stash the instance on `globalThis` to survive reloads.
// =============================================================================

import { Prisma, PrismaClient, type TraceStep } from "@prisma/client";
import { STEP_TYPES, type StepType } from "./types";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// =============================================================================
// createTraceStep — Trace_Step persistence guard (Requirements 23.3, 23.6)
//
// Every Trace_Step written by the Agent_Runner and the Shared_Case_Action must
// pass through this guard. It admits a Trace_Step ONLY when its `stepType` is
// one of the seven allowed values (STEP_TYPES). Any other value is rejected: the
// row is NOT created, an error indication identifying the invalid step type is
// recorded (logged) and returned, so callers can react without a thrown error
// crashing the pipeline (Requirement 23.6).
// =============================================================================

/**
 * The persistable content of a Trace_Step. `stepType` is intentionally a plain
 * `string` here — validating it against the seven allowed values is this guard's
 * whole job, so callers cannot bypass it by narrowing the type at the call site.
 *
 * The Audit_Chain (Requirement 25) supplies `prevHash`/`hash`; they default to
 * empty strings so the guard is usable before that module is wired in.
 */
export interface CreateTraceStepInput {
  caseId: string;
  stepType: string;
  reasoning: string;
  toolName?: string | null;
  input?: Prisma.InputJsonValue | null;
  output?: Prisma.InputJsonValue | null;
  beforeState?: Prisma.InputJsonValue | null;
  afterState?: Prisma.InputJsonValue | null;
  prevHash?: string;
  hash?: string;
}

/**
 * Structured, never-throwing result of the guard. On success it carries the
 * persisted TraceStep; on rejection it carries an error message and echoes the
 * offending `invalidStepType` so the caller (and the audit log) can identify it.
 */
export type CreateTraceStepResult =
  | { ok: true; traceStep: TraceStep }
  | { ok: false; error: string; invalidStepType: string };

const ALLOWED_STEP_TYPES: ReadonlySet<StepType> = new Set(STEP_TYPES);

/** Runtime type guard: true iff `value` is one of the seven allowed step types. */
export function isValidStepType(value: string): value is StepType {
  return ALLOWED_STEP_TYPES.has(value as StepType);
}

/**
 * Persist a Trace_Step, but only if its step type is one of the seven allowed
 * values. Rejects any other step type with a structured error identifying the
 * invalid value; creates the TraceStep row via Prisma when valid.
 *
 * Never throws for an invalid step type — it returns a rejection result so the
 * Agent_Runner and Shared_Case_Action can continue safely (Requirements 23.3, 23.6).
 */
export async function createTraceStep(
  input: CreateTraceStepInput,
): Promise<CreateTraceStepResult> {
  if (!isValidStepType(input.stepType)) {
    const error = `Rejected Trace_Step: invalid step type "${input.stepType}". Allowed values: ${STEP_TYPES.join(", ")}.`;
    // Record the error indication (Requirement 23.6).
    console.error(`[createTraceStep] ${error}`);
    return { ok: false, error, invalidStepType: input.stepType };
  }

  const traceStep = await prisma.traceStep.create({
    data: {
      caseId: input.caseId,
      stepType: input.stepType,
      reasoning: input.reasoning,
      toolName: input.toolName ?? null,
      input: input.input ?? Prisma.JsonNull,
      output: input.output ?? Prisma.JsonNull,
      beforeState: input.beforeState ?? Prisma.JsonNull,
      afterState: input.afterState ?? Prisma.JsonNull,
      prevHash: input.prevHash ?? "",
      hash: input.hash ?? "",
    },
  });

  return { ok: true, traceStep };
}
