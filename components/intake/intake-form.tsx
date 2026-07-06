"use client";

// =============================================================================
// components/intake/intake-form.tsx
//
// IntakeForm (Requirement 1): the control an Operator uses to start a Case.
//
//   • a textarea for the raw intake text,
//   • an intake-type selector ("denial_letter" | "new_pa_request" | "phone_note"),
//   • an optional PDF file upload, and
//   • an "Urgent" toggle that DEFAULTS TO OFF (Requirement 1.7).
//
// On submit it POSTs to `/api/cases` — multipart/form-data when a PDF is
// attached, JSON otherwise — and, on success, redirects the Operator to the
// Case Detail page for the returned caseId (Requirement 1.6).
//
// Field-level validation mirrors the create-Case API: an intake with empty
// text and no file is rejected with a missing-content message (Requirement
// 1.3), and an intake with no selected type is rejected with a missing-type
// message (Requirement 1.4). Client-side checks give immediate feedback; any
// field-identifying 400 the API returns is surfaced on the matching field too.
// =============================================================================

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  FileText,
  Loader2,
  Paperclip,
  Send,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { IntakeType } from "@/lib/types";

/** The three intake types an Operator can start a Case from on this page. */
const INTAKE_TYPE_OPTIONS: ReadonlyArray<{
  value: Extract<IntakeType, "denial_letter" | "new_pa_request" | "phone_note">;
  label: string;
  hint: string;
}> = [
  {
    value: "denial_letter",
    label: "Denial letter",
    hint: "A payer's denial of a claim or prior authorization.",
  },
  {
    value: "new_pa_request",
    label: "New prior-auth request",
    hint: "A referral or new prior-authorization request.",
  },
  {
    value: "phone_note",
    label: "Patient phone note",
    hint: "Notes or a transcript from a patient call.",
  },
];

/** Shape of the successful create-Case response. Tolerates `caseId` or `id`. */
interface CreateCaseResponse {
  caseId?: string;
  id?: string;
}

/** Field-identifying 400 body the API returns for invalid intake. */
interface ValidationErrorResponse {
  error?: string;
  field?: "text" | "intakeType" | string;
  message?: string;
}

type FieldErrors = {
  content?: string;
  intakeType?: string;
  form?: string;
};

