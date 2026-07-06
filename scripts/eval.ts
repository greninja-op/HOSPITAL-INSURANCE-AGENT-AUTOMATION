// =============================================================================
// scripts/eval.ts
//
// Gold-Case behavioral evaluation (Requirement 30).
//
// A Gold_Case pins a fixed Intake to its expected Resolution_Path and expected
// triggering Finding identifier(s). This runner loads the `eval/gold/*.json`
// fixtures, executes each Gold_Case against DETERMINISTIC FAKES (no live Qwen,
// no DB), and reports a per-case pass/fail. A Gold_Case passes only when BOTH
// the produced Resolution_Path AND the produced triggering Finding id(s) match
// the expected values (Req 30.3, 30.4).
//
// The point of the exercise is to catch decision-logic regressions: the fake
// pipeline (`analyzeIntake`) proposes facts (a Confidence_Score + structured
// Findings) from a fixed intake, and the REAL, pure decision logic under test
// (`lib/decisionEngine.ts` `decide` + `lib/findings.ts` builders/inspectors)
// determines the outcome. If `decide`, the finding builders, or their id
// scheme regress, a known Gold_Case flips to fail.
//
// Runnable directly:   npx tsx scripts/eval.ts
// Importable (Task 24.2 / Property 65): `runGoldCases`, `evaluateGoldCase`,
// `loadGoldCases`, `analyzeIntake`, and the `GoldCase`/`GoldCaseResult` types.
// =============================================================================

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Finding, IntakeType, ResolutionPath } from "@/lib/types";
import { decide } from "@/lib/decisionEngine";
import {
  blockingCount,
  contradictionFinding,
  gapFinding,
  policyFinding,
  warningFindings,
} from "@/lib/findings";

// ─── Gold_Case shapes (mirrors the design's Gold-Case evaluation types) ───────

/** A fixed Intake for a Gold_Case (Req 30.1). */
export interface GoldCaseIntake {
  text: string;
  intakeType: IntakeType;
  urgent?: boolean;
}

/** A stored evaluation case with a fixed Intake and expected outcomes (Req 30.1). */
export interface GoldCase {
  id: string;
  intake: GoldCaseIntake;
  /** Expected routing outcome. */
  expectedResolutionPath: ResolutionPath;
  /** Stable Finding ids expected to drive the outcome (order-insensitive). */
  expectedTriggeringFindingIds: string[];
}

/** The per-case evaluation outcome (Req 30.3). */
export interface GoldCaseResult {
  id: string;
  /** true iff BOTH path and triggering ids match the expected values (Req 30.3). */
  pass: boolean;
  producedResolutionPath: ResolutionPath;
  producedTriggeringFindingIds: string[];
  expectedResolutionPath: ResolutionPath;
  expectedTriggeringFindingIds: string[];
}

// ─── Deterministic fake pipeline (stands in for Qwen extraction/review) ───────

/**
 * The facts a fake "pipeline" proposes for an intake: an overall
 * Confidence_Score plus the structured Findings it surfaced. This is the ONLY
 * fake; the mapping from these facts to an outcome is the real logic under test.
 */
export interface AnalyzedIntake {
  overallConfidence: number;
  findings: Finding[];
}

// Case-insensitive cue detectors. Gold-case intake fixtures are engineered so
// these natural-language cues deterministically drive the fake pipeline.
const CONTRADICTION_CUE = /contradict|diagnosis mismatch|does not match the documented/i;
const POLICY_EXCLUSION_CUE =
  /excluded under the plan|policy exclusion|non-covered benefit|not a covered benefit/i;
const EVIDENCE_GAP_CUE =
  /insufficient documentation|missing the |please provide|awaiting records/i;
const LOW_CONFIDENCE_CUE =
  /illegible|unclear|garbled|could not be determined|ambiguous/i;

/** Confidence band constants used by the fake pipeline. */
const HIGH_CONFIDENCE = 92; // > 85 ⇒ Auto_Draft when unblocked
const MEDIUM_CONFIDENCE = 72; // within [60, 85] ⇒ Draft_And_Request_Evidence
const LOW_CONFIDENCE = 40; // < 60 ⇒ Escalate_To_Human

