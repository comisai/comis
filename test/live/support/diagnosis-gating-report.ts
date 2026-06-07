// SPDX-License-Identifier: Apache-2.0
/**
 * Per-failure-class gating report (Phase 149 — PROVE: LLM-diagnosis baseline,
 * success criterion #3).
 *
 * THE deliverable that gates phases 150-155. The Stage-C baseline RUN
 * (diagnosis-baseline.test.ts) hands each fixture to a fresh scripted agent on
 * today's obs surface and records a DiagnosisVerdictRow per failure class; this
 * module turns those rows into a per-class trim/build recommendation table:
 *
 *   - A class root-caused in <=1 obs call with 0 source reads is a TRIM-CANDIDATE
 *     (an existing RPC already suffices — a downstream phase may be trimmed, e.g.
 *     "exec ModuleNotFound is already 1-call diagnosable via obs.diagnostics" →
 *     reorder 150-153, RESEARCH.md Pitfall 5 / Open Question 3).
 *   - A class that needs source reads (or multi-call) today is BUILD-needed — the
 *     measured cost (reads + calls) is exactly what Phase 156/G1 must drive to zero.
 *   - A judge-skipped class is INCONCLUSIVE (re-run with a key).
 *
 * This is metric-bearing logic (not scaffolding), so it is RED→GREEN unit-tested
 * in diagnosis-gating-report.test.ts (TDD mode) BEFORE the run consumes it.
 *
 * SECURITY (T-149-03-01): renderGatingMarkdown runs `assertNoSecrets` over its
 * output before returning — defense-in-depth. The table carries only counts /
 * class names / typed verdicts (never answer text or bodies), but the
 * residency rule is applied uniformly to every persisted-bound string. The
 * secret-sweep lives in cost.ts and is imported, never re-implemented (DRY).
 *
 * @module
 */

import { assertNoSecrets } from "../cost.js";
import type { DiagnosisFailureClass, DiagnosisVerdictRow } from "./diagnosis-harness.js";

/**
 * One row of the gating table — a per-failure-class verdict on whether today's
 * surface already suffices (TRIM) or a downstream phase must build new surface
 * (BUILD), with the measured cost that justifies the call.
 */
export interface GatingRow {
  failureClass: DiagnosisFailureClass;
  /** obs.* RPC / trajectory / read_source paths the agent touched (from the verdict row). */
  surfacesUsed: string[];
  /** M2c — distinct source files the agent had to read to reach root cause. */
  distinctSourceReads: number;
  /** M2b — distinct tool/RPC names the agent invoked. */
  distinctToolCalls: number;
  /** M2a — total tokens the diagnosis cost. */
  totalTokens: number;
  /** Whether the agent reached the causal mechanism ("skip" when the judge was absent). */
  rootCauseReached: boolean | "skip";
  /**
   * TRUE when the class was root-caused with 0 source reads AND <=1 distinct obs
   * call today — i.e. an existing RPC already suffices, so a downstream phase may
   * be TRIMMED. FALSE when the judge skipped (inconclusive — never a trim).
   */
  existingRpcSuffices: boolean;
  /** Human-readable gate signal: TRIM-CANDIDATE | BUILD | INCONCLUSIVE. */
  recommendation: string;
}

/**
 * Map each {@link DiagnosisVerdictRow} to a {@link GatingRow}.
 *
 * `existingRpcSuffices = (rootCauseReached === true) && (distinctSourceReads === 0)
 * && (distinctToolCalls <= 1)` — a TRIM-CANDIDATE requires a CORRECT diagnosis
 * (a cheap-but-wrong answer must not trim a phase) reached purely from the obs
 * surface (no source reads) in a single call.
 *
 * recommendation:
 *   - rootCauseReached === "skip"  → "INCONCLUSIVE (judge skipped — re-run with a key)"
 *   - existingRpcSuffices          → "TRIM-CANDIDATE: <class> is root-caused in <=1 call with 0 source reads today"
 *   - otherwise                    → "BUILD: <class> needs N source reads + M calls today"
 */
export function buildGatingTable(rows: DiagnosisVerdictRow[]): GatingRow[] {
  return rows.map((row) => {
    const existingRpcSuffices =
      row.rootCauseReached === true &&
      row.distinctSourceReads === 0 &&
      row.distinctToolCalls <= 1;

    let recommendation: string;
    if (row.rootCauseReached === "skip") {
      recommendation = "INCONCLUSIVE (judge skipped — re-run with a key)";
    } else if (existingRpcSuffices) {
      recommendation = `TRIM-CANDIDATE: ${row.failureClass} is root-caused in <=1 call with 0 source reads today`;
    } else {
      recommendation = `BUILD: ${row.failureClass} needs ${row.distinctSourceReads} source reads + ${row.distinctToolCalls} calls today`;
    }

    return {
      failureClass: row.failureClass,
      surfacesUsed: row.surfacesUsed,
      distinctSourceReads: row.distinctSourceReads,
      distinctToolCalls: row.distinctToolCalls,
      totalTokens: row.totalTokens,
      rootCauseReached: row.rootCauseReached,
      existingRpcSuffices,
      recommendation,
    };
  });
}

/** Render a single `rootCauseReached` cell ("yes" | "no" | "skip"). */
function reachedCell(reached: boolean | "skip"): string {
  if (reached === "skip") return "skip";
  return reached ? "yes" : "no";
}

/**
 * Render the gating table as markdown: one row per failure class plus a summary
 * line counting TRIM-CANDIDATEs (the reorder/trim signal the milestone reads
 * before building 150-155).
 *
 * Runs `assertNoSecrets` over the output before returning (T-149-03-01,
 * defense-in-depth).
 */
export function renderGatingMarkdown(table: GatingRow[]): string {
  const trimCandidates = table.filter((r) => r.existingRpcSuffices).length;

  const lines: string[] = [];
  lines.push("# Diagnosis baseline — per-failure-class gating table");
  lines.push("");
  lines.push(
    "The measure-first GATE for phases 150-155. A TRIM-CANDIDATE class is root-caused " +
      "from today's obs surface alone (0 source reads, <=1 call) — its downstream phase " +
      "may be trimmed. A BUILD class shows the source-read + call cost a new surface must " +
      "drive to zero. INCONCLUSIVE = the judge was skipped (re-run with a key).",
  );
  lines.push("");
  lines.push(
    "| Failure class | Reached | Source reads | Tool calls | Tokens | Existing RPC suffices | Recommendation |",
  );
  lines.push(
    "|---|---|---|---|---|---|---|",
  );
  for (const r of table) {
    lines.push(
      `| ${r.failureClass} | ${reachedCell(r.rootCauseReached)} | ${r.distinctSourceReads} | ` +
        `${r.distinctToolCalls} | ${r.totalTokens} | ${r.existingRpcSuffices ? "yes" : "no"} | ${r.recommendation} |`,
    );
  }
  lines.push("");
  lines.push(
    `**Summary:** ${trimCandidates} TRIM-CANDIDATE class(es) of ${table.length} — these flag a ` +
      "downstream phase (150-155) an existing RPC may already cover.",
  );
  lines.push("");

  const output = lines.join("\n");
  // T-149-03-01: never persist/return a string that carries a credential shape.
  assertNoSecrets(output, "gating table");
  return output;
}
