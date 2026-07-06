// =============================================================================
// lib/qwen.ts
//
// Qwen_Client — a typed, resilient wrapper around the DashScope / OpenRouter
// OpenAI-compatible chat-completions endpoint (Requirements 6.5–6.9).
//
// Design highlights (see design.md → "Qwen_Client" and "Error Handling → Qwen
// client failures"):
//
//   • `callQwen(messages, tools?)` NEVER throws. It resolves to a structured
//     `QwenOutcome`: `{ ok: true, toolCalls, content }` on success, or a
//     `QwenFailure { ok:false, kind, transient, attempts, detail }` on
//     exhaustion / permanent failure. The Agent_Runner inspects the outcome
//     and degrades the calling stage gracefully (Req 6.9).
//
//   • Each attempt is wrapped in a bounded per-attempt timeout
//     (`QWEN_ATTEMPT_TIMEOUT_MS`, Req 6.6). An elapsed timeout is a `timeout`
//     transient failure.
//
//   • Only TRANSIENT failures (network error, per-attempt timeout, or HTTP
//     429/500/502/503/504) are retried, with exponential backoff, up to a
//     3-attempt total (original + 2, Req 6.5, 6.7). A PERMANENT failure (HTTP
//     4xx other than 429, or a malformed / empty response body) stops
//     immediately with no further retry (Req 6.8).
//
//   • `classifyQwenFailure(err)` is a pure, table-driven classifier mapping an
//     error shape to `{ kind, transient }`; it is used inside `callQwen` and is
//     exported for unit/property tests.
//
// Configuration (`QWEN_API_KEY`, `QWEN_API_BASE`, `QWEN_MODEL`,
// `QWEN_ATTEMPT_TIMEOUT_MS`) is read via `lib/config.ts` (`getConfig`) by the
// default deps. Callers may inject a `deps` object so tests need no network,
// no API key, and no real timers.
// =============================================================================
import { getConfig } from "./config";
import type {
  QwenFailure,
  QwenFailureKind,
  QwenOutcome,
  QwenResponse,
  QwenToolCall,
} from "./types";

// ─── Public request shapes ───────────────────────────────────────────────────

/** A single chat message sent to the model (OpenAI-compatible roles). */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Present on `role: "tool"` replies, linking back to a tool call id. */
  tool_call_id?: string;
  /** Present on assistant messages that requested tool calls (echo-back). */
  name?: string;
}

/** A function-calling tool schema exposed to the model via the `tools` param. */
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

// ─── Injectable dependencies (for testability) ───────────────────────────────

/**
 * The per-attempt HTTP result handed to `callQwen` by the transport. Mirrors the
 * minimal surface of a `fetch` `Response` that we care about.
 */
export interface QwenHttpResult {
  ok: boolean;
  status: number;
  /** Parsed JSON body, or a rejected promise when the body is not valid JSON. */
  json: () => Promise<unknown>;
}

export interface QwenDeps {
  apiKey: string;
  apiBase: string;
  model: string;
  /** Bounded per-attempt timeout in milliseconds (Req 6.6). */
  attemptTimeoutMs: number;
  /**
   * Perform one HTTP attempt. Implementations should honour `signal` so the
   * bounded timeout can abort a hung request. May reject on a transport/network
   * error; such rejections are classified as transient `network` failures.
   */
  fetchImpl: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
  ) => Promise<QwenHttpResult>;
  /** Sleep between retries (injectable so tests need no real timers). */
  sleep: (ms: number) => Promise<void>;
  /** Base backoff in ms; attempt N waits `backoffBaseMs * 2^(N-1)`. */
  backoffBaseMs: number;
}

