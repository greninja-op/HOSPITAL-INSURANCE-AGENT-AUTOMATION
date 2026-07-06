// =============================================================================
// lib/whatsapp/wiring.ts
//
// WhatsApp ingress COMPOSITION ROOT (Requirements 31, 34, 40).
//
// This is the single place that turns the transport-agnostic `RouterPorts`
// contract (lib/whatsapp/router.ts) into a concrete, wired-up port bag backed by
// the app's REAL implementations. The webhook route (task 26.15) builds its
// ports here and hands them to `routeInbound`, so the WhatsApp channel drives the
// SAME in-process case logic the Dashboard uses — never a channel-local copy
// (Req 40.1, 40.2):
//
//   • createCase        → the same Case-creation + async `runAgent` path as
//                         POST /api/cases (Req 1.1/1.5, 32.1–32.3).
//   • performCaseAction → the shared `lib/caseActions.performCaseAction`, invoked
//                         with `meta.source: "whatsapp"` (Req 34.8, 40.2).
//   • lookups + send    → Prisma-backed reads and the Meta Cloud API Sender.
//   • optional seams    → Safety_Guard, media gate, emergency detector, human
//                         handoff, and conversational fallback (Req 27/41/42/43/44).
//
// Staff notifications (manual-review on reject, and human-handoff broadcasts) are
// wired through a small notifier. `lib/whatsapp/notifications.ts` is being built
// concurrently; until it lands this module wires a minimal inline notifier that
// broadcasts a plain, PHI-free text to every configured Staff_Number via the
// Sender. When notifications.ts arrives, swap the inline notifier at the marked
// SEAM for its exported surface — no other change here is required.
//
// SIDE-EFFECT-LIGHT AT IMPORT: importing this module does no I/O and reads no
// config. Everything is resolved lazily inside `buildWhatsAppPorts(...)`.
// =============================================================================

import type { PrismaClient } from "@prisma/client";

import { getConfig, type AppConfig } from "../config";
import { prisma as defaultPrisma } from "../db";
import { runAgent } from "../agentRunner";
import { performCaseAction } from "../caseActions";
import { slaDeadline, remainingMs } from "../sla";
import { TERMINAL_STATUSES } from "../caseStatus";
import { screenUntrusted } from "../guard";
import type { CaseStatus } from "../types";

import { createSender, type Sender } from "./sender";
import { detectEmergency } from "./emergency";
import { recordHandoff as recordHandoffRequest } from "./handoff";
import {
  classifyMedia as classifyMediaFiles,
  type InboundMedia as MediaGateInbound,
} from "./mediaGate";
import { conversationalFallback } from "./fallback";
import type {
  CaseSummary,
  CreateCaseInput,
  FallbackInput,
  HandoffRequestInput,
  InboundMedia,
  MediaQualityResult,
  RouterPorts,
} from "./router";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default Case Detail base URL when `APP_BASE_URL` is not set. */
const DEFAULT_APP_BASE_URL = "https://authpilot.app";

/** Optional overrides — everything defaults to the real app modules / env. */
export interface WhatsAppWiringOptions {
  /** Validated App_Configuration (defaults to the boot `getConfig()`). */
  config?: AppConfig;
  /** Process environment for `WHATSAPP_STAFF_NUMBERS` / `APP_BASE_URL`. */
  env?: NodeJS.ProcessEnv;
  /** Prisma client (defaults to the shared `lib/db` client). */
  prisma?: PrismaClient;
}

/**
 * Parse the comma / whitespace-separated `WHATSAPP_STAFF_NUMBERS` env value into
 * the list of raw Staff_Numbers used for outbound broadcasts (in the exact form
 * they are dialed). Empty / blank entries are dropped.
 */
function parseStaffNumbers(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,\s]+/)
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
}

/**
 * Build the role-resolution membership set from the raw Staff_Numbers, including
 * a digits-only variant of each so a stored "+1 555 …" still matches Meta's
 * digits-only `wa_id` (mirrors `resolveRole`'s own normalization — Req 34.7).
 */
function buildStaffNumberSet(numbers: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const n of numbers) {
    set.add(n);
    const digits = n.replace(/\D/g, "");
    if (digits) set.add(digits);
  }
  return set;
}

// ─── Staff notifier (SEAM for lib/whatsapp/notifications.ts) ──────────────────

