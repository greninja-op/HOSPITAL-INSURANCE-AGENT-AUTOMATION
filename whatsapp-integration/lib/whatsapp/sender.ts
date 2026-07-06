/**
 * WhatsApp outbound sender (Meta Cloud API / Graph).
 *
 * Sends text, pre-approved templates, and interactive buttons via
 *   POST {graphBase}/{version}/{phoneNumberId}/messages
 * with a Bearer token. Enforces the 24-hour customer-service window: once the window
 * is closed, free-form text is rejected by Meta with a known error code, so we make
 * EXACTLY ONE re-attempt with an approved template (never an auto-loop of resends).
 *
 * SAFETY BOUNDARY (AuthPilot): all patient-facing messages are generic, pre-approved
 * templates that carry NO PHI/case specifics — the detail lives in the app/PDF only.
 */
import { MAX_LIST_ROWS, type ListSpec } from "../i18n/languagePicker";

const SEND_TIMEOUT_MS = 8000;
const MAX_TEXT_BODY_CHARS = 4096;
const BUTTON_LIMIT = 3; // Meta cap for interactive reply buttons

/** Meta error codes that mean "the 24-hour session window is closed". */
export const CLOSED_WINDOW_ERROR_CODES = new Set([131047, 131026, 470]);

export function isWindowClosed(errorCode: number | undefined): boolean {
  return errorCode !== undefined && CLOSED_WINDOW_ERROR_CODES.has(errorCode);
}

export interface SenderConfig {
  token: string; // WHATSAPP_TOKEN
  phoneNumberId: string; // WHATSAPP_PHONE_NUMBER_ID
  apiVersion?: string; // WHATSAPP_API_VERSION (default v23.0)
  graphBase?: string; // default https://graph.facebook.com
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  errorCode?: number;
  detail?: string;
}

export interface ReplyButton {
  id: string; // stable id echoed back on tap (e.g. "approve:114")
  title: string; // <= 20 chars per Meta
}

function endpoint(cfg: SenderConfig): string {
  const base = cfg.graphBase ?? "https://graph.facebook.com";
  const version = cfg.apiVersion ?? "v23.0";
  return `${base}/${version}/${cfg.phoneNumberId}/messages`;
}

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
      return { ok: false, errorCode: json.error?.code, detail: json.error?.message };
    }
    return { ok: true, messageId: json.messages?.[0]?.id };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "send failed" };
  } finally {
    clearTimeout(timer);
  }
}

export function createSender(cfg: SenderConfig) {
  return {
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
      templateName: string,
      languageCode = "en",
      components?: unknown[],
    ): Promise<SendResult> {
      return post(cfg, {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode },
          ...(components ? { components } : {}),
        },
      });
    },

    async sendInteractiveButtons(
      to: string,
      body: string,
      buttons: ReplyButton[],
    ): Promise<SendResult> {
      const capped = buttons.slice(0, BUTTON_LIMIT);
      return post(cfg, {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body.slice(0, 1024) },
          action: {
            buttons: capped.map((b) => ({
              type: "reply",
              reply: { id: b.id, title: b.title.slice(0, 20) },
            })),
          },
        },
      });
    },

    /**
     * Send an interactive LIST (used by the language picker). Meta caps a list at 10 rows total
     * across sections; the caller (language picker) already pages within that cap. Row titles are
     * capped at 24 chars and descriptions at 72 per Meta limits.
     */
    async sendInteractiveList(to: string, list: ListSpec): Promise<SendResult> {
      const sections = list.sections.map((s) => ({
        ...(s.title ? { title: s.title.slice(0, 24) } : {}),
        rows: s.rows.slice(0, MAX_LIST_ROWS).map((r) => ({
          id: r.id,
          title: r.title.slice(0, 24),
          ...(r.description ? { description: r.description.slice(0, 72) } : {}),
        })),
      }));
      return post(cfg, {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: list.body.slice(0, 1024) },
          action: { button: list.buttonLabel.slice(0, 20), sections },
        },
      });
    },

    /**
     * Send free-form text; if the 24-hour window is closed, make exactly ONE
     * re-attempt using the given approved template. No further auto-resend.
     */
    async sendWithWindowFallback(
      to: string,
      body: string,
      fallbackTemplate?: string,
    ): Promise<SendResult> {
      const first = await this.sendText(to, body);
      if (first.ok || !isWindowClosed(first.errorCode)) return first;
      if (!fallbackTemplate) return { ...first, detail: "window closed, no fallback template" };
      return this.sendTemplate(to, fallbackTemplate);
    },
  };
}

export type Sender = ReturnType<typeof createSender>;
