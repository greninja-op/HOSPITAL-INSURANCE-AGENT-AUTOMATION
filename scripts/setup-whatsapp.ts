// =============================================================================
// scripts/setup-whatsapp.ts
//
// One-off, IDEMPOTENT WhatsApp channel setup for AuthPilot (Meta Cloud / Graph).
//
// This is an OPS script, not part of the runtime request path. Run it once after
// the WhatsApp number is provisioned and the four WHATSAPP_* keys are set:
//
//     npx tsx scripts/setup-whatsapp.ts            # perform idempotent setup
//     npx tsx scripts/setup-whatsapp.ts --show     # print current state, change nothing
//     npx tsx scripts/setup-whatsapp.ts --dry-run  # show what WOULD change, change nothing
//
// What it does (all steps are safe to re-run):
//   1. Registers the pre-approved, generic, PHI-free patient message templates
//      required by Requirement 33.1 (case created, needs-more-info, appeal filed,
//      resolved) plus the status / no-open-case replies the router uses. Existing
//      templates are detected by name and skipped — never re-created.
//   2. Subscribes the app to the WhatsApp Business Account (WABA) webhook events
//      so inbound messages reach /api/whatsapp/webhook. Subscribing twice is a
//      no-op on Meta's side.
//   3. Configures the conversational-automation welcome prompts / commands on the
//      phone number (idempotent overwrite).
//   4. Prints a checklist of what was done and what still needs a manual dashboard
//      step (webhook callback URL + verify token live in the Meta App dashboard).
//
// Configuration is read through the app's validated loader (lib/config.ts). The
// four WHATSAPP_* keys are an all-or-nothing group there; this script fails fast
// with a clear message when the channel is not configured.
//
// The WhatsApp Business Account id (WABA id) is NOT one of the four channel keys,
// so it is read from WHATSAPP_BUSINESS_ACCOUNT_ID (alias: WHATSAPP_WABA_ID). It is
// required for template registration and webhook subscription; when it is absent
// those steps are skipped and reported as remaining manual steps.
// =============================================================================

import { getConfig, whatsappEnabled, type WhatsAppConfig } from "@/lib/config";

// ─── Tunables (env-overridable, with sane Graph API defaults) ────────────────
const API_VERSION = process.env.WHATSAPP_API_VERSION ?? "v23.0";
const GRAPH_BASE = process.env.WHATSAPP_GRAPH_BASE ?? "https://graph.facebook.com";
const TEMPLATE_LANGUAGE = process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "en_US";
const REQUEST_TIMEOUT_MS = 15_000;

/** WABA id used for template registration + webhook subscription (optional key). */
const WABA_ID =
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? process.env.WHATSAPP_WABA_ID ?? "";

/** Public callback URL for the webhook — dashboard-only, printed in the checklist. */
const WEBHOOK_CALLBACK_URL = process.env.WHATSAPP_WEBHOOK_CALLBACK_URL ?? "";

// ─── The generic, PHI-free patient templates (Requirement 33.1–33.4) ─────────
//
// Bodies mirror lib/whatsapp/router.ts `PATIENT_TEMPLATES` (the runtime source of
// truth). Every template is generic and carries no case specifics or PHI; the
// needs-more-info body deliberately never names the missing item (Req 33.2).
interface TemplateDef {
  /** Meta template name — lowercase + underscores. */
  name: string;
  /** Meta template category. These are transactional utility notifications. */
  category: "UTILITY";
  /** The generic, PHI-free body text. */
  body: string;
}

const PATIENT_TEMPLATES: TemplateDef[] = [
  {
    name: "authpilot_case_created",
    category: "UTILITY",
    body:
      "We've received your message about your insurance issue and started reviewing it. We'll update you here as soon as we have next steps.",
  },
  {
    name: "authpilot_needs_more_info",
    category: "UTILITY",
    body:
      "Thanks — to keep moving forward we need a little more information about your case. Someone from our office will reach out shortly to help.",
  },
  {
    name: "authpilot_appeal_filed",
    category: "UTILITY",
    body:
      "Good news — we've filed the next step on your insurance case. We'll let you know here when there's another update.",
  },
  {
    name: "authpilot_resolved",
    category: "UTILITY",
    body:
      "There's a resolution on your insurance case. Please check your patient portal or call our office for the details.",
  },
  {
    name: "authpilot_status_generic",
    category: "UTILITY",
    body:
      "Your case is being worked on and there's activity on it. For the specifics, please check your patient portal or call our office.",
  },
  {
    name: "authpilot_no_open_case",
    category: "UTILITY",
    body:
      "We don't have an open case for this number right now. If you have a new insurance issue, just describe it here and we'll start one.",
  },
];

