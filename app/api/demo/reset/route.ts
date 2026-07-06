// =============================================================================
// app/api/demo/reset/route.ts
//
// POST /api/demo/reset — the "Reset Demo Data" control (Requirement 18.5).
//
// Re-runs the seed process: `seedDemoData` clears every demo/mutable row
// (children before parents to respect foreign keys) and re-inserts the full,
// reproducible demo dataset, restoring the seeded state between run-throughs.
//
// Runs on the Node.js runtime because Prisma is not edge-compatible, and shares
// the single Prisma connection pool via the seed module's `lib/db` import.
// =============================================================================

import { NextResponse } from "next/server";
import { seedDemoData, type SeedSummary } from "@/prisma/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface DemoResetResponse {
  ok: boolean;
  /** Row counts inserted by the re-run seed (present on success). */
  summary?: SeedSummary;
  /** Human-readable failure reason (present on error). */
  error?: string;
}

export async function POST(): Promise<NextResponse<DemoResetResponse>> {
  try {
    const summary = await seedDemoData();
    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/demo/reset] reset failed:", error);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
