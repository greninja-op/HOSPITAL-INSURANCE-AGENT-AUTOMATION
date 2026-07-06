"use client";

// =============================================================================
// components/case/human-action-zone.tsx
//
// Human action zone for the Case Detail screen (Requirements 8, 13.3, 13.4,
// 15.2, 22.6, 24.1, 7.5).
//
// Shows the current agent recommendation (headline, reasoning, risk, resolution
// path) with its plain-English explanation alongside (Req 13.3, 15.2). When the
// stored Verification_Result status is "fail", every flagged issue is displayed
// beside the recommendation so the reviewer sees why verification failed
// (Req 22.6). When an Appeal_Packet exists, an inline preview and a download
// control are offered (Req 7.5, 13.4).
//
// Action controls are status-driven:
//   • AwaitingApproval → Approve / Edit / Request More Evidence / Reject (Req 8.1)
//   • AppealSent       → Appeal Won / Appeal Denied (Req 24.1) — shown ONLY here.
//
// Every action POSTs to /api/cases/[id]/action with a client-generated
// Idempotency-Key header, matching the documented action-route contract; the
// route delegates to the shared performCaseAction operation. On success the
// parent is asked to refetch the Case so the UI reflects the new status.
// =============================================================================

import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  FileText,
  Loader2,
  Lightbulb,
  Pencil,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { CaseActionResult } from "@/lib/types";
import type { CaseDetail } from "@/app/api/cases/[id]/route";

/**
 * Action types accepted by the /action route: the four Human_Action types plus
 * the two Case_Outcome types for AppealSent cases (Req 8, 24).
 */
type ActionType =
  | "approve"
  | "reject"
  | "edit"
  | "request_more_evidence"
  | "appeal_won"
  | "appeal_denied";

/** The request body POSTed to /api/cases/[id]/action. */
interface ActionRequestBody {
  action: ActionType;
  reason?: string;
  editedRecommendation?: unknown;
  additionalEvidence?: string;
}

interface HumanActionZoneProps {
  detail: CaseDetail;
  /** Ask the parent to refetch the Case after a successful action. */
  onActionComplete: () => void;
}

/** A best-effort client Idempotency-Key for the mutation (Req 26, 40.10). */
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The extra input an action needs before it can be submitted, if any. */
type PendingForm =
  | { kind: "edit" }
  | { kind: "reject" }
  | { kind: "request_more_evidence" }
  | null;

