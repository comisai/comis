// SPDX-License-Identifier: Apache-2.0
/**
 * Per-failure-class gating report.
 *
 * The deliverable that gates the downstream obs-surface build-out. The Stage-C
 * baseline RUN (diagnosis-baseline.test.ts) hands each fixture to a fresh scripted
 * agent on today's obs surface and records a DiagnosisVerdictRow per failure class;
 * this module turns those rows into a per-class trim/build recommendation table:
 *
 *   - A class root-caused in <=1 obs call with 0 source reads is a TRIM-CANDIDATE
 *     (an existing RPC already suffices — a downstream phase may be trimmed, e.g.
 *     "exec ModuleNotFound is already 1-call diagnosable via obs.diagnostics").
 *   - A class that needs source reads (or multi-call) today is BUILD-needed — the
 *     measured cost (reads + calls) is exactly what a new obs surface must drive to zero.
 *   - A judge-skipped class is INCONCLUSIVE (re-run with a key).
 *
 * This is metric-bearing logic (not scaffolding), so it is RED→GREEN unit-tested
 * in diagnosis-gating-report.test.ts (TDD mode) BEFORE the run consumes it.
 *
 * SECURITY: renderGatingMarkdown runs `assertNoSecrets` over its
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
  /** Distinct source files the agent had to read to reach root cause. */
  distinctSourceReads: number;
  /** Distinct tool/RPC names the agent invoked. */
  distinctToolCalls: number;
  /** Total tokens the diagnosis cost. */
  totalTokens: number;
  /** Whether the agent reached the causal mechanism ("skip" when the judge was absent). */
  rootCauseReached: boolean | "skip";
  /**
   * TRUE when the class was root-caused with 0 source reads AND <=1 distinct obs
   * call today — i.e. an existing RPC already suffices, so a downstream phase may
   * be TRIMMED. FALSE when the judge skipped (inconclusive — never a trim) or the
   * class was budget-skipped (never measured — never a trim).
   */
  existingRpcSuffices: boolean;
  /**
   * TRUE when the class was NEVER MEASURED because the cost budget cut it off.
   * A reader must be able to tell this apart from a measured-but-judge-
   * skipped class — the gate is incomplete for this class, not inconclusive.
   */
  notMeasured: boolean;
  /** Human-readable gate signal: NOT MEASURED | TRIM-CANDIDATE | BUILD | INCONCLUSIVE. */
  recommendation: string;
}

/**
 * Marker placed in a {@link DiagnosisVerdictRow}'s `surfacesUsed` by the Stage-C RUN
 * when a fixture was NEVER MEASURED because the cost budget cut it off. A
 * budget-skip is categorically different from a judge-skip (measured, no key): the
 * class produced no data at all, so it must be rendered distinctly and must never be
 * read as a measured-but-inconclusive result.
 */
export const BUDGET_SKIPPED_MARKER = "budget-skipped";

/** True when a row was budget-skipped (never measured) rather than judge-skipped. */
function isBudgetSkipped(row: DiagnosisVerdictRow): boolean {
  return row.surfacesUsed.includes(BUDGET_SKIPPED_MARKER);
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
 *   - budget-skipped (never measured) → "NOT MEASURED (budget-skipped — raise COMIS_LIVE_BUDGET_USD)"
 *   - rootCauseReached === "skip"      → "INCONCLUSIVE (judge skipped — re-run with a key)"
 *   - existingRpcSuffices              → "TRIM-CANDIDATE: <class> is root-caused in <=1 call with 0 source reads today"
 *   - otherwise                        → "BUILD: <class> needs N source reads + M calls today"
 *
 * A budget-skipped row is NEVER a TRIM-CANDIDATE (an unmeasured class cannot trim a
 * downstream phase).
 */
export function buildGatingTable(rows: DiagnosisVerdictRow[]): GatingRow[] {
  return rows.map((row) => {
    const budgetSkipped = isBudgetSkipped(row);
    const existingRpcSuffices =
      !budgetSkipped &&
      row.rootCauseReached === true &&
      row.distinctSourceReads === 0 &&
      row.distinctToolCalls <= 1;

    let recommendation: string;
    if (budgetSkipped) {
      recommendation = `NOT MEASURED (${row.failureClass} was budget-skipped — raise COMIS_LIVE_BUDGET_USD for a complete gate)`;
    } else if (row.rootCauseReached === "skip") {
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
      notMeasured: budgetSkipped,
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
 * line counting TRIM-CANDIDATEs (the reorder/trim signal read before the
 * downstream obs-surface build-out).
 *
 * Runs `assertNoSecrets` over the output before returning (defense-in-depth).
 */
export function renderGatingMarkdown(table: GatingRow[]): string {
  const trimCandidates = table.filter((r) => r.existingRpcSuffices).length;
  const notMeasured = table.filter((r) => r.notMeasured).length;
  const measured = table.length - notMeasured;

  const lines: string[] = [];
  lines.push("# Diagnosis baseline — per-failure-class gating table");
  lines.push("");
  lines.push(
    "The measure-first GATE for phases 150-155. A TRIM-CANDIDATE class is root-caused " +
      "from today's obs surface alone (0 source reads, <=1 call) — its downstream phase " +
      "may be trimmed. A BUILD class shows the source-read + call cost a new surface must " +
      "drive to zero. INCONCLUSIVE = the judge was skipped (re-run with a key). NOT MEASURED " +
      "= the cost budget cut the class off before it ran (raise COMIS_LIVE_BUDGET_USD).",
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
  if (notMeasured > 0) {
    // A partial corpus must NOT be presented as the full gate. Surface the
    // not-measured count loudly so the reorder/trim decision is not made on it.
    lines.push("");
    lines.push(
      `**WARNING — PARTIAL GATE:** only ${measured} of ${table.length} class(es) were measured; ` +
        `${notMeasured} class(es) were NOT measured (budget-skipped). Raise COMIS_LIVE_BUDGET_USD ` +
        "and re-run for a complete gate before reordering/trimming phases 150-155.",
    );
  }
  lines.push("");

  const output = lines.join("\n");
  // Never persist/return a string that carries a credential shape.
  assertNoSecrets(output, "gating table");
  return output;
}
