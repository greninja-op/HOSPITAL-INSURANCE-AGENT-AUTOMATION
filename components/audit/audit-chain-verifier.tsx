"use client";

// =============================================================================
// components/audit/audit-chain-verifier.tsx
//
// "Verify audit chain" control (Requirement 25.4–25.7). Calls
// GET /api/cases/[id]/audit/verify and reports whether the tamper-evident
// Audit_Chain is intact or has been tampered with, surfacing the first broken
// event and the break reason when the chain fails verification.
// =============================================================================

import { useState } from "react";
import { Loader2, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AuditVerifyResult } from "@/lib/types";

type VerifyState =
  | { kind: "idle" }
  | { kind: "verifying" }
  | { kind: "error"; message: string }
  | { kind: "done"; result: AuditVerifyResult };

const REASON_LABELS: Record<NonNullable<AuditVerifyResult["reason"]>, string> = {
  hash_mismatch: "an event's stored hash does not match its content",
  prevhash_mismatch: "an event's previous-hash link was broken",
};

interface AuditChainVerifierProps {
  caseId: string;
}

export function AuditChainVerifier({ caseId }: AuditChainVerifierProps) {
  const [state, setState] = useState<VerifyState>({ kind: "idle" });

  async function verify() {
    setState({ kind: "verifying" });
    try {
      const res = await fetch(`/api/cases/${caseId}/audit/verify`, {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`Verification request failed (${res.status})`);
      }
      const result = (await res.json()) as AuditVerifyResult;
      setState({ kind: "done", result });
    } catch (err) {
      setState({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Failed to verify audit chain",
      });
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={() => void verify()}
        disabled={state.kind === "verifying"}
        className={cn(
          "inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        {state.kind === "verifying" ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <ShieldQuestion className="h-4 w-4" aria-hidden />
        )}
        Verify audit chain
      </button>

      {state.kind === "error" ? (
        <p className="text-xs text-destructive" role="alert">
          {state.message}
        </p>
      ) : null}

      {state.kind === "done" ? (
        state.result.intact ? (
          <p
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400"
            role="status"
          >
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            Audit chain intact
          </p>
        ) : (
          <div
            className="max-w-xs rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
            role="alert"
          >
            <p className="inline-flex items-center gap-1.5 font-semibold">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
              Audit chain tampered
            </p>
            {state.result.reason ? (
              <p className="mt-1">
                Detected because {REASON_LABELS[state.result.reason]}.
              </p>
            ) : null}
            {state.result.firstBrokenEventId ? (
              <p className="mt-1 font-mono text-[11px]">
                First broken event: {state.result.firstBrokenEventId}
              </p>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}
