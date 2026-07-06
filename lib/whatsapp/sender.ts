/**
 * WhatsApp outbound sender (Meta Cloud API / Graph).
 *
 * Sends text, pre-approved patient templates, and interactive reply buttons via
 *   POST {graphBase}/{version}/{phoneNumberId}/messages
 * with a Bearer token and an 8-second per-call timeout.
 *
 * Enforces the 24-hour customer-service window: once the window is closed, Meta
 * rejects free-form text with a known error code, so `sendWithWindowFallback`
 * makes EXACTLY ONE re-attempt using an approved template and then stops — never
 * an automatic resend loop (Requirements 33.5, 33.6 / Property 72).
 *
 * SAFETY BOUNDARY (AuthPilot): all patient-facing messages are generic, PHI-free
 * templates that carry no case specifics — the detail lives in the app/PDF only
 * (Requirement 33.3, 33.4).
 *
 * Self-contained: no dependency on the multilingual `lib/i18n` layer (which lives
 * in the separate whatsapp-integration package). Every method returns a structured
 * `SendResult` and never throws.
 */

const SEND_TIMEOUT_MS = 8000;
const MAX_TEXT_BODY_CHARS = 4096;
const MAX_INTERACTIVE_BODY_CHARS = 1024;
const BUTTON_TITLE_LIMIT = 20; // Meta cap for interactive reply button titles
const BUTTON_LIMIT = 3; // Meta cap for interactive reply buttons

/** Meta error codes that mean "the 24-hour session window is closed". */
export const CLOSED_WINDOW_ERROR_CODES = new Set([131047, 131026, 470]);

/**
 * True iff `err` carries a Meta error code that means the 24-hour session window
 * is closed. Accepts either an error-shaped object (`{ code }`), a raw numeric
 * code, or nullish (always false). Pure and total — never throws.
 */
export function isWindowClosed(
  err: { code?: number } | number | null | undefined,
): boolean {
  const code = typeof err === "number" ? err : err?.code;
  return code !== undefined && CLOSED_WINDOW_ERROR_CODES.has(code);
}

/** Minimal WhatsApp send configuration (structurally satisfied by WhatsAppConfig). */
export interface SenderConfig {
  token: string; // WHATSAPP_TOKEN
  phoneNumberId: string; // WHATSAPP_PHONE_NUMBER_ID
  apiVersion?: string; // default v23.0
  graphBase?: string; // default https://graph.facebook.com
}

/** Structured outcome of an outbound send. Never thrown — always returned. */
export interface SendResult {
  ok: boolean;
  messageId?: string;
  errorCode?: number;
  detail?: string;
}

/** An approved, PHI-free patient template reference. */
export interface PatientTemplate {
  /** The Meta-approved template name. */
  name: string;
  /** BCP-47 language code (defaults to "en"). */
  language?: string;
}

/** An interactive reply button. */
export interface Button {
  id: string; // stable id echoed back on tap (e.g. "approve:114")
  title: string; // <= 20 chars per Meta
}

/** The outbound messaging surface produced by `createSender`. */
export interface Sender {
  sendText(to: string, body: string): Promise<SendResult>;
  sendTemplate(
    to: string,
    template: PatientTemplate,
    params?: string[],
  ): Promise<SendResult>;
  sendInteractiveButtons(
    to: string,
    prompt: string,
    buttons: Button[],
  ): Promise<SendResult>;
  sendWithWindowFallback(
    to: string,
    inWindow: () => Promise<SendResult>,
    fallback: PatientTemplate,
  ): Promise<SendResult>;
}

function endpoint(cfg: SenderConfig): string {
  const base = cfg.graphBase ?? "https://graph.facebook.com";
  const version = cfg.apiVersion ?? "v23.0";
  return `${base}/${version}/${cfg.phoneNumberId}/messages`;
}

/**
 * POST a message payload to the Graph messages endpoint under an 8s timeout.
 * Maps any transport/HTTP/Meta failure into a `SendResult` and never throws.
 */
async function post(cfg: SenderConfig, payload: unknown): Promise<SendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint(cfg), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string }>;
      error?: { code?: number; message?: string };
    };
    if (!res.ok || json.error) {
      return {
        ok: false,
        errorCode: json.error?.code,
        detail: json.error?.message ?? `HTTP ${res.status}`,
      };
    }
    return { ok: true, messageId: json.messages?.[0]?.id };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      detail: aborted
        ? `send timed out after ${SEND_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : "send failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Build Meta template body components from positional string params. */
function templateComponents(params?: string[]): unknown[] | undefined {
  if (!params || params.length === 0) return undefined;
  return [
    {
      type: "body",
      parameters: params.map((text) => ({ type: "text", text })),
    },
  ];
}

/**
 * Create an outbound WhatsApp sender bound to a channel configuration.
 * All methods return a `SendResult` and never throw.
 */
export function createSender(cfg: SenderConfig): Sender {
  const sender: Sender = {
    async sendText(to: string, body: string): Promise<SendResult> {
      const trimmed = (body ?? "").slice(0, MAX_TEXT_BODY_CHARS);
      if (trimmed.length === 0) return { ok: false, detail: "empty body" };
      return post(cfg, {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: trimmed },
      });
    },

    async sendTemplate(
      to: string,
      template: PatientTemplate,
      params?: string[],
    ): Promise<SendResult> {
      const components = templateComponents(params);
      return post(cfg, {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: template.name,
          language: { code: template.language ?? "en" },
          ...(components ? { components } : {}),
        },
      });
    },

    async sendInteractiveButtons(
      to: string,
      prompt: string,
      buttons: Button[],
    ): Promise<SendResult> {
      const capped = buttons.slice(0, BUTTON_LIMIT);
      return post(cfg, {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: prompt.slice(0, MAX_INTERACTIVE_BODY_CHARS) },
          action: {
            buttons: capped.map((b) => ({
              type: "reply",
              reply: { id: b.id, title: b.title.slice(0, BUTTON_TITLE_LIMIT) },
            })),
          },
        },
      });
    },

    /**
     * Try the in-window delivery path; if it fails because the 24-hour session
     * window is closed, re-attempt EXACTLY ONCE with an approved template and
     * then stop. A successful in-window attempt makes no fallback attempt, and a
     * non-window failure is returned as-is — never an automatic resend loop
     * (Requirements 33.5, 33.6 / Property 72).
     */
    async sendWithWindowFallback(
      to: string,
      inWindow: () => Promise<SendResult>,
      fallback: PatientTemplate,
    ): Promise<SendResult> {
      const first = await inWindow();
      if (first.ok || !isWindowClosed(first.errorCode)) return first;
      // Window is closed: exactly one template re-attempt, then stop.
      return sender.sendTemplate(to, fallback);
    },
  };

  return sender;
}
