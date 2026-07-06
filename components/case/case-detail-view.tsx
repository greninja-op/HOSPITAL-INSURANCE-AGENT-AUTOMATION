"use client";

// =============================================================================
// components/case/case-detail-view.tsx
//
// Client orchestrator for the Case Detail screen (Requirement 13). Fetches the
// full Case detail from GET /api/cases/[id] and composes the three panels:
//
//   • CaseFactsPanel  — each Extracted_Field with value, confidence, source tag
//                       (Req 13.1, 13.2)
//   • LiveTracePanel  — live Trace_Steps, polling /trace every 1s while
//                       Investigating (Req 11, 13.3)
//   • HumanActionZone — recommendation + actions + appeal preview (Req 8, 13.3,
//                       13.4, 15.2, 22.6, 24.1, 7.5)
//
// While the Case is still working (status New/Investigating) the view re-polls
// the Case detail so the recommendation and action controls appear as soon as
// the agent transitions the Case, and it refetches on demand after any operator
// action so the new status is reflected immediately.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, FileClock, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CaseDetail } from "@/app/api/cases/[id]/route";
import { CaseFactsPanel } from "./case-facts-panel";
import { LiveTracePanel } from "./live-trace-panel";
import { HumanActionZone } from "./human-action-zone";

/** Statuses for which the agent is still working and detail should re-poll. */
const WORKING_STATUSES = new Set(["New", "Investigating"]);

/** Re-poll interval for the whole Case detail while the agent is working. */
const DETAIL_POLL_MS = 2000;

type LoadState =
  | { kind: "loading" }
  | { kind: "notfound" }
  | { kind: "error"; message: string }
  | { kind: "ready"; detail: CaseDetail };

/** Readable label per Case_Status for the header badge. */
const STATUS_LABELS: Record<string, string> = {
  New: "New",
  Investigating: "Investigating",
  NeedsHumanInput: "Needs Human Input",
  AwaitingApproval: "Awaiting Approval",
  AppealSent: "Appeal Sent",
  Resolved: "Resolved",
  DeniedFinal: "Denied (Final)",
};

export function CaseDetailView({ caseId }: { caseId: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const cancelledRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cases/${caseId}`, { cache: "no-store" });
      if (res.status === 404) {
        if (!cancelledRef.current) setState({ kind: "notfound" });
        return;
      }
      if (!res.ok) throw new Error(`Failed to load case (${res.status})`);
      const detail = (await res.json()) as CaseDetail;
      if (!cancelledRef.current) setState({ kind: "ready", detail });
    } catch (err) {
      if (!cancelledRef.current) {
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load case",
        });
      }
    }
  }, [caseId]);

  // Initial load.
  useEffect(() => {
    cancelledRef.current = false;
    void load();
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

  // Re-poll the whole detail while the agent is still working, so the
  // recommendation and action controls surface as soon as the Case transitions.
  const status = state.kind === "ready" ? state.detail.status : null;
  useEffect(() => {
    if (!status || !WORKING_STATUSES.has(status)) return;
    const timer = setInterval(() => void load(), DETAIL_POLL_MS);
    return () => clearInterval(timer);
  }, [status, load]);

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading case…
      </div>
    );
  }

  if (state.kind === "notfound") {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-border bg-card p-6 text-center">
          <FileClock className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
          <h1 className="mt-3 text-lg font-semibold">Case not found</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            No case matches <span className="font-mono">{caseId}</span>.
          </p>
          <Link
            href="/"
            className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="p-6">
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{state.message}</span>
        </div>
      </div>
    );
  }

  const detail = state.detail;

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* Header ------------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Dashboard
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-lg font-semibold tracking-tight">
          {detail.patientName ?? "Unknown patient"}
        </h1>
        <span className="font-mono text-xs text-muted-foreground">
          #{detail.id.slice(0, 8)}
        </span>
        <span
          className={cn(
            "ml-auto rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground",
          )}
        >
          {STATUS_LABELS[detail.status] ?? detail.status}
        </span>
        {detail.isUrgent ? (
          <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive">
            Urgent
          </span>
        ) : null}
        {detail.payerName ? (
          <span className="text-sm text-muted-foreground">
            {detail.payerName}
          </span>
        ) : null}
      </div>

      {/* Three-panel layout ------------------------------------------------- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <CaseFactsPanel fields={detail.extractedFields} />
        </div>
        <div className="min-h-[24rem] lg:col-span-1">
          <LiveTracePanel
            caseId={detail.id}
            status={detail.status}
            initialSteps={detail.traceSteps}
          />
        </div>
        <div className="lg:col-span-1">
          <HumanActionZone detail={detail} onActionComplete={load} />
        </div>
      </div>
    </div>
  );
}
