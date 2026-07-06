// =============================================================================
// app/api/cases/[id]/trace/route.ts
//
// GET /api/cases/[id]/trace — Live Agent Trace feed (Requirement 11).
//
// Returns a Case's Trace_Steps in chronological order for the live trace panel,
// which polls this endpoint at a 1-second interval while a Case is
// "Investigating" (Req 11.1). Each returned step carries the fields the panel
// needs to render a line — reasoning, and (for tool calls) the tool name
// (Req 11.4) — plus the originating stepType so the UI can show a stage label
// (Req 11.5), and input/output where present.
//
// The optional `since` query parameter supports incremental polling: when
// present, ONLY Trace_Steps with a timestamp strictly AFTER `since` are
// returned (Req 11.3); when absent, all Trace_Steps for the Case are returned.
// `since` accepts either an ISO-8601 timestamp or a millisecond epoch.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";

// Trace data must always reflect the latest persisted rows (the panel polls
// every second), so this route is never statically cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Shape of a single Trace_Step as rendered by the live trace panel. */
interface TraceStepDTO {
  id: string;
  stepType: string;
  toolName: string | null;
  reasoning: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  input?: unknown;
  output?: unknown;
}

/**
 * Parse the optional `since` query param into a Date.
 * Accepts an ISO-8601 timestamp (e.g. "2026-01-01T00:00:00.000Z") or a
 * millisecond epoch (e.g. "1767225600000"). Returns:
 *   - `undefined` when the param is absent (⇒ return all steps),
 *   - a valid `Date` when it parses,
 *   - `null` when it is present but unparseable (⇒ treated as a bad request).
 */
function parseSince(raw: string | null): Date | undefined | null {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // All-digits ⇒ treat as a millisecond epoch.
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const caseId = params.id;

  const since = parseSince(new URL(req.url).searchParams.get("since"));
  if (since === null) {
    return NextResponse.json(
      { error: "Invalid `since` parameter. Provide an ISO-8601 timestamp or a millisecond epoch." },
      { status: 400 },
    );
  }

  // 404 for an unknown Case so the panel can distinguish "no case" from
  // "case exists but has no steps yet" (per design).
  const existingCase = await prisma.case.findUnique({
    where: { id: caseId },
    select: { id: true },
  });
  if (!existingCase) {
    return NextResponse.json({ error: "Case not found." }, { status: 404 });
  }

  // Strictly AFTER `since` (Req 11.3): Prisma `gt` excludes the boundary, so a
  // step whose timestamp equals `since` (the client's last-seen step) is not
  // re-sent. When `since` is absent, no timestamp filter is applied.
  const traceSteps = await prisma.traceStep.findMany({
    where: {
      caseId,
      ...(since ? { timestamp: { gt: since } } : {}),
    },
    orderBy: { timestamp: "asc" }, // chronological order (Req 11.2)
    select: {
      id: true,
      stepType: true,
      toolName: true,
      reasoning: true,
      timestamp: true,
      input: true,
      output: true,
    },
  });

  const steps: TraceStepDTO[] = traceSteps.map((s) => ({
    id: s.id,
    stepType: s.stepType,
    toolName: s.toolName,
    reasoning: s.reasoning,
    timestamp: s.timestamp.toISOString(),
    // Only include input/output when present (tool_call steps), keeping the
    // payload lean for the 1-second poll.
    ...(s.input !== null ? { input: s.input } : {}),
    ...(s.output !== null ? { output: s.output } : {}),
  }));

  return NextResponse.json({ steps });
}
