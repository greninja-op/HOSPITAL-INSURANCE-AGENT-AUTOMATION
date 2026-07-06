"use client";

// =============================================================================
// components/case/case-facts-panel.tsx
//
// Case-facts panel for the Case Detail screen (Requirements 13.1, 13.2).
//
// Lists each Extracted_Field with its value, Confidence_Score, and an
// expandable source tag (Req 13.1). Confidence is shown as a colour-banded
// percentage chip; the source tag expands to reveal the source document or tool
// that produced the value (Req 13.2). Undeterminable fields (value "unknown",
// confidence 0) are rendered plainly so a reviewer can see what could not be
// resolved.
// =============================================================================

import { ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExtractedFieldDetail } from "@/app/api/cases/[id]/route";
import { SourceTag } from "./source-tag";

interface CaseFactsPanelProps {
  fields: ExtractedFieldDetail[];
}

/** A whole-number 0..100 confidence chip, colour-banded high/medium/low. */
function ConfidenceChip({ confidence }: { confidence: number }) {
  const percent = Math.round(Math.min(100, Math.max(0, confidence)));
  const band =
    percent >= 80
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : percent >= 50
        ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "border-destructive/30 bg-destructive/10 text-destructive";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        band,
      )}
      title={`Confidence ${percent}%`}
    >
      <span className="font-mono">{percent}%</span>
    </span>
  );
}

/** Turn a snake_case field name into a readable label ("procedure_code" → "Procedure code"). */
function humanizeFieldName(name: string): string {
  const spaced = name.replace(/[_-]+/g, " ").trim();
  if (spaced.length === 0) return name;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function CaseFactsPanel({ fields }: CaseFactsPanelProps) {
  return (
    <section
      aria-label="Case facts"
      className="flex flex-col rounded-lg border border-border bg-card"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <ListChecks className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">Case facts</h2>
        <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
          {fields.length}
        </span>
      </header>

      {fields.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          No extracted fields yet. Facts will appear as the agent investigates.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {fields.map((field) => {
            const isUnknown =
              field.value.trim().toLowerCase() === "unknown" ||
              field.value.trim().length === 0;
            return (
              <li key={field.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {humanizeFieldName(field.fieldName)}
                    </p>
                    <p
                      className={cn(
                        "mt-0.5 break-words text-sm font-medium",
                        isUnknown
                          ? "italic text-muted-foreground"
                          : "text-foreground",
                      )}
                    >
                      {isUnknown ? "Unknown" : field.value}
                    </p>
                  </div>
                  <ConfidenceChip confidence={field.confidence} />
                </div>
                <SourceTag
                  sourceType={field.sourceType}
                  reasoning={field.reasoning}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