export function IntakeForm() {
  const router = useRouter();

  const [text, setText] = useState("");
  const [intakeType, setIntakeType] = useState<"" | (typeof INTAKE_TYPE_OPTIONS)[number]["value"]>(
    "",
  );
  const [file, setFile] = useState<File | null>(null);
  const [urgent, setUrgent] = useState(false); // Req 1.7 — defaults to not urgent
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Mirrors the API's intake validation (Requirements 1.3, 1.4). */
  function validate(): FieldErrors {
    const next: FieldErrors = {};
    if (text.trim().length === 0 && !file) {
      next.content = "Enter intake text or attach a PDF denial letter.";
    }
    if (intakeType === "") {
      next.intakeType = "Select an intake type.";
    }
    return next;
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    // Attaching a file can satisfy the content requirement — clear that error.
    if (selected) setErrors((prev) => ({ ...prev, content: undefined }));
  }

  function clearFile() {
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    const validation = validate();
    if (validation.content || validation.intakeType) {
      setErrors(validation);
      return;
    }
    setErrors({});
    setSubmitting(true);

    try {
      // Multipart when a file is attached (so the PDF bytes go up), JSON
      // otherwise. Both carry text, intakeType, and the urgent flag.
      let response: Response;
      if (file) {
        const body = new FormData();
        body.set("text", text);
        body.set("intakeType", intakeType);
        body.set("urgent", String(urgent));
        body.set("file", file);
        response = await fetch("/api/cases", { method: "POST", body });
      } else {
        response = await fetch("/api/cases", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, intakeType, urgent }),
        });
      }

      if (!response.ok) {
        await handleErrorResponse(response);
        return;
      }

      const data = (await response.json()) as CreateCaseResponse;
      const caseId = data.caseId ?? data.id;
      if (!caseId) {
        setErrors({ form: "The case was created but no identifier was returned." });
        return;
      }

      // Req 1.6 — redirect to the Case Detail page for the new Case.
      router.push(`/case/${caseId}`);
    } catch {
      setErrors({ form: "Could not reach the server. Check your connection and try again." });
      setSubmitting(false);
    }
  }

  /** Map a field-identifying 400 back onto the matching field (Req 1.3, 1.4). */
  async function handleErrorResponse(response: Response) {
    let payload: ValidationErrorResponse | null = null;
    try {
      payload = (await response.json()) as ValidationErrorResponse;
    } catch {
      payload = null;
    }

    const detail = payload?.message ?? payload?.error;
    if (payload?.field === "text") {
      setErrors({ content: detail ?? "Enter intake text or attach a PDF denial letter." });
    } else if (payload?.field === "intakeType") {
      setErrors({ intakeType: detail ?? "Select an intake type." });
    } else {
      setErrors({ form: detail ?? "The intake could not be submitted. Please review and retry." });
    }
    setSubmitting(false);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {/* Intake text ---------------------------------------------------------- */}
      <div className="space-y-2">
        <label htmlFor="intake-text" className="block text-sm font-medium">
          Intake text
        </label>
        <textarea
          id="intake-text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value.trim().length > 0) {
              setErrors((prev) => ({ ...prev, content: undefined }));
            }
          }}
          rows={10}
          placeholder="Paste the denial letter, referral, or patient phone note here…"
          aria-invalid={errors.content ? true : undefined}
          aria-describedby={errors.content ? "intake-text-error" : undefined}
          className={cn(
            "w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            errors.content ? "border-destructive" : "border-input",
          )}
        />
        {errors.content ? (
          <FieldError id="intake-text-error">{errors.content}</FieldError>
        ) : null}
      </div>

      {/* PDF upload ----------------------------------------------------------- */}
      <div className="space-y-2">
        <span className="block text-sm font-medium">Attach PDF (optional)</span>
        <input
          ref={fileInputRef}
          id="intake-file"
          type="file"
          accept="application/pdf,.pdf"
          onChange={onFileChange}
          className="sr-only"
        />
        {file ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-input bg-muted/40 px-3 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{file.name}</span>
            </span>
            <button
              type="button"
              onClick={clearFile}
              aria-label="Remove attached file"
              className="rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ) : (
          <label
            htmlFor="intake-file"
            className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Paperclip className="h-4 w-4" aria-hidden />
            Choose PDF
          </label>
        )}
        <p className="text-xs text-muted-foreground">
          Upload a PDF denial letter to have its text extracted automatically.
        </p>
      </div>

      {/* Intake type ---------------------------------------------------------- */}
      <div className="space-y-2">
        <label htmlFor="intake-type" className="block text-sm font-medium">
          Intake type
        </label>
        <select
          id="intake-type"
          value={intakeType}
          onChange={(e) => {
            setIntakeType(e.target.value as typeof intakeType);
            if (e.target.value) setErrors((prev) => ({ ...prev, intakeType: undefined }));
          }}
          aria-invalid={errors.intakeType ? true : undefined}
          aria-describedby={errors.intakeType ? "intake-type-error" : undefined}
          className={cn(
            "h-10 w-full rounded-md border bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            errors.intakeType ? "border-destructive" : "border-input",
          )}
        >
          <option value="" disabled>
            Select an intake type…
          </option>
          {INTAKE_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {errors.intakeType ? (
          <FieldError id="intake-type-error">{errors.intakeType}</FieldError>
        ) : (
          <p className="text-xs text-muted-foreground">
            {INTAKE_TYPE_OPTIONS.find((o) => o.value === intakeType)?.hint ??
              "Choose the kind of trigger you are submitting."}
          </p>
        )}
      </div>

      {/* Urgent toggle (defaults OFF — Req 1.7) ------------------------------- */}
      <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-card px-4 py-3">
        <div className="space-y-0.5">
          <label htmlFor="intake-urgent" className="block text-sm font-medium">
            Urgent
          </label>
          <p className="text-xs text-muted-foreground">
            Sets a 72-hour SLA deadline instead of the standard 7 days.
          </p>
        </div>
        <button
          type="button"
          id="intake-urgent"
          role="switch"
          aria-checked={urgent}
          onClick={() => setUrgent((u) => !u)}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background",
            urgent ? "bg-primary" : "bg-input",
          )}
        >
          <span
            className={cn(
              "inline-block h-5 w-5 transform rounded-full bg-background shadow transition-transform",
              urgent ? "translate-x-5" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      {/* Form-level error ----------------------------------------------------- */}
      {errors.form ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{errors.form}</span>
        </div>
      ) : null}

      {/* Submit --------------------------------------------------------------- */}
      <button
        type="submit"
        disabled={submitting}
        className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Creating case…
          </>
        ) : (
          <>
            <Send className="h-4 w-4" aria-hidden />
            Start case
          </>
        )}
      </button>
    </form>
  );
}

/** Inline field-level error message with an alert role for assistive tech. */
function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
      <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  );
}