/** Best-effort staff broadcaster: sends a plain text to every Staff_Number. */
interface StaffNotifier {
  broadcast(message: string): Promise<void>;
}

/**
 * Minimal inline notifier used until `lib/whatsapp/notifications.ts` is wired in.
 * Fans the message out to every configured Staff_Number through the Sender and
 * is strictly best-effort — a per-recipient send failure is swallowed so a
 * notification can never break the action that triggered it.
 *
 * SEAM: replace this with the notifications module's staff-broadcast surface once
 * it exists; `buildWhatsAppPorts` only depends on the `StaffNotifier` shape.
 */
function makeInlineStaffNotifier(
  send: Sender,
  staffNumbers: readonly string[],
): StaffNotifier {
  return {
    async broadcast(message: string): Promise<void> {
      if (staffNumbers.length === 0 || message.trim().length === 0) return;
      await Promise.all(
        staffNumbers.map((to) =>
          send.sendText(to, message).catch((err) => {
            console.error(`[whatsapp/wiring] staff broadcast to ${to} failed:`, err);
            return undefined;
          }),
        ),
      );
    },
  };
}

// ─── CaseSummary mapping ──────────────────────────────────────────────────────

/** Minimal Case row shape the lookups select for building a `CaseSummary`. */
interface CaseRowForSummary {
  id: string;
  status: string;
  overallConfidence: number | null;
  slaDeadline: Date;
  patientNameHint: string | null;
  patient: { name: string } | null;
}

/** Map a Case row to the generic, PHI-free `CaseSummary` used by the router. */
function toCaseSummary(row: CaseRowForSummary, now: Date): CaseSummary {
  const slaDaysRemaining = Math.round(remainingMs(row.slaDeadline, now) / DAY_MS);
  return {
    caseId: row.id,
    status: row.status as CaseStatus,
    confidenceScore: row.overallConfidence,
    slaDaysRemaining,
    patientNameHint: row.patientNameHint ?? row.patient?.name ?? null,
  };
}

/** The `select` used by the Case lookups (id/status/confidence/SLA + name hint). */
const CASE_SUMMARY_SELECT = {
  id: true,
  status: true,
  overallConfidence: true,
  slaDeadline: true,
  patientNameHint: true,
  patient: { select: { name: true } },
} as const;

// ─── The factory ──────────────────────────────────────────────────────────────

/**
 * Build a concrete {@link RouterPorts} wired to the real app implementations.
 *
 * Reads the validated App_Configuration (Req 38) for the WhatsApp channel keys
 * and, from the environment, the `WHATSAPP_STAFF_NUMBERS` roster and the
 * `APP_BASE_URL` used for "Show <id>" deep links. Throws a clear error when the
 * WhatsApp channel is not configured, because a Sender cannot be built without
 * the four WhatsApp keys.
 *
 * @param options optional config / env / prisma overrides (all default to the
 *                real boot config, `process.env`, and the shared Prisma client).
 */