/** Build the default deps from validated App_Configuration + global fetch. */
function defaultDeps(): QwenDeps {
  const cfg = getConfig();
  return {
    apiKey: cfg.qwenApiKey,
    apiBase: cfg.qwenApiBase,
    model: cfg.qwenModel,
    attemptTimeoutMs: cfg.qwenAttemptTimeoutMs,
    fetchImpl: async (url, init) => {
      const res = await fetch(url, init);
      return {
        ok: res.ok,
        status: res.status,
        json: () => res.json(),
      };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    backoffBaseMs: 250,
  };
}

// ─── Failure classification (pure, table-driven) ─────────────────────────────

/**
 * The shape passed to `classifyQwenFailure`. Exactly one signal is meaningful
 * per call: a `timedOut` timeout, an HTTP `status`, a content problem carried on
 * `body` (`"malformed"` / `"empty"`), or — when none is set — a network error.
 */
export interface QwenErrorShape {
  status?: number;
  timedOut?: boolean;
  /** Content-level marker for a 2xx response we could not use. */
  body?: "malformed" | "empty" | unknown;
}

/** HTTP statuses that are transient and therefore eligible for retry. */
const TRANSIENT_STATUS: Record<number, QwenFailureKind> = {
  429: "http_429",
  500: "http_5xx",
  502: "http_5xx",
  503: "http_5xx",
  504: "http_5xx",
};

const TRANSIENT_KINDS: ReadonlySet<QwenFailureKind> = new Set<QwenFailureKind>([
  "network",
  "timeout",
  "http_429",
  "http_5xx",
]);

/**
 * Pure classifier mapping an error shape to a `{ kind, transient }` pair.
 *
 * Precedence: content markers (malformed/empty) → timeout → HTTP status →
 * network. `transient` is derived from the resolved `kind` via the transient
 * kind set, so the two can never disagree.
 */
export function classifyQwenFailure(err: QwenErrorShape): {
  kind: QwenFailureKind;
  transient: boolean;
} {
  let kind: QwenFailureKind;

  if (err.body === "malformed") {
    kind = "malformed"; // permanent — unparseable response (Req 6.8)
  } else if (err.body === "empty") {
    kind = "empty"; // permanent — no content and no tool calls (Req 6.8)
  } else if (err.timedOut) {
    kind = "timeout"; // transient — per-attempt bound elapsed (Req 6.6)
  } else if (typeof err.status === "number") {
    const mapped = TRANSIENT_STATUS[err.status];
    if (mapped) {
      kind = mapped; // 429 / 500 / 502 / 503 / 504 — transient (Req 6.7)
    } else if (err.status >= 500) {
      // Other 5xx (e.g. 501) are server-side and treated as retryable.
      kind = "http_5xx";
    } else {
      kind = "http_4xx"; // any other 4xx (or non-2xx) — permanent (Req 6.8)
    }
  } else {
    kind = "network"; // transport/connection error — transient (Req 6.7)
  }

  return { kind, transient: TRANSIENT_KINDS.has(kind) };
}

// ─── Response parsing ────────────────────────────────────────────────────────

/**
 * Parse an OpenAI-compatible chat-completions body into a `QwenResponse`.
 * Returns `"malformed"` when the body shape is unusable, or `"empty"` when the
 * model returned neither content nor any tool call.
 */
function parseCompletion(body: unknown): QwenResponse | "malformed" | "empty" {
  if (typeof body !== "object" || body === null) return "malformed";

  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "malformed";

  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return "malformed";

  const rawContent = (message as { content?: unknown }).content;
  const content: string | null =
    typeof rawContent === "string" && rawContent.length > 0 ? rawContent : null;

  const rawToolCalls = (message as { tool_calls?: unknown }).tool_calls;
  const toolCalls: QwenToolCall[] = [];

  if (Array.isArray(rawToolCalls)) {
    for (const tc of rawToolCalls) {
      if (typeof tc !== "object" || tc === null) return "malformed";
      const id = (tc as { id?: unknown }).id;
      const fn = (tc as { function?: unknown }).function;
      if (typeof id !== "string" || typeof fn !== "object" || fn === null) {
        return "malformed";
      }
      const name = (fn as { name?: unknown }).name;
      const argsRaw = (fn as { arguments?: unknown }).arguments;
      if (typeof name !== "string") return "malformed";

      let args: Record<string, unknown> = {};
      if (typeof argsRaw === "string") {
        if (argsRaw.trim() !== "") {
          try {
            const parsed = JSON.parse(argsRaw);
            args =
              typeof parsed === "object" && parsed !== null
                ? (parsed as Record<string, unknown>)
                : {};
          } catch {
            return "malformed"; // tool arguments were not valid JSON
          }
        }
      } else if (typeof argsRaw === "object" && argsRaw !== null) {
        args = argsRaw as Record<string, unknown>;
      }

      toolCalls.push({ id, name, arguments: args });
    }
  }

  if (toolCalls.length === 0 && content === null) return "empty";

  return { toolCalls, content };
}

// ─── One bounded attempt ─────────────────────────────────────────────────────

type AttemptResult =
  | { kind: "success"; response: QwenResponse }
  | { kind: "failure"; error: QwenErrorShape };

async function attemptOnce(
  deps: QwenDeps,
  messages: ChatMessage[],
  tools: ToolSchema[] | undefined,
): Promise<AttemptResult> {
  const url = `${deps.apiBase.replace(/\/+$/, "")}/chat/completions`;
  const payload: Record<string, unknown> = {
    model: deps.model,
    messages,
  };
  if (tools && tools.length > 0) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.attemptTimeoutMs);
  let timedOut = false;
  const onAbort = () => {
    timedOut = true;
  };
  controller.signal.addEventListener("abort", onAbort);

  try {
    const res = await deps.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deps.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { kind: "failure", error: { status: res.status } };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: "failure", error: { body: "malformed" } };
    }

    const parsed = parseCompletion(body);
    if (parsed === "malformed" || parsed === "empty") {
      return { kind: "failure", error: { body: parsed } };
    }
    return { kind: "success", response: parsed };
  } catch {
    // A transport rejection: distinguish an abort (timeout) from a network error.
    return { kind: "failure", error: timedOut ? { timedOut: true } : {} };
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

// ─── Public entry point ──────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3; // original + 2 retries (Req 6.5)

/**
 * Resilient, never-throwing call to the Qwen chat-completions endpoint.
 *
 * Retries ONLY transient failures with exponential backoff up to a 3-attempt
 * total; stops immediately on a permanent failure. Resolves to a `QwenResponse`
 * on success or a structured `QwenFailure` on exhaustion / permanent failure.
 */
export async function callQwen(
  messages: ChatMessage[],
  tools?: ToolSchema[],
  deps: QwenDeps = defaultDeps(),
): Promise<QwenOutcome> {
  let attempts = 0;
  let lastFailure: QwenFailure | null = null;

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;

    const result = await attemptOnce(deps, messages, tools);

    if (result.kind === "success") {
      return { ok: true, ...result.response };
    }

    const { kind, transient } = classifyQwenFailure(result.error);
    lastFailure = {
      ok: false,
      kind,
      transient,
      attempts,
      detail: describeFailure(kind, result.error, attempts),
    };

    // Permanent failure: stop immediately, no further retry (Req 6.8).
    if (!transient) {
      return lastFailure;
    }

    // Transient and attempts remain: back off exponentially and retry (Req 6.7).
    if (attempts < MAX_ATTEMPTS) {
      const backoff = deps.backoffBaseMs * 2 ** (attempts - 1);
      await deps.sleep(backoff);
    }
  }

  // Transient retries exhausted (Req 6.5). `lastFailure` is set with attempts=3.
  return lastFailure!;
}

/** Build a human-readable `detail` string for a failure. */
function describeFailure(
  kind: QwenFailureKind,
  error: QwenErrorShape,
  attempts: number,
): string {
  switch (kind) {
    case "network":
      return `Qwen request failed with a network/transport error (attempt ${attempts}).`;
    case "timeout":
      return `Qwen request exceeded the per-attempt timeout (attempt ${attempts}).`;
    case "http_429":
      return `Qwen request was rate limited (HTTP 429, attempt ${attempts}).`;
    case "http_5xx":
      return `Qwen request failed with a server error (HTTP ${error.status ?? "5xx"}, attempt ${attempts}).`;
    case "http_4xx":
      return `Qwen request failed with a client error (HTTP ${error.status ?? "4xx"}, attempt ${attempts}).`;
    case "malformed":
      return `Qwen returned a malformed/unparseable response body (attempt ${attempts}).`;
    case "empty":
      return `Qwen returned an empty response — no content and no tool calls (attempt ${attempts}).`;
    default:
      return `Qwen request failed (attempt ${attempts}).`;
  }
}
