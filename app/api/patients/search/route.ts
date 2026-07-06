// =============================================================================
// app/api/patients/search/route.ts
//
// GET /api/patients/search?q=<name>
//
// Global patient search (Requirement 19.2): given a patient-name query, return
// the matching patients together with their linked Cases so an Operator can
// jump to a patient's cases from the persistent global search box.
//
//   - `q` (required) — case-insensitive substring of the patient name.
//
// An empty/whitespace-only `q` returns an empty result set rather than every
// patient. Uses the shared Prisma client (`lib/db.ts`); runs on the Node.js
// runtime because Prisma is not edge-safe.
// =============================================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import type { CaseStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A linked Case shown under a matched patient. */
export interface PatientCaseSummary {
  id: string;
  status: CaseStatus;
  payerName: string | null;
  denialReason: string | null;
  isUrgent: boolean;
  slaDeadline: string;
  createdAt: string;
}

/** A patient matching the search query, with their linked Cases. */
export interface PatientSearchResult {
  id: string;
  name: string;
  cases: PatientCaseSummary[];
}

export interface PatientSearchResponse {
  query: string;
  patients: PatientSearchResult[];
}

export async function GET(
  request: Request,
): Promise<NextResponse<PatientSearchResponse>> {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() ?? "";

  if (query.length === 0) {
    return NextResponse.json({ query, patients: [] });
  }

  const found = await prisma.patient.findMany({
    where: { name: { contains: query, mode: "insensitive" } },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      cases: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          payerName: true,
          denialReason: true,
          isUrgent: true,
          slaDeadline: true,
          createdAt: true,
        },
      },
    },
  });

  const patients: PatientSearchResult[] = found.map((p) => ({
    id: p.id,
    name: p.name,
    cases: p.cases.map((c) => ({
      id: c.id,
      status: c.status as CaseStatus,
      payerName: c.payerName,
      denialReason: c.denialReason,
      isUrgent: c.isUrgent,
      slaDeadline: c.slaDeadline.toISOString(),
      createdAt: c.createdAt.toISOString(),
    })),
  }));

  return NextResponse.json({ query, patients });
}
