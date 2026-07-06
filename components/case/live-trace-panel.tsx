"use client";

// =============================================================================
// components/case/live-trace-panel.tsx
//
// Live Agent Trace panel for the Case Detail screen (Requirement 11).
//
// Renders the Case's Trace_Steps as a dark terminal-style feed. WHILE the Case
// status is "Investigating", it polls GET /api/cases/[id]/trace?since=<ts> once
// per second (Req 11.1) and appends any newly-created steps in chronological
// order with a Framer Motion entrance animation (Req 11.2). Each line shows the
// step reasoning and, for tool calls, the tool name (Req 11.4), plus a stage
// icon/label derived from the step's `stepType` so the multi-stage pipeline is
// visible (Req 11.5, 20.7–20.10):
//   🩺 Medical review · 📚 Policy review · 🎯 Strategy · ✅ Verification ·
//   🤖 Decision · 👤 Human action · 🔧 <tool name> for tool calls.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, Radio, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StepType } from "@/lib/types";
import type { TraceStepDetail } from "@/app/api/cases/[id]/route";

/** Poll interval while the Case is Investigating (Req 11.1). */
const POLL_MS = 1000;

/** Shape returned by GET /api/cases/[id]/trace. */
interface TraceResponse {
  steps: TraceStepDetail[];
}

/** Stage icon + label per step type (Req 11.5, 20.7–20.10). */
const STAGE_META: Record<StepType, { icon: string; label: string; tone: string }> = {
  medical_review: { icon: "🩺", label: "Medical review", tone: "text-rose-400" },
  policy_review: { icon: "📚", label: "Policy review", tone: "text-sky-400" },
  strategy: { icon: "🎯", label: "Strategy", tone: "text-violet-400" },
  verification: { icon: "✅", label: "Verification", tone: "text-emerald-400" },
  decision: { icon: "🤖", label: "Decision", tone: "text-amber-400" },
  human_action: { icon: "👤", label: "Human action", tone: "text-teal-400" },
  tool_call: { icon: "🔧", label: "Tool call", tone: "text-slate-300" },
};

interface LiveTracePanelProps {
  caseId: string;
  /** Current Case status; polling runs only while "Investigating" (Req 11.1). */
  status: string;
  /** Trace steps already loaded with the Case detail (chronological). */
  initialSteps: TraceStepDetail[];
}

export function LiveTracePanel({
  caseId,
  status,
  initialSteps,
}: LiveTracePanelProps) {
  const [steps, setSteps] = useState<TraceStepDetail[]>(initialSteps);
  const [polling, setPolling] = useState(false);

  // Track the ids we already hold so redeliveries never double-append, and the
  // most recent timestamp so we only request steps created after it (Req 11.3).
  const seenIds = useRef<Set<string>>(new Set(initialSteps.map((s) => s.id)));
  const scrollRef = useRef<HTMLDivElement>(null);

  // Re-seed when the parent hands down a fresh initial set (e.g. after a
  // full-case refetch), keeping the seen-id set in sync.
  useEffect(() => {
    setSteps(initialSteps);
    seenIds.current = new Set(initialSteps.map((s) => s.id));
  }, [initialSteps]);

  const latestTimestamp = useCallback((): string | null => {
    if (steps.length === 0) return null;
    return steps[steps.length - 1].timestamp;
  }, [steps]);

  useEffect(() => {
    if (status !== "Investigating") {
      setPolling(false);
      return;
    }

    let cancelled = false;
    setPolling(true);

    async function poll() {
      const since = latestTimestamp();
      const url = since
        ? `/api/cases/${caseId}/trace?since=${encodeURIComponent(since)}`
        : `/api/cases/${caseId}/trace`;
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as TraceResponse;
        if (cancelled || data.steps.length === 0) return;

        const fresh = data.steps.filter((s) => !seenIds.current.has(s.id));
        if (fresh.length === 0) return;
        for (const s of fresh) seenIds.current.add(s.id);
        // Append in chronological order (Req 11.2).
        setSteps((prev) => [...prev, ...fresh]);
      } catch {
        // Transient network errors are ignored; the next tick retries.
      }
    }

    // Poll immediately, then once per second (Req 11.1).
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [caseId, status, latestTimestamp]);

  // Keep the newest line in view as steps stream in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps]);

  return (
    <section
      aria-label="Live agent trace"
      className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-slate-950 text-slate-100"
    >
      <header className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
        <Terminal className="h-4 w-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold">Live agent trace</h2>
        {polling ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
            <Radio className="h-3.5 w-3.5 animate-pulse" aria-hidden />
            Live · polling every 1s
          </span>
        ) : (
          <span className="ml-auto text-xs text-slate-500">
            {steps.length} step{steps.length === 1 ? "" : "s"}
          </span>
        )}
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed"
      >
        {steps.length === 0 ? (
          <div className="flex items-center gap-2 px-1 py-8 text-slate-500">
            {status === "Investigating" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Waiting for the agent&apos;s first step…
              </>
            ) : (
              "No trace steps recorded for this case."
            )}
          </div>
        ) : (
          <ol className="space-y-2">
            <AnimatePresence initial={false}>
              {steps.map((step) => (
                <TraceLine key={step.id} step={step} />
              ))}
            </AnimatePresence>
          </ol>
        )}
      </div>
    </section>
  );
}

/** A single animated trace line with its stage label and reasoning. */
function TraceLine({ step }: { step: TraceStepDetail }) {
  const meta = STAGE_META[step.stepType] ?? {
    icon: "•",
    label: step.stepType,
    tone: "text-slate-300",
  };
  // For tool calls, surface the tool name alongside the stage label (Req 11.4).
  const label =
    step.stepType === "tool_call" && step.toolName
      ? step.toolName
      : meta.label;

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="rounded-md border border-slate-800/70 bg-slate-900/60 px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden>{meta.icon}</span>
        <span className={cn("font-semibold", meta.tone)}>{label}</span>
        <time
          className="ml-auto text-[10px] tabular-nums text-slate-500"
          dateTime={step.timestamp}
        >
          {new Date(step.timestamp).toLocaleTimeString()}
        </time>
      </div>
      {step.reasoning.trim().length > 0 ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-slate-300">
          {step.reasoning}
        </p>
      ) : null}
    </motion.li>
  );
}