export function HumanActionZone({
  detail,
  onActionComplete,
}: HumanActionZoneProps) {
  const [submitting, setSubmitting] = useState<ActionType | null>(null);
  const [pending, setPending] = useState<PendingForm>(null);
  const [formValue, setFormValue] = useState("");
  const [message, setMessage] = useState<
    { tone: "ok" | "error"; text: string } | null
  >(null);

  const verificationFailed = detail.verificationResult?.status === "fail";
  const flaggedIssues = detail.verificationResult?.flaggedIssues ?? [];

  async function submit(action: ActionType, body?: Partial<ActionRequestBody>) {
    if (submitting) return;
    setSubmitting(action);
    setMessage(null);

    const payload: ActionRequestBody = { action, ...body };
    try {
      const res = await fetch(`/api/cases/${detail.id}/action`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": newIdempotencyKey(),
        },
        body: JSON.stringify(payload),
      });

      let result: CaseActionResult | null = null;
      try {
        result = (await res.json()) as CaseActionResult;
      } catch {
        result = null;
      }

      if (!res.ok || !result || result.success === false) {
        setMessage({
          tone: "error",
          text:
            result?.message ??
            `The action could not be completed (${res.status}).`,
        });
        return;
      }

      setMessage({ tone: "ok", text: result.message || "Action recorded." });
      setPending(null);
      setFormValue("");
      onActionComplete();
    } catch {
      setMessage({
        tone: "error",
        text: "Could not reach the server. Check your connection and try again.",
      });
    } finally {
      setSubmitting(null);
    }
  }

  /** Submit the currently open input-collecting form. */
  function submitPending() {
    if (!pending) return;
    const trimmed = formValue.trim();
    if (pending.kind === "edit") {
      // Store the revised recommendation content on the Case (Req 8.4).
      const edited = { ...(detail.recommendation ?? {}), headline: trimmed };
      void submit("edit", { editedRecommendation: edited });
    } else if (pending.kind === "reject") {
      void submit("reject", { reason: trimmed || undefined });
    } else {
      // request_more_evidence (Req 8.5)
      void submit("request_more_evidence", { additionalEvidence: trimmed });
    }
  }

  return (
    <section
      aria-label="Human action zone"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4"
    >
      <h2 className="text-sm font-semibold text-foreground">Action zone</h2>

      {/* Recommendation + plain-English explanation (Req 13.3, 15.2) --------- */}
      <RecommendationCard detail={detail} />

      {/* Flagged issues when verification failed (Req 22.6) ------------------ */}
      {verificationFailed ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
          <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            Verification failed — {flaggedIssues.length} flagged issue
            {flaggedIssues.length === 1 ? "" : "s"}
          </p>
          <ul className="mt-2 space-y-2">
            {flaggedIssues.map((issue, i) => (
              <li
                key={`${issue.type}-${i}`}
                className="rounded border border-destructive/30 bg-background/60 px-2.5 py-1.5 text-xs"
              >
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-destructive/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-destructive">
                    {issue.type}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      issue.severity === "blocking"
                        ? "bg-destructive/20 text-destructive"
                        : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {issue.severity}
                  </span>
                </div>
                <p className="mt-1 font-medium text-foreground">
                  {issue.reference}
                </p>
                <p className="mt-0.5 text-muted-foreground">{issue.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Appeal packet preview + download (Req 7.5, 13.4) -------------------- */}
      {detail.appealPdfUrl ? (
        <AppealPreview url={detail.appealPdfUrl} />
      ) : null}

      {/* Action / outcome feedback ------------------------------------------- */}
      {message ? (
        <div
          role="status"
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            message.tone === "ok"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-destructive/40 bg-destructive/10 text-destructive",
          )}
        >
          {message.text}
        </div>
      ) : null}

      {/* Status-driven controls ---------------------------------------------- */}
      {detail.status === "AwaitingApproval" ? (
        <ApprovalControls
          submitting={submitting}
          pending={pending}
          formValue={formValue}
          onFormValueChange={setFormValue}
          onApprove={() => void submit("approve")}
          onOpenForm={(kind) => {
            setMessage(null);
            setFormValue("");
            setPending({ kind });
          }}
          onCancelForm={() => {
            setPending(null);
            setFormValue("");
          }}
          onSubmitForm={submitPending}
        />
      ) : detail.status === "AppealSent" ? (
        <OutcomeControls
          submitting={submitting}
          onWon={() => void submit("appeal_won")}
          onDenied={() => void submit("appeal_denied")}
        />
      ) : (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          No action is available while this case is {readableStatus(detail.status)}.
        </p>
      )}
    </section>
  );
}

/** The recommendation card with the plain-English explanation alongside it. */
function RecommendationCard({ detail }: { detail: CaseDetail }) {
  const rec = detail.recommendation;

  if (!rec) {
    return (
      <div className="rounded-md border border-border bg-muted/40 px-3 py-4 text-sm text-muted-foreground">
        No recommendation yet — the agent is still working this case.
      </div>
    );
  }

  const riskTone =
    rec.risk === "High"
      ? "bg-destructive/15 text-destructive"
      : rec.risk === "Medium"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold text-foreground">{rec.headline}</p>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            riskTone,
          )}
        >
          {rec.risk} risk
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{rec.reason}</p>

      <p className="mt-2 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        Path: {rec.resolutionPath}
      </p>

      {rec.requestedEvidence && rec.requestedEvidence.length > 0 ? (
        <div className="mt-2">
          <p className="text-xs font-medium text-foreground">
            Requested evidence
          </p>
          <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
            {rec.requestedEvidence.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Plain-English explanation alongside the recommendation (Req 15.2). */}
      {detail.plainEnglishExplanation ? (
        <div className="mt-3 rounded-md border border-border bg-muted/40 p-2.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Lightbulb className="h-3.5 w-3.5 text-amber-500" aria-hidden />
            In plain English
          </p>
          <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
            {detail.plainEnglishExplanation}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Inline Appeal_Packet preview + download control (Req 7.5, 13.4). */
function AppealPreview({ url }: { url: string }) {
  return (
    <div className="rounded-md border border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium text-foreground">
          Appeal packet
        </span>
        <a
          href={url}
          download
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          Download
        </a>
      </div>
      <object
        data={url}
        type="application/pdf"
        aria-label="Appeal packet preview"
        className="h-80 w-full"
      >
        <p className="p-3 text-xs text-muted-foreground">
          Preview unavailable.{" "}
          <a href={url} download className="underline">
            Download the appeal packet
          </a>{" "}
          instead.
        </p>
      </object>
    </div>
  );
}

interface ApprovalControlsProps {
  submitting: ActionType | null;
  pending: PendingForm;
  formValue: string;
  onFormValueChange: (v: string) => void;
  onApprove: () => void;
  onOpenForm: (kind: "edit" | "reject" | "request_more_evidence") => void;
  onCancelForm: () => void;
  onSubmitForm: () => void;
}

/** Approve / Edit / Request More Evidence / Reject controls (Req 8.1). */
function ApprovalControls({
  submitting,
  pending,
  formValue,
  onFormValueChange,
  onApprove,
  onOpenForm,
  onCancelForm,
  onSubmitForm,
}: ApprovalControlsProps) {
  const busy = submitting !== null;

  if (pending) {
    const config = {
      edit: {
        title: "Edit recommendation",
        placeholder: "Revised recommendation headline…",
        cta: "Save edit",
      },
      reject: {
        title: "Reject recommendation",
        placeholder: "Reason for rejection (optional)…",
        cta: "Confirm reject",
      },
      request_more_evidence: {
        title: "Request more evidence",
        placeholder: "Additional information / evidence to add to the case…",
        cta: "Submit & re-run",
      },
    }[pending.kind];

    return (
      <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
        <p className="text-sm font-medium text-foreground">{config.title}</p>
        <textarea
          value={formValue}
          onChange={(e) => onFormValueChange(e.target.value)}
          rows={3}
          placeholder={config.placeholder}
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSubmitForm}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : null}
            {config.cta}
          </button>
          <button
            type="button"
            onClick={onCancelForm}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
          >
            <X className="h-4 w-4" aria-hidden />
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      <button
        type="button"
        onClick={onApprove}
        disabled={busy}
        className="inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-600/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting === "approve" ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <ThumbsUp className="h-4 w-4" aria-hidden />
        )}
        Approve
      </button>
      <button
        type="button"
        onClick={() => onOpenForm("edit")}
        disabled={busy}
        className="inline-flex items-center justify-center gap-1.5 rounded-md border border-input px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
      >
        <Pencil className="h-4 w-4" aria-hidden />
        Edit
      </button>
      <button
        type="button"
        onClick={() => onOpenForm("request_more_evidence")}
        disabled={busy}
        className="inline-flex items-center justify-center gap-1.5 rounded-md border border-input px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
      >
        <FileText className="h-4 w-4" aria-hidden />
        Request evidence
      </button>
      <button
        type="button"
        onClick={() => onOpenForm("reject")}
        disabled={busy}
        className="inline-flex items-center justify-center gap-1.5 rounded-md border border-destructive/50 px-3 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-60"
      >
        <ThumbsDown className="h-4 w-4" aria-hidden />
        Reject
      </button>
    </div>
  );
}

interface OutcomeControlsProps {
  submitting: ActionType | null;
  onWon: () => void;
  onDenied: () => void;
}

/** Appeal Won / Appeal Denied controls — shown only for AppealSent (Req 24.1). */
function OutcomeControls({ submitting, onWon, onDenied }: OutcomeControlsProps) {
  const busy = submitting !== null;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Record the payer&apos;s decision on the submitted appeal.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onWon}
          disabled={busy}
          className="inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-600/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting === "appeal_won" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Check className="h-4 w-4" aria-hidden />
          )}
          Appeal Won
        </button>
        <button
          type="button"
          onClick={onDenied}
          disabled={busy}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-destructive/50 px-3 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting === "appeal_denied" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <X className="h-4 w-4" aria-hidden />
          )}
          Appeal Denied
        </button>
      </div>
    </div>
  );
}

/** Turn a CaseStatus into a lowercase readable phrase for the idle message. */
function readableStatus(status: string): string {
  return status.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}