/**
 * Deterministically derive proposed facts (confidence + Findings) from a fixed
 * intake. PURE: no I/O, no LLM, no DB. Findings are built with the REAL
 * `lib/findings.ts` builders so their ids follow the production id scheme
 * (`<kind>:<slug>:<caseId>`), keeping the evaluation honest.
 */
export function analyzeIntake(caseId: string, intake: GoldCaseIntake): AnalyzedIntake {
  const text = intake.text;
  const findings: Finding[] = [];

  if (CONTRADICTION_CUE.test(text)) {
    findings.push(
      contradictionFinding({
        caseId,
        slug: "dx-mismatch",
        expected: "documented diagnosis",
        actual: "billed procedure code",
        technicalMessage:
          "Requested procedure code contradicts the documented diagnosis for the case.",
        friendlyMessage:
          "The procedure on the claim does not match the diagnosis in the records, so this needs a person to review.",
      }),
    );
  }

  if (POLICY_EXCLUSION_CUE.test(text)) {
    findings.push(
      policyFinding({
        caseId,
        slug: "coverage-exclusion",
        technicalMessage: "Service is excluded under the payer plan (non-covered benefit).",
        friendlyMessage:
          "The plan lists this service as not covered, so a person should confirm how to proceed.",
        severity: "blocking",
      }),
    );
  }

  if (EVIDENCE_GAP_CUE.test(text)) {
    findings.push(
      gapFinding({
        caseId,
        slug: "missing-evidence",
        technicalMessage:
          "Supporting documentation (e.g. therapy records) is missing for medical necessity.",
        friendlyMessage:
          "Some supporting records are missing, so we'll request them before drafting the appeal.",
        severity: "warning",
      }),
    );
  }

  // Confidence: illegible/ambiguous intake ⇒ low; an evidence gap holds it in
  // the medium band; otherwise a clean, reconciled intake is high.
  let overallConfidence = HIGH_CONFIDENCE;
  if (LOW_CONFIDENCE_CUE.test(text)) {
    overallConfidence = LOW_CONFIDENCE;
  } else if (EVIDENCE_GAP_CUE.test(text)) {
    overallConfidence = MEDIUM_CONFIDENCE;
  }

  return { overallConfidence, findings };
}

/**
 * The Finding id(s) that DROVE the produced Resolution_Path:
 *   • Escalate_To_Human — the blocking Findings that forced escalation
 *     (empty when escalation was driven purely by low confidence, Req 5.5).
 *   • Draft_And_Request_Evidence — the warning-severity gap Findings whose
 *     evidence the path requests (Req 5.4, 29.5).
 *   • Auto_Draft — none (a clean, high-confidence case has no triggers).
 */
function triggeringFindingIds(path: ResolutionPath, findings: Finding[]): string[] {
  switch (path) {
    case "Escalate_To_Human":
      return findings.filter((f) => f.severity === "blocking").map((f) => f.findingId);
    case "Draft_And_Request_Evidence":
      return warningFindings(findings).map((f) => f.findingId);
    case "Auto_Draft":
      return [];
  }
}

/** Order-insensitive equality for two id lists. */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

/**
 * Evaluate a single Gold_Case against the deterministic fake pipeline and the
 * real decision logic (Req 30.2). A case passes iff BOTH the produced
 * Resolution_Path and the produced triggering Finding id(s) match the expected
 * values (Req 30.3, 30.4).
 */
export function evaluateGoldCase(goldCase: GoldCase): GoldCaseResult {
  const { overallConfidence, findings } = analyzeIntake(goldCase.id, goldCase.intake);

  const decision = decide({
    overallConfidence,
    contradictionCount: blockingCount(findings),
    iterationsExhausted: false,
  });

  const producedTriggeringFindingIds = triggeringFindingIds(decision.path, findings);

  const pass =
    decision.path === goldCase.expectedResolutionPath &&
    sameIdSet(producedTriggeringFindingIds, goldCase.expectedTriggeringFindingIds);

  return {
    id: goldCase.id,
    pass,
    producedResolutionPath: decision.path,
    producedTriggeringFindingIds,
    expectedResolutionPath: goldCase.expectedResolutionPath,
    expectedTriggeringFindingIds: goldCase.expectedTriggeringFindingIds,
  };
}

