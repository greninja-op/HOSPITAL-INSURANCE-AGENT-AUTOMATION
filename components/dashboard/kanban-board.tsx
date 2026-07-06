"use client";

// =============================================================================
// components/dashboard/kanban-board.tsx
//
// Dashboard Kanban board (Requirement 10.1). Fetches every Case from
// GET /api/cases and groups them into one column per Case_Status, in the fixed
// order New → Investigating → NeedsHumanInput → AwaitingApproval → AppealSent →
// Resolved → DeniedFinal. Each Case renders as a `CaseCard` that links to its
// Case Detail page (Req 10.2, 10.3).
// =============================================================================

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { CaseStatus } from "@/lib/types";
import type { CaseSummary, ListCasesResponse } from "@/app/api/cases/route";
import { CaseCard } from "./case-card";

/** The seven columns, in board order (Req 10.1). */
const COLUMNS: { status: CaseStatus; label: string }[] = [
  { status: "New", label: "New" },
  { status: "Investigating", label: "Investigating" },
  { status: "NeedsHumanInput", label: "Needs Human Input" },
  { status: "AwaitingApproval", label: "Awaiting Approval" },
  { status: "AppealSent", label: "Appeal Sent" },
  { status: "Resolved", label: "Resolved" },
  { status: "DeniedFinal", label: "Denied (Final)" },
];

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; cases: CaseSummary[] };

/** Group a flat list of Cases into the fixed column order. */
function groupByStatus(cases: CaseSummary[]): Record<CaseStatus, CaseSummary[]> {
  const groups = {
    New: [],
    Investigating: [],
    NeedsHumanInput: [],
    AwaitingApproval: [],
    AppealSent: [],
    Resolved: [],
    DeniedFinal: [],
  } as Record<CaseStatus, CaseSummary[]>;

  for (const c of cases) {
    // Defensive: ignore any unrecognised status rather than throwing.
    if (groups[c.status]) groups[c.status].push(c);
  }
  return groups;
}

export function KanbanBoard() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/cases", { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to load cases (${res.status})`);
        const data = (await res.json()) as ListCasesResponse;
        if (!cancelled) setState({ kind: "ready", cases: data });
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: "error",
            message:
              err instanceof Error ? err.message : "Failed to load cases",
          });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading cases…
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        {state.message}
      </div>
    );
  }

  const groups = groupByStatus(state.cases);

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {COLUMNS.map(({ status, label }) => {
        const columnCases = groups[status];
        return (
          <section
            key={status}
            aria-label={label}
            className="flex w-72 shrink-0 flex-col rounded-lg bg-muted/40"
          >
            <header className="flex items-center justify-between px-3 py-2">
              <h2 className="text-sm font-semibold text-foreground">{label}</h2>
              <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                {columnCases.length}
              </span>
            </header>
            <div className="flex flex-col gap-2 px-2 pb-3">
              {columnCases.length === 0 ? (
                <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                  No cases
                </p>
              ) : (
                columnCases.map((c) => <CaseCard key={c.id} caseSummary={c} />)
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
