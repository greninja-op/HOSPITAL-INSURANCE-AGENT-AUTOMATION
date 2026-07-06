// =============================================================================
// app/intake/page.tsx
//
// Intake page (Requirement 1). An Operator submits a messy trigger — a denial
// letter, a new prior-auth request, or a patient phone note — to start a Case.
// The page is a thin server-component shell around the client-side `IntakeForm`,
// which handles input, validation, the POST to `/api/cases`, and the redirect
// to the Case Detail page for the returned caseId.
// =============================================================================

import type { Metadata } from "next";
import { IntakeForm } from "@/components/intake/intake-form";

export const metadata: Metadata = {
  title: "New case · AuthPilot",
  description: "Submit a denial letter, prior-auth request, or patient phone note.",
};

export default function IntakePage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-10">
      <header className="mb-8 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">New case</h1>
        <p className="text-sm text-muted-foreground">
          Submit a denial letter, prior-auth request, or patient phone note.
          AuthPilot starts investigating as soon as the case is created.
        </p>
      </header>

      <IntakeForm />
    </div>
  );
}
