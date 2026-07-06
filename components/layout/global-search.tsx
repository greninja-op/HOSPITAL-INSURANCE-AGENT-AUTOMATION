"use client";

// =============================================================================
// components/layout/global-search.tsx
//
// Global patient/case search control (Requirement 19.2). As the Operator types
// a patient name, this queries GET /api/patients/search and shows the matching
// patients together with their linked Cases, each linking to the Case Detail
// page. An empty query clears the results.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  PatientSearchResponse,
  PatientSearchResult,
} from "@/app/api/patients/search/route";

const DEBOUNCE_MS = 250;

export function GlobalSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PatientSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Debounced fetch against the patient-search route.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/patients/search?q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        if (!res.ok) throw new Error(`search failed: ${res.status}`);
        const data = (await res.json()) as PatientSearchResponse;
        setResults(data.patients);
      } catch (err) {
        if (!controller.signal.aborted) setResults([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  // Close the results dropdown when clicking outside the control.
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  const trimmed = query.trim();
  const showDropdown = open && trimmed.length > 0;

  return (
    <div ref={containerRef} className="relative w-full max-w-md">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder="Search patients or cases…"
          aria-label="Search patients"
          className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-9 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        {loading ? (
          <Loader2
            className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
            aria-hidden
          />
        ) : trimmed.length > 0 ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              setResults([]);
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>

      {showDropdown ? (
        <div className="absolute z-50 mt-2 max-h-96 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {loading && results.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              No patients match &ldquo;{trimmed}&rdquo;.
            </p>
          ) : (
            <ul className="space-y-1">
              {results.map((patient) => (
                <li key={patient.id}>
                  <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {patient.name}
                  </div>
                  {patient.cases.length === 0 ? (
                    <p className="px-3 pb-2 text-sm text-muted-foreground">
                      No cases yet
                    </p>
                  ) : (
                    patient.cases.map((c) => (
                      <Link
                        key={c.id}
                        href={`/case/${c.id}`}
                        onClick={() => setOpen(false)}
                        className={cn(
                          "flex items-center justify-between gap-2 rounded-sm px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground",
                        )}
                      >
                        <span className="truncate">
                          {c.payerName ?? "Unknown payer"}
                          {c.denialReason ? ` · ${c.denialReason}` : ""}
                        </span>
                        <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                          {c.status}
                        </span>
                      </Link>
                    ))
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
