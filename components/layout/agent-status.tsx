"use client";

// =============================================================================
// components/layout/agent-status.tsx
//
// Live agent-status indicator (Requirements 19.3, 19.4). While the Agent_Runner
// is executing a Case, this shows the running Case identifier; while no run is
// in progress it shows "Idle".
//
// The indicator polls an optional status endpoint (`GET /api/agent-status`).
// Until that endpoint exists it degrades gracefully to "Idle" rather than
// surfacing an error, so the shell remains usable throughout the build-out.
// =============================================================================

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 4000;

/** Shape returned by the (optional) agent-status endpoint. */
interface AgentStatusResponse {
  /** The Case id currently being processed, or null/absent when idle. */
  runningCaseId?: string | null;
}

export function AgentStatus() {
  const [runningCaseId, setRunningCaseId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/agent-status", { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setRunningCaseId(null);
          return;
        }
        const data = (await res.json()) as AgentStatusResponse;
        if (!cancelled) setRunningCaseId(data.runningCaseId ?? null);
      } catch {
        // Endpoint unavailable — treat as idle rather than erroring.
        if (!cancelled) setRunningCaseId(null);
      }
    }

    void poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const running = runningCaseId !== null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium",
        running
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          running ? "animate-pulse bg-primary" : "bg-muted-foreground/50",
        )}
        aria-hidden
      />
      {running ? (
        <span className="font-mono">Running Case #{runningCaseId}</span>
      ) : (
        <span>Idle</span>
      )}
    </div>
  );
}
