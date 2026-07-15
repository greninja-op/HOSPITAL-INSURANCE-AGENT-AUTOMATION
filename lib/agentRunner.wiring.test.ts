/**
 * lib/agentRunner.wiring.test.ts
 *
 * Smoke / architectural tests (Task 11.31) — pipeline wiring guarantees.
 *
 * Feature: authpilot
 *
 * These are NOT numbered property tests. They are lightweight STATIC / structural
 * assertions that lock in the pipeline's shape so later refactors cannot silently
 * (re)introduce the tools or stages the design explicitly rules out. They inspect
 * the exported runtime maps (`STAGE_TOOLS`, the tool functions, `runAgent`) plus
 * the module source text of `lib/agentRunner.ts` and `lib/agentTools.ts`. No
 * network, no database, no live pipeline run.
 *
 * **Validates: Requirements 5.2, 7.2, 17.3, 20.3, 20.11, 20.12, 21.1**
 *
 * Guarantees asserted:
 *   • 20.11 — the tool registry contains ONLY the five existing tools:
 *             fetchPatientRecord, fetchPayerPolicy, checkPriorAuthHistory,
 *             lookupDiagnosisCode, generateAppealPdf.
 *   • 20.12 — the pipeline defines exactly the NINE named stages, with NO
 *             separate Learning / Memory / Document / Entity / Orchestrator
 *             Qwen-call stage.
 *   • 5.2 / 7.2 — Decision_Intelligence and Appeal_Generation reason over
 *             summary / decision objects rather than raw documents (no
 *             chart/policy fetch tools in their allow-lists).
 *   • 20.3  — Intake_And_Extraction resolves the five required fields in ONE
 *             merged stage.
 *   • 21.1 / 17.3 — the Strategy stage invokes `checkPriorAuthHistory` and
 *             consumes the multi-payer policy diff (`fetchPayerPolicy`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  STAGE_TOOLS,
  fetchPatientRecord,
  fetchPayerPolicy,
  checkPriorAuthHistory,
  lookupDiagnosisCode,
  type ToolName,
} from "./agentTools";
import { generateAppealPdf } from "./appealPdf";
import { runAgent, MAX_STAGE_ITERATIONS } from "./agentRunner";
import type { PipelineStage } from "./types";

// ─── Source text (read once for the static structural assertions) ─────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const agentRunnerSrc = readFileSync(join(HERE, "agentRunner.ts"), "utf8");
const agentToolsSrc = readFileSync(join(HERE, "agentTools.ts"), "utf8");

// ─── Canonical expectations ───────────────────────────────────────────────────

/** The ONLY five tools the pipeline may expose (Req 20.11). */
const EXPECTED_TOOLS: readonly ToolName[] = [
  "fetchPatientRecord",
  "fetchPayerPolicy",
  "checkPriorAuthHistory",
  "lookupDiagnosisCode",
  "generateAppealPdf",
];

/** The nine ordered pipeline stages (Req 20.12). */
const EXPECTED_STAGES: readonly PipelineStage[] = [
  "Intake_And_Extraction",
  "Medical_Review",
  "Policy_Review",
  "Strategy",
  "Decision_Intelligence",
  "Appeal_Generation",
  "Verification_QA",
  "Human_Approval",
  "Submission_And_Tracking",
];

/** Concepts the merged pipeline must NOT expose as standalone Qwen-call stages. */
const FORBIDDEN_STAGE_CONCEPTS = [
  "Learning",
  "Memory",
  "Document",
  "Entity",
  "Orchestrator",
] as const;

/** The union of every tool referenced anywhere in the STAGE_TOOLS map. */
function toolUniverse(): Set<string> {
  const all = new Set<string>();
  for (const tools of Object.values(STAGE_TOOLS)) {
    for (const t of tools) all.add(t);
  }
  return all;
}

// ─── 20.11 — tool registry contains ONLY the five existing tools ──────────────

