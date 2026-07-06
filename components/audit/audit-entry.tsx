// =============================================================================
// components/audit/audit-entry.tsx
//
// Renders a single entry in the merged Audit_Trail (Requirement 9.3). An entry
// is either an Extracted_Field record or a Trace_Step record (which also covers
// human actions via `stepType === "human_action"`). Each entry shows its kind,
// timestamp, and the details relevant to that kind so the whole chronological
// trail reads as one continuous defensible record.
// =============================================================================

import {
  Braces,
  FileText,
  GitBranch,
  Stethoscope,
  ScrollText,
  ShieldCheck,
  Target,
  UserCog,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MergedAuditEntry } from "@/lib/audit";
import type { StepType } from "@/lib/types";

/** Human-readable label for each Trace_Step type shown in the trail. */
const STEP_LABELS: Record<StepType, string> = {
  tool_call: "Tool call",
  decision: "Decision",
  human_action: "Human action",
  medical_review: "Medical review",
  policy_review: "Policy review",
  strategy: "Strategy",
  verification: "Verification",
};

/** Icon per Trace_Step type; falls back to a generic branch icon. */
const STEP_ICONS: Record<StepType, React.ComponentType<{ className?: string }>> = {
  tool_call: Wrench,
  decision: GitBranch,
  human_action: UserCog,
  medical_review: Stethoscope,
  policy_review: ScrollText,
  strategy: Target,
  verification: ShieldCheck,
};

interface AuditEntryProps {
  entry: MergedAuditEntry;
  /** 1-based sequence number within the merged trail. */
  index: number;
}

/** Compactly stringify a Trace_Step input/output JSON value, or "" when empty. */
function stringifyJson(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTimestamp(ts: Date): string {
  return ts.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function AuditEntry({ entry, index }: AuditEntryProps) {
  const isField = entry.kind === "extracted_field";
  const stepType = isField ? null : (entry.step.stepType as StepType);
  const Icon = isField ? FileText : (STEP_ICONS[stepType!] ?? Braces);

  return (
    <li className="relative flex gap-3 pl-1">
      {/* Timeline node */}
      <span
        className={cn(
          "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
          isField
            ? "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400"
            : "border-primary/30 bg-primary/10 text-primary",
        )}
        aria-hidden
      >
        <Icon className="h-4 w-4" />
      </span>

      <div className="min-w-0 flex-1 pb-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-muted-foreground">
            #{index}
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
              isField
                ? "bg-sky-500/10 text-sky-600 dark:text-sky-400"
                : "bg-primary/10 text-primary",
            )}
          >
            {isField ? "Extracted field" : STEP_LABELS[stepType!] ?? "Trace step"}
          </span>
          <time
            className="text-[11px] text-muted-foreground"
            dateTime={entry.timestamp.toISOString()}
          >
            {formatTimestamp(entry.timestamp)}
          </time>
        </div>

        {isField ? (
          <div className="mt-1.5 space-y-1">
            <p className="text-sm font-medium text-foreground">
              {entry.field.fieldName}:{" "}
              <span className="font-normal text-muted-foreground">
                {entry.field.value}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              Confidence{" "}
              <span className="font-mono text-foreground">
                {entry.field.confidence}
              </span>{" "}
              · Source{" "}
              <span className="font-mono text-foreground">
                {entry.field.sourceType}
              </span>
            </p>
            {entry.field.reasoning ? (
              <p className="text-xs text-muted-foreground">
                {entry.field.reasoning}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="mt-1.5 space-y-1.5">
            {entry.step.toolName ? (
              <p className="text-sm font-medium text-foreground">
                {entry.step.toolName}
              </p>
            ) : null}
            {entry.step.reasoning ? (
              <p className="text-sm text-foreground">{entry.step.reasoning}</p>
            ) : null}
            <StepPayload label="Input" value={entry.step.input} />
            <StepPayload label="Output" value={entry.step.output} />
          </div>
        )}
      </div>
    </li>
  );
}

/** Render a Trace_Step input/output payload as a collapsible code block. */
function StepPayload({ label, value }: { label: string; value: unknown }) {
  const text = stringifyJson(value);
  if (!text) return null;
  return (
    <details className="group rounded-md border border-border bg-muted/40">
      <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-medium text-muted-foreground marker:content-none">
        {label}
      </summary>
      <pre className="overflow-x-auto px-2 pb-2 font-mono text-[11px] leading-relaxed text-foreground">
        {text}
      </pre>
    </details>
  );
}
