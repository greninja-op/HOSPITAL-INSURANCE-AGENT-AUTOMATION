// =============================================================================
// instrumentation.ts
//
// Boot-time configuration validation (Requirement 38).
//
// Next.js calls `register()` once when the server process starts. We invoke the
// fail-fast, Zod-validated loader (`lib/config.ts`) here so a misconfigured
// environment aborts startup immediately with a single message naming every
// offending key, rather than booting into a broken state (Req 38.1, 38.2).
//
// Only the PRESENCE summary is logged (`redactedSummary`) — never a secret value
// (Req 38.4). Enabling the hook requires `experimental.instrumentationHook` in
// next.config.js (Next.js 14).
// =============================================================================

export async function register(): Promise<void> {
  // Only run on the Node.js server runtime — skip the Edge runtime, where the
  // full process environment and config contract do not apply.
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { getConfig, redactedSummary } = await import("./lib/config");

  try {
    const cfg = getConfig();
    // Presence-only summary — safe for boot logs (no secret values).
    console.log(
      "[AuthPilot] App_Configuration validated at boot:",
      JSON.stringify(redactedSummary(cfg)),
    );
  } catch (err) {
    // Fail fast: surface the message naming every offending key and abort start.
    console.error(
      "[AuthPilot] Startup aborted — invalid App_Configuration:\n" +
        (err instanceof Error ? err.message : String(err)),
    );
    throw err;
  }
}