describe("Wiring: tool registry (Req 20.11)", () => {
  it("STAGE_TOOLS references exactly the five known tools and nothing else", () => {
    const universe = toolUniverse();
    expect([...universe].sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("exposes exactly five callable Agent_Tool implementations", () => {
    const impls: Record<ToolName, unknown> = {
      fetchPatientRecord,
      fetchPayerPolicy,
      checkPriorAuthHistory,
      lookupDiagnosisCode,
      generateAppealPdf,
    };
    // Every expected tool resolves to a function; the map has no extra keys.
    expect(Object.keys(impls).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const name of EXPECTED_TOOLS) {
      expect(typeof impls[name]).toBe("function");
    }
  });

  it("the ToolName union declares exactly the five tools (no new tool types)", () => {
    // Static: count the quoted members of the exported ToolName union.
    const unionMatch = agentToolsSrc.match(
      /export type ToolName =([\s\S]*?);/,
    );
    expect(unionMatch).not.toBeNull();
    const declared = [...unionMatch![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("the Agent_Runner TOOL_SCHEMAS registry offers exactly the five tools to Qwen", () => {
    for (const name of EXPECTED_TOOLS) {
      expect(agentRunnerSrc).toContain(`name: "${name}"`);
    }
    // No sixth tool schema: the schema map is keyed by the five names only.
    const schemaNames = [
      ...agentRunnerSrc.matchAll(/function:\s*{\s*name:\s*"([^"]+)"/g),
    ].map((m) => m[1]);
    expect(schemaNames.sort()).toEqual([...EXPECTED_TOOLS].sort());
  });
});

// ─── 20.12 — exactly nine named stages, no separate merged-away stages ────────

describe("Wiring: nine-stage pipeline (Req 20.12)", () => {
  it("STAGE_TOOLS is keyed by exactly the nine named stages", () => {
    expect(Object.keys(STAGE_TOOLS).sort()).toEqual(
      [...EXPECTED_STAGES].sort(),
    );
    expect(Object.keys(STAGE_TOOLS)).toHaveLength(9);
  });

  it("defines no separate Learning / Memory / Document / Entity / Orchestrator stage", () => {
    // None of the forbidden concepts appears as a pipeline stage key.
    for (const concept of FORBIDDEN_STAGE_CONCEPTS) {
      expect(Object.keys(STAGE_TOOLS)).not.toContain(concept);
    }
    // Nor as a standalone stage-body function (e.g. `documentStage`, `entityStage`).
    const forbiddenStageFn = new RegExp(
      `function\\s+\\w*(?:${FORBIDDEN_STAGE_CONCEPTS.join("|")})\\w*Stage\\b`,
      "i",
    );
    expect(agentRunnerSrc).not.toMatch(forbiddenStageFn);
  });

  it("merges the former Document + Entity steps into ONE Qwen call", () => {
    // The intake stage explicitly documents the merge that removed the separate
    // Document/Entity Qwen calls (Req 20.12).
    expect(agentRunnerSrc).toMatch(
      /Merges the former Document \+ Entity steps into ONE Qwen call/i,
    );
    // And there is a single intake stage body, not two.
    const intakeStageFns = [
      ...agentRunnerSrc.matchAll(/function\s+intakeAndExtractionStage\b/g),
    ];
    expect(intakeStageFns).toHaveLength(1);
  });
});

// ─── 5.2 / 7.2 — Decision & Appeal consume summaries/decision, not raw docs ───

describe("Wiring: summary/decision inputs, not raw documents (Req 5.2, 7.2)", () => {
  it("Decision_Intelligence has an EMPTY tool allow-list (pure reasoning over summaries)", () => {
    expect(STAGE_TOOLS.Decision_Intelligence).toEqual([]);
  });

  it("Appeal_Generation may only render the PDF — it cannot fetch raw documents", () => {
    expect(STAGE_TOOLS.Appeal_Generation).toEqual(["generateAppealPdf"]);
  });

  it("neither Decision_Intelligence nor Appeal_Generation can reach chart/policy source tools", () => {
    const rawDocTools = ["fetchPatientRecord", "fetchPayerPolicy"];
    for (const tool of rawDocTools) {
      expect(STAGE_TOOLS.Decision_Intelligence).not.toContain(tool);
      expect(STAGE_TOOLS.Appeal_Generation).not.toContain(tool);
    }
  });
});

// ─── 20.3 — Intake resolves the five fields in one stage ──────────────────────

describe("Wiring: single-stage five-field extraction (Req 20.3)", () => {
  it("Intake_And_Extraction is a single stage in the pipeline", () => {
    expect(Object.keys(STAGE_TOOLS)).toContain("Intake_And_Extraction");
  });

  it("declares exactly the five required Extracted_Field names", () => {
    const block = agentRunnerSrc.match(
      /const INTAKE_FIELD_NAMES = {([\s\S]*?)} as const;/,
    );
    expect(block).not.toBeNull();
    const fieldValues = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(fieldValues.sort()).toEqual(
      [
        "denial_reason",
        "diagnosis_code",
        "patient",
        "payer",
        "procedure_code",
      ].sort(),
    );
    expect(fieldValues).toHaveLength(5);
  });
});

// ─── 21.1 / 17.3 — Strategy uses prior-auth history + multi-payer policy diff ─

describe("Wiring: Strategy stage tooling (Req 21.1, 17.3)", () => {
  it("invokes checkPriorAuthHistory (Req 21.1) and consumes fetchPayerPolicy for the policy diff (Req 17.3)", () => {
    expect(STAGE_TOOLS.Strategy).toContain("checkPriorAuthHistory");
    expect(STAGE_TOOLS.Strategy).toContain("fetchPayerPolicy");
  });

  it("Strategy is scoped to only those two tools (no new tools, Req 20.11)", () => {
    expect([...STAGE_TOOLS.Strategy].sort()).toEqual(
      ["checkPriorAuthHistory", "fetchPayerPolicy"].sort(),
    );
  });

  it("its prompt directs the model to prior-auth history and multi-payer policy diffing", () => {
    expect(agentRunnerSrc).toContain("checkPriorAuthHistory(patientId)");
    expect(agentRunnerSrc).toMatch(/multi-payer policy diff/i);
  });
});

// ─── Sanity: the pipeline entrypoint and loop bound are wired ─────────────────

describe("Wiring: pipeline entrypoint", () => {
  it("exports a runAgent orchestrator and a bounded per-stage loop cap", () => {
    expect(typeof runAgent).toBe("function");
    expect(MAX_STAGE_ITERATIONS).toBe(8);
  });
});
