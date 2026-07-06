"use client";

// =============================================================================
// components/audit/audit-trail.tsx
//
// Merged chronological Audit_Trail for a Case (Requirement 9.3) plus the
// "Export PDF" (Req 9.4) and "Verify audit chain" (Req 25.4–25.7) controls.
//
// Fetches the full Case detail from GET /api/cases/[id] (which returns the
// Case's Extracted_Field and Trace_Step records — the latter also covering
// human actions via `stepType === "human_action"`), then merges them into a
// single chronological list using the shared, pure `mergeAuditTrail` helper so
// the UI shares the exact ordering logic the export PDF uses.
// =============================================================================

import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { mergeAuditTrail, type MergedAuditEntry } from "@/lib/audit";
import type { CaseDetail } from "@/app/api/cases/[id]/route";
import { AuditEntry } from "./audit-entry";
import { AuditChainVerifier } from "./audit-chain-verifier";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; detail: CaseDetail; entries: MergedAuditEntry[] };

interface AuditTrailProps {
  caseId: string;
}

/**
 * Merge the Case detail's Extracted_Field and Trace_Step records into one
 * chronological Audit_Trail. The API serialises timestamps as ISO strings, so
 * we revive them to `Date` before handing them to the shared merge helper.
 */
function buildEntries(detail: CaseDetail): MergedAuditEntry[] {
  const fields = detail.extractedFields.map((f) => ({
    fieldName: f.fieldName,
    value: f.value,
    confidence: f.confidence,
    sourceType: f.sourceType,
    reasoning: f.reasoning,
    timestamp: new Date(f.timestamp),
  }));
  const steps = detail.traceSteps.map((s) => ({
    stepType: s.stepType,
    toolName: s.toolName,
    input: s.input,
    output: s.output,
    reasoning: s.reasoning,
    timestamp: new Date(s.timestamp),
  }));
  return mergeAuditTrail(fields, steps);
}

export function AuditTrail({ caseId }: AuditTrailProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/cases/${caseId}`, { cache: "no-store" });
        if (res.status === 404) {
          throw new Error(`Case "${caseId}" was not found.`);
        }
        if (!res.ok) {
          throw new Error(`Failed to load case (${res.status})`);
        }
        const detail = (await res.json()) as CaseDetail;
        if (!cancelled) {
          setState({ kind: "ready", detail, entries: buildEntries(detail) });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: "error",
            message:
              err instanceof Error ? err.message : "Failed to load audit trail",
          });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  const exportHref = `/api/cases/${caseId}/audit/export`;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <a
            href={exportHref}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors",
              "hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            )}
          >
            <Download className="h-4 w-4" aria-hidden />
            Export PDF
          </a>
        </div>
        <AuditChainVerifier caseId={caseId} />
      </div>

      {state.kind === "loading" ? (
        <div className="flex h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading audit trail…
        </div>
      ) : state.kind === "error" ? (
        <div className="flex h-56 items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 px-4 text-center text-sm text-destructive">
          {state.message}
        </div>
      ) : state.entries.length === 0 ? (
        <div className="flex h-56 items-center justify-center rounded-md border border-border bg-card text-center text-sm text-muted-foreground">
          No audit records recorded for this case yet.
        </div>
      ) : (
        <ol className="relative ml-1 border-l border-border pl-5">
          {state.entries.map((entry, i) => (
            <AuditEntry
              key={`${entry.kind}-${i}-${entry.timestamp.getTime()}`}
              entry={entry}
              index={i + 1}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
