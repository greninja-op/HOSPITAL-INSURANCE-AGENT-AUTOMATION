"use client";

// =============================================================================
// components/case/source-tag.tsx
//
// The expandable Extracted_Field source tag for the case-facts panel
// (Requirements 13.1, 13.2). Collapsed, it shows the provenance of a value as a
// short labeled chip (raw intake, chart note, payer policy, code lookup, or
// human-provided). Expanded, it reveals the source document or tool that
// produced the value — the field's reasoning — so the Operator can trace where
// a fact came from (Req 13.2).
// =============================================================================

import { useId, useState } from "react";
import {
  ChevronDown,
  FileText,
  Stethoscope,
  ScrollText,
  Search,
  UserPen,
  HelpCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SourceType } from "@/lib/types";

/** Human-readable label + icon + describing noun for each source type. */
const SOURCE_META: Record<
  SourceType,
  { label: string; icon: typeof FileText; noun: string }
> = {
  raw_intake: { label: "Raw intake", icon: FileText, noun: "source document" },
  chart_note: { label: "Chart note", icon: Stethoscope, noun: "source document" },
  payer_policy: { label: "Payer policy", icon: ScrollText, noun: "source document" },
  code_lookup: { label: "Code lookup", icon: Search, noun: "tool" },
  human_provided: { label: "Human provided", icon: UserPen, noun: "source" },
};

interface SourceTagProps {
  sourceType: SourceType;
  /** The field's reasoning — the source document or tool that produced it. */
  reasoning: string;
}

export function SourceTag({ sourceType, reasoning }: SourceTagProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const meta = SOURCE_META[sourceType] ?? {
    label: sourceType,
    icon: HelpCircle,
    noun: "source",
  };
  const Icon = meta.icon;

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 font-medium text-muted-foreground transition-colors",
          "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        )}
      >
        <Icon className="h-3 w-3" aria-hidden />
        {meta.label}
        <ChevronDown
          className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>

      {open ? (
        <div
          id={panelId}
          className="mt-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-muted-foreground"
        >
          <p className="font-medium text-foreground">
            {meta.label} · {meta.noun}
          </p>
          <p className="mt-0.5 whitespace-pre-wrap break-words">
            {reasoning.trim().length > 0
              ? reasoning
              : "No further source detail was recorded for this value."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