// ─── Conversational automation (welcome prompts + staff commands) ────────────
const WELCOME_PROMPTS = [
  "Check my authorization status",
  "My insurance denied a procedure",
  "Upload a denial letter",
  "Talk to my care team",
];

const COMMANDS = [
  { command_name: "status", command_description: "Get an update on your case" },
  { command_name: "help", command_description: "See what I can do" },
];

// ─── Small Graph API client (fetch + timeout, never throws on HTTP errors) ───
interface GraphResult<T = unknown> {
  ok: boolean;
  status: number;
  json: T;
  error?: { code?: number; message?: string };
}

async function graph<T = unknown>(
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: unknown,
): Promise<GraphResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${GRAPH_BASE}/${API_VERSION}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as T & {
      error?: { code?: number; message?: string };
    };
    return {
      ok: res.ok && !json.error,
      status: res.status,
      json,
      error: json.error,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: 0,
      json: {} as T,
      error: {
        message: aborted
          ? `request timed out after ${REQUEST_TIMEOUT_MS}ms`
          : err instanceof Error
            ? err.message
            : "request failed",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Checklist accumulation ──────────────────────────────────────────────────
type Mark = "done" | "skip" | "fail" | "todo";
interface ChecklistItem {
  mark: Mark;
  text: string;
}
const checklist: ChecklistItem[] = [];
const record = (mark: Mark, text: string) => checklist.push({ mark, text });

const MARK_ICON: Record<Mark, string> = {
  done: "✓",
  skip: "•",
  fail: "✗",
  todo: "▢",
};

// ─── Step 1: patient message templates (Requirement 33.1) ────────────────────
interface ExistingTemplate {
  name: string;
  status?: string;
  language?: string;
}

async function fetchExistingTemplates(
  token: string,
): Promise<Map<string, ExistingTemplate> | null> {
  const result = await graph<{ data?: ExistingTemplate[] }>(
    "GET",
    `${WABA_ID}/message_templates?fields=name,status,language&limit=250`,
    token,
  );
  if (!result.ok) {
    record(
      "fail",
      `Could not list existing templates: ${result.error?.message ?? `HTTP ${result.status}`}`,
    );
    return null;
  }
  const map = new Map<string, ExistingTemplate>();
  for (const t of result.json.data ?? []) map.set(t.name, t);
  return map;
}

async function registerTemplates(
  token: string,
  dryRun: boolean,
): Promise<void> {
  if (!WABA_ID) {
    record(
      "todo",
      "Register patient templates — set WHATSAPP_BUSINESS_ACCOUNT_ID and re-run (Req 33.1).",
    );
    return;
  }

  const existing = await fetchExistingTemplates(token);
  if (existing === null) return; // failure already recorded

  for (const tpl of PATIENT_TEMPLATES) {
    const found = existing.get(tpl.name);
    if (found) {
      record(
        "skip",
        `Template "${tpl.name}" already exists (status: ${found.status ?? "unknown"}).`,
      );
      continue;
    }
    if (dryRun) {
      record("todo", `Would create template "${tpl.name}" (${tpl.category}).`);
      continue;
    }
    const result = await graph(
      "POST",
      `${WABA_ID}/message_templates`,
      token,
      {
        name: tpl.name,
        category: tpl.category,
        language: TEMPLATE_LANGUAGE,
        components: [{ type: "BODY", text: tpl.body }],
      },
    );
    if (result.ok) {
      record("done", `Created template "${tpl.name}" (submitted for approval).`);
    } else {
      record(
        "fail",
        `Failed to create template "${tpl.name}": ${result.error?.message ?? `HTTP ${result.status}`}`,
      );
    }
  }
}

// ─── Step 2: subscribe the app to the WABA webhook ───────────────────────────
async function subscribeWebhook(token: string, dryRun: boolean): Promise<void> {
  if (!WABA_ID) {
    record(
      "todo",
      "Subscribe app to WABA webhook — set WHATSAPP_BUSINESS_ACCOUNT_ID and re-run.",
    );
    return;
  }

  // GET is idempotent and tells us the current subscription state.
  const current = await graph<{ data?: Array<{ whatsapp_business_api_data?: unknown }> }>(
    "GET",
    `${WABA_ID}/subscribed_apps`,
    token,
  );
  const alreadySubscribed = current.ok && (current.json.data?.length ?? 0) > 0;

  if (alreadySubscribed) {
    record("skip", "App already subscribed to WABA webhook events.");
    return;
  }
  if (dryRun) {
    record("todo", "Would subscribe app to WABA webhook events.");
    return;
  }

  const result = await graph<{ success?: boolean }>(
    "POST",
    `${WABA_ID}/subscribed_apps`,
    token,
  );
  if (result.ok) {
    record("done", "Subscribed app to WABA webhook events.");
  } else {
    record(
      "fail",
      `Failed to subscribe app to WABA webhook: ${result.error?.message ?? `HTTP ${result.status}`}`,
    );
  }
}

// ─── Step 3: conversational automation (welcome prompts + commands) ──────────
async function configureConversationalAutomation(
  cfg: WhatsAppConfig,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    record(
      "todo",
      "Would set welcome prompts + staff commands on the phone number.",
    );
    return;
  }
  const result = await graph(
    "POST",
    `${cfg.phoneNumberId}/conversational_automation`,
    cfg.token,
    {
      enable_welcome_message: true,
      prompts: WELCOME_PROMPTS.map((prompt) => ({ prompt })),
      commands: COMMANDS,
    },
  );
  if (result.ok) {
    record("done", "Configured welcome prompts and staff commands.");
  } else {
    record(
      "fail",
      `Failed to configure conversational automation: ${result.error?.message ?? `HTTP ${result.status}`}`,
    );
  }
}

// ─── --show: read-only snapshot of current Meta-side state ───────────────────
async function showState(cfg: WhatsAppConfig): Promise<void> {
  console.log("Current WhatsApp channel state\n");

  const phone = await graph(
    "GET",
    `${cfg.phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating,conversational_automation`,
    cfg.token,
  );
  console.log("Phone number:");
  console.log(JSON.stringify(phone.json, null, 2), "\n");

  if (WABA_ID) {
    const templates = await graph(
      "GET",
      `${WABA_ID}/message_templates?fields=name,status,language,category&limit=250`,
      cfg.token,
    );
    console.log("Message templates:");
    console.log(JSON.stringify(templates.json, null, 2), "\n");

    const apps = await graph("GET", `${WABA_ID}/subscribed_apps`, cfg.token);
    console.log("Subscribed apps:");
    console.log(JSON.stringify(apps.json, null, 2), "\n");
  } else {
    console.log(
      "WHATSAPP_BUSINESS_ACCOUNT_ID not set — skipping templates + subscribed apps.\n",
    );
  }
}

// ─── Checklist printer ───────────────────────────────────────────────────────
function printChecklist(dryRun: boolean): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(dryRun ? "Setup checklist (dry run — nothing changed):" : "Setup checklist:");
  console.log("─".repeat(60));
  for (const item of checklist) {
    console.log(`  ${MARK_ICON[item.mark]} ${item.text}`);
  }

  console.log("\nManual dashboard steps (cannot be done via this script):");
  console.log(
    `  ${MARK_ICON.todo} Set the webhook callback URL in the Meta App dashboard` +
      (WEBHOOK_CALLBACK_URL ? `: ${WEBHOOK_CALLBACK_URL}` : " (your app's /api/whatsapp/webhook)."),
  );
  console.log(
    `  ${MARK_ICON.todo} Set the webhook Verify Token to match WHATSAPP_VERIFY_TOKEN.`,
  );
  console.log(
    `  ${MARK_ICON.todo} Confirm submitted templates reach "APPROVED" before sending.`,
  );

  const failures = checklist.filter((i) => i.mark === "fail").length;
  console.log(`\n${"─".repeat(60)}`);
  if (failures > 0) {
    console.log(`Completed with ${failures} failure(s) — review the ✗ items above.`);
  } else {
    console.log("Done. Re-running this script is safe (idempotent).");
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const show = args.has("--show");
  const dryRun = args.has("--dry-run");

  // Load + validate config (fails fast on a partial WHATSAPP_* group).
  const cfg = getConfig();
  if (!whatsappEnabled(cfg) || !cfg.whatsapp) {
    throw new Error(
      "WhatsApp channel is not configured. Set all four keys before running:\n" +
        "  - WHATSAPP_VERIFY_TOKEN\n" +
        "  - WHATSAPP_APP_SECRET\n" +
        "  - WHATSAPP_TOKEN\n" +
        "  - WHATSAPP_PHONE_NUMBER_ID",
    );
  }
  const wa = cfg.whatsapp;

  console.log(
    `AuthPilot WhatsApp setup (${API_VERSION}) — phone ${wa.phoneNumberId}` +
      (WABA_ID ? `, WABA ${WABA_ID}` : ", WABA <not set>"),
  );

  if (show) {
    await showState(wa);
    return;
  }

  await registerTemplates(wa.token, dryRun);
  await subscribeWebhook(wa.token, dryRun);
  await configureConversationalAutomation(wa, dryRun);

  printChecklist(dryRun);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
