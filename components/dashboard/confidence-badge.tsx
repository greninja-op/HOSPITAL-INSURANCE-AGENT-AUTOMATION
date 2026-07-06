// =============================================================================
// components/dashboard/confidence-badge.tsx
//
// Overall Confidence_Score badge for a Dashboard Case card (Requirement 10.2).
//
// Renders the Case's `overallConfidence` (a 0..1 fraction) as a whole-percent
// badge, colour-coded by band (high ≥ 0.8, medium ≥ 0.5, low otherwise). When
// no confidence has been computed yet the badge reads "—" in a neutral tone.
// =============================================================================

import { cn } from "@/lib/utils";

interface ConfidenceBadgeProps {
  /** Overall confidence as a 0..1 fraction, or null when not yet computed. */
  confidence: number | null;
  className?: string;
}

/** Clamp a confidence fraction to 0..1 and convert to a whole percent. */
function toPercent(confidence: number): number {
  const clamped = Math.min(1, Math.max(0, confidence));
  return Math.round(clamped * 100);
}

export function ConfidenceBadge({ confidence, className }: ConfidenceBadgeProps) {
  if (confidence === null || Number.isNaN(confidence)) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground",
          className,
        )}
        title="Confidence not yet computed"
      >
        <span className="font-mono">—</span>
      </span>
    );
  }

  const percent = toPercent(confidence);
  const band =
    percent >= 80
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : percent >= 50
        ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "border-destructive/30 bg-destructive/10 text-destructive";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        band,
        className,
      )}
      title={`Overall confidence ${percent}%`}
    >
      <span className="font-mono">{percent}%</span>
    </span>
  );
}