/**
 * Run every Gold_Case against deterministic fakes and report per-case pass/fail
 * (Req 30.2, 30.3). Async to match the design signature and allow future fakes
 * to be async without changing callers.
 */
export async function runGoldCases(cases: GoldCase[]): Promise<GoldCaseResult[]> {
  return cases.map(evaluateGoldCase);
}

// ─── Fixture loading ──────────────────────────────────────────────────────────

/** Directory holding the `eval/gold/*.json` fixtures, relative to this file. */
function defaultGoldDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "eval", "gold");
}

const RESOLUTION_PATHS: readonly ResolutionPath[] = [
  "Auto_Draft",
  "Draft_And_Request_Evidence",
  "Escalate_To_Human",
];

/** Narrow unknown JSON into a validated GoldCase, throwing on any shape error. */
function parseGoldCase(raw: unknown, source: string): GoldCase {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Gold_Case in ${source} must be a JSON object.`);
  }
  const obj = raw as Record<string, unknown>;
  const intake = obj.intake as Record<string, unknown> | undefined;

  if (typeof obj.id !== "string" || obj.id.length === 0) {
    throw new Error(`Gold_Case in ${source} is missing a string "id".`);
  }
  if (!intake || typeof intake.text !== "string" || typeof intake.intakeType !== "string") {
    throw new Error(`Gold_Case "${obj.id}" (${source}) has an invalid intake.`);
  }
  if (!RESOLUTION_PATHS.includes(obj.expectedResolutionPath as ResolutionPath)) {
    throw new Error(
      `Gold_Case "${obj.id}" (${source}) has an invalid expectedResolutionPath.`,
    );
  }
  if (
    !Array.isArray(obj.expectedTriggeringFindingIds) ||
    !obj.expectedTriggeringFindingIds.every((id) => typeof id === "string")
  ) {
    throw new Error(
      `Gold_Case "${obj.id}" (${source}) has an invalid expectedTriggeringFindingIds.`,
    );
  }

  return {
    id: obj.id,
    intake: {
      text: intake.text,
      intakeType: intake.intakeType as IntakeType,
      urgent: typeof intake.urgent === "boolean" ? intake.urgent : undefined,
    },
    expectedResolutionPath: obj.expectedResolutionPath as ResolutionPath,
    expectedTriggeringFindingIds: obj.expectedTriggeringFindingIds as string[],
  };
}

/**
 * Load and validate all `*.json` Gold_Case fixtures from `dir` (defaults to
 * `eval/gold`), returning them sorted by id for deterministic ordering.
 */
export function loadGoldCases(dir: string = defaultGoldDir()): GoldCase[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();

  return files
    .map((name) => {
      const full = join(dir, name);
      const parsed: unknown = JSON.parse(readFileSync(full, "utf8"));
      return parseGoldCase(parsed, name);
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

/**
 * Load the fixtures, evaluate them, print a per-case report, and set the exit
 * code (0 = all pass, 1 = at least one fail) so CI can gate on the result.
 */
async function main(): Promise<void> {
  const cases = loadGoldCases();
  const results = await runGoldCases(cases);

  console.log(`\nGold-Case evaluation — ${results.length} case(s)\n`);
  for (const r of results) {
    const label = r.pass ? "PASS" : "FAIL";
    console.log(`  [${label}] ${r.id}`);
    if (!r.pass) {
      console.log(
        `         path:      expected ${r.expectedResolutionPath}, got ${r.producedResolutionPath}`,
      );
      console.log(
        `         findings:  expected [${r.expectedTriggeringFindingIds.join(", ")}], got [${r.producedTriggeringFindingIds.join(", ")}]`,
      );
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed.\n`);

  process.exitCode = failed === 0 ? 0 : 1;
}

// Run only when executed directly (e.g. `npx tsx scripts/eval.ts`), not when
// imported by the Property 65 test.
const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  void main();
}
