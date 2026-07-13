/**
 * Property test — Stale chart notes are flagged at the 90-day boundary.
 *
 * // Feature: authpilot, Property 13: Stale chart notes are flagged at the 90-day boundary
 * Validates: Requirements 4.3
 *
 * `detectStaleNotes()` flags a Chart_Note as potentially stale when it is dated
 * MORE THAN `thresholdDays` before case creation. The implementation
 * (lib/detection.ts) uses the raw millisecond difference and a STRICT boundary:
 *
 *     stale  ⇔  (caseCreatedAt - noteDate) > thresholdDays * MS_PER_DAY
 *
 * i.e. a note dated exactly `thresholdDays` before creation is NOT stale, a note
 * dated `thresholdDays` + 1ms before creation IS stale, and a note dated on or
 * after `caseCreatedAt` is never stale.
 *
 * This test drives (noteDate, caseCreatedAt, thresholdDays) triples — with the
 * generators concentrated tightly around the exact boundary (±1ms and ±1 day) —
 * and asserts that the emitted flag matches the boundary rule exactly, plus the
 * precise deterministic boundary examples.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { FC_CONFIG } from "./testConfig";
import {
  detectStaleNotes,
  STALE_NOTE_THRESHOLD_DAYS,
  type ChartNoteForStaleness,
} from "./detection";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The reference behaviour the implementation must satisfy: the note is stale iff
 * it falls on the stale side of the strict `> thresholdDays` boundary.
 */
function expectedStale(
  noteDate: Date,
  caseCreatedAt: Date,
  thresholdDays: number,
): boolean {
  return caseCreatedAt.getTime() - noteDate.getTime() > thresholdDays * MS_PER_DAY;
}

/** A plausible case-creation instant (fixed span, avoids DST-free assumptions). */
const arbCaseCreatedAt = fc
  .integer({
    // ~2015-01-01 .. ~2035-01-01 in epoch ms.
    min: Date.UTC(2015, 0, 1),
    max: Date.UTC(2035, 0, 1),
  })
  .map((ms) => new Date(ms));

/** Injectable staleness threshold, including the production default of 90. */
const arbThresholdDays = fc.constantFrom(1, 7, 30, STALE_NOTE_THRESHOLD_DAYS, 180, 365);

/**
 * An offset (ms) of the note BEFORE case creation, concentrated around the exact
 * boundary so the ±1ms/±1day corners are hit densely, mixed with far-and-wide
 * offsets (including negative = note dated after creation) for coverage.
 */
function arbDiffMs(thresholdDays: number): fc.Arbitrary<number> {
  const boundary = thresholdDays * MS_PER_DAY;
  const nearBoundary = fc
    .integer({ min: -2 * MS_PER_DAY, max: 2 * MS_PER_DAY })
    .map((delta) => boundary + delta);
  const exactCorners = fc.constantFrom(
    boundary - MS_PER_DAY,
    boundary - 1,
    boundary,
    boundary + 1,
    boundary + MS_PER_DAY,
  );
  // Wide range: anything from "note far in the future" to "note very old".
  const wide = fc.integer({ min: -400 * MS_PER_DAY, max: 400 * MS_PER_DAY });
  return fc.oneof(exactCorners, nearBoundary, nearBoundary, wide);
}

describe("Stale chart-note boundary flagging (Property 13)", () => {
  it("flags a note stale iff it falls on the strict >threshold side of the boundary", () => {
    fc.assert(
      fc.property(arbCaseCreatedAt, arbThresholdDays, (caseCreatedAt, thresholdDays) =>
        fc.assert(
          fc.property(arbDiffMs(thresholdDays), (diffMs) => {
            const noteDate = new Date(caseCreatedAt.getTime() - diffMs);
            const note: ChartNoteForStaleness = { id: "note-1", noteDate };

            const results = detectStaleNotes([note], caseCreatedAt, thresholdDays);
            const flagged = results.length === 1;

            // Req 4.3 — flag matches the exact boundary rule the impl uses.
            expect(flagged).toBe(expectedStale(noteDate, caseCreatedAt, thresholdDays));

            if (flagged) {
              // The flag carries the note id and note date (Req 4.3).
              expect(results[0].noteId).toBe("note-1");
              expect(results[0].noteDate.getTime()).toBe(noteDate.getTime());
            }
          }),
          FC_CONFIG,
        ),
      ),
      { numRuns: 20 },
    );
  });

  it("treats a note dated EXACTLY threshold days before creation as NOT stale (strict boundary)", () => {
    fc.assert(
      fc.property(arbCaseCreatedAt, arbThresholdDays, (caseCreatedAt, thresholdDays) => {
        const noteDate = new Date(
          caseCreatedAt.getTime() - thresholdDays * MS_PER_DAY,
        );
        const results = detectStaleNotes(
          [{ id: "n", noteDate }],
          caseCreatedAt,
          thresholdDays,
        );
        expect(results).toHaveLength(0);
      }),
      FC_CONFIG,
    );
  });

  it("flags a note dated threshold days + 1ms before creation as stale", () => {
    fc.assert(
      fc.property(arbCaseCreatedAt, arbThresholdDays, (caseCreatedAt, thresholdDays) => {
        const noteDate = new Date(
          caseCreatedAt.getTime() - (thresholdDays * MS_PER_DAY + 1),
        );
        const results = detectStaleNotes(
          [{ id: "n", noteDate }],
          caseCreatedAt,
          thresholdDays,
        );
        expect(results).toHaveLength(1);
      }),
      FC_CONFIG,
    );
  });

  it("never flags a note dated on or after case creation", () => {
    fc.assert(
      fc.property(
        arbCaseCreatedAt,
        arbThresholdDays,
        fc.integer({ min: 0, max: 30 * MS_PER_DAY }),
        (caseCreatedAt, thresholdDays, aheadMs) => {
          const noteDate = new Date(caseCreatedAt.getTime() + aheadMs);
          const results = detectStaleNotes(
            [{ id: "n", noteDate }],
            caseCreatedAt,
            thresholdDays,
          );
          expect(results).toHaveLength(0);
        },
      ),
      FC_CONFIG,
    );
  });
});