export function buildWhatsAppPorts(
  options: WhatsAppWiringOptions = {},
): RouterPorts {
  const cfg = options.config ?? getConfig();
  const env = options.env ?? process.env;
  const db = options.prisma ?? defaultPrisma;

  if (!cfg.whatsapp) {
    throw new Error(
      "buildWhatsAppPorts: the WhatsApp channel is not configured — set all four " +
        "WHATSAPP_* keys (see lib/config.ts) before wiring the WhatsApp ingress.",
    );
  }

  const staffNumberList = parseStaffNumbers(env.WHATSAPP_STAFF_NUMBERS);
  const staffNumbers = buildStaffNumberSet(staffNumberList);
  const appBaseUrl = (env.APP_BASE_URL ?? DEFAULT_APP_BASE_URL).replace(/\/+$/, "");

  // Outbound Meta Cloud API sender bound to the channel configuration.
  const send = createSender({
    token: cfg.whatsapp.token,
    phoneNumberId: cfg.whatsapp.phoneNumberId,
  });

  // Best-effort staff notifier (SEAM: swap for lib/whatsapp/notifications.ts).
  const notifier = makeInlineStaffNotifier(send, staffNumberList);

  const ports: RouterPorts = {
    staffNumbers,

    // Same Case-creation + async pipeline path as POST /api/cases (Req 1.1/1.5,
    // 32.1–32.3): create the Case (status "New", stored raw Intake, SLA clock),
    // then kick off `runAgent` fire-and-forget so the ack returns immediately.
    async createCase(input: CreateCaseInput): Promise<{ caseId: string }> {
      const createdAt = new Date();
      const created = await db.case.create({
        data: {
          intakeType: input.intakeType, // "whatsapp_patient_note"
          rawIntakeText: input.rawText,
          status: "New" satisfies CaseStatus,
          isUrgent: false,
          patientPhone: input.patientPhone,
          ...(input.patientNameHint
            ? { patientNameHint: input.patientNameHint }
            : {}),
          createdAt,
          slaDeadline: slaDeadline(createdAt, false),
        },
        select: { id: true },
      });

      void runAgent(created.id).catch((err: unknown) => {
        console.error(
          `[whatsapp/wiring] runAgent failed for Case "${created.id}":`,
          err,
        );
      });

      return { caseId: created.id };
    },

    // The SHARED Shared_Case_Action (lib/caseActions.ts) — the SAME operation the
    // Dashboard invokes (Req 34.8, 40.2). Staff manual-review notifications on a
    // reject flow through the wired staff notifier (Req 40.6).
    performCaseAction(caseId, actionType, meta) {
      return performCaseAction(caseId, actionType, meta, {
        prisma: db,
        notifyStaffManualReview: async (id, message) => {
          await notifier.broadcast(`Case ${id}: ${message}`);
        },
      });
    },

    // Most recent OPEN (non-terminal) Case for a patient phone (Req 32.4/32.5).
    async lookupOpenCaseByPhone(phone: string): Promise<CaseSummary | null> {
      if (!phone) return null;
      const row = await db.case.findFirst({
        where: {
          patientPhone: phone,
          status: { notIn: [...TERMINAL_STATUSES] },
        },
        orderBy: { createdAt: "desc" },
        select: CASE_SUMMARY_SELECT,
      });
      return row ? toCaseSummary(row, new Date()) : null;
    },

    // Staff status lookup by Case id, then by patient name hint / linked patient
    // name (Req 34.4). Never mutates.
    async lookupCase(query: string): Promise<CaseSummary | null> {
      const q = (query ?? "").trim();
      if (!q) return null;
      const now = new Date();

      const byId = await db.case.findUnique({
        where: { id: q },
        select: CASE_SUMMARY_SELECT,
      });
      if (byId) return toCaseSummary(byId, now);

      const byName = await db.case.findFirst({
        where: {
          OR: [
            { patientNameHint: { equals: q, mode: "insensitive" } },
            { patient: { name: { equals: q, mode: "insensitive" } } },
          ],
        },
        orderBy: { createdAt: "desc" },
        select: CASE_SUMMARY_SELECT,
      });
      return byName ? toCaseSummary(byName, now) : null;
    },

    // Absolute Case Detail deep link for a "Show <id>" reply (Req 34.5).
    caseDetailUrl(caseId: string): string {
      return `${appBaseUrl}/case/${caseId}`;
    },

    send,

    // ── Optional seams wired to their real implementations ──────────────────

    // Safety_Guard screen for untrusted intake text (Req 27).
    guard: (text: string) => screenUntrusted(text),

    // Media quality/type gate (Req 41). Adapts the router's InboundMedia to the
    // media gate's shape; the gate never throws and returns one result per file.
    classifyMedia: async (
      files: InboundMedia[],
    ): Promise<MediaQualityResult[]> => {
      const mapped: MediaGateInbound[] = files.map((f) => ({
        ref: f.mediaId,
        mimeType: f.mimeType ?? "",
        kind: f.kind === "image" ? "image" : "pdf",
      }));
      return classifyMediaFiles(mapped);
    },

    // Deterministic, non-LLM emergency-language detector (Req 42.4).
    detectEmergency: (text: string) => detectEmergency(text),

    // Record a Human_Handoff and drive an (urgent, when flagged) staff
    // notification through the wired notifier (Req 43).
    recordHandoff: async (req: HandoffRequestInput): Promise<void> => {
      await recordHandoffRequest(req, (notification) =>
        notifier.broadcast(notification.message),
      );
    },

    // Scoped, role-aware conversational fallback (Req 44).
    conversationalFallback: (input: FallbackInput) =>
      conversationalFallback(input),
  };

  return ports;
}
