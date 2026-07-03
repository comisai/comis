// SPDX-License-Identifier: Apache-2.0
/**
 * Pure recurrence/gate scorer — the TDD core of the fleet-triage baseline gate.
 *
 * The deliverable that gates the downstream instrument/trim decision (the reorder/trim
 * signal). The measurement reads the real `~/.comis` (read-only) and counts how often each
 * currently-log-only signal recurs; this module turns those counts into a per-signal
 * INSTRUMENT/SKIP verdict table: a signal that recurs enough is worth instrumenting;
 * one that never fires is not ("don't event a WARN that never fires").
 *
 * This is metric-bearing logic (not scaffolding), so it is RED→GREEN unit-tested in
 * fleet-recurrence-gate.test.ts (TDD mode) BEFORE the script consumes it — the EXACT
 * analog of diagnosis-gating-report.ts (GatingRow + buildGatingTable +
 * renderGatingMarkdown), MINUS the LLM-judge apparatus: this gate spends zero tokens, so
 * there is NO CostGovernor, NO judgeAnswer, NO COMIS_LIVE gate.
 *
 * THE LOAD-BEARING DISTINCTION: a `realCount === 0`
 * is NOT automatically a confident SKIP. It is a CONFIDENT SKIP (SKIP-NEVER-RECURS)
 * only when the emitting code path was EXERCISED but the WARN never fired; otherwise it
 * is INCONCLUSIVE (0 observed because the path was never hit on this light dev machine
 * — NOT evidence it never recurs). A false confident-SKIP on the flagship
 * signal (LCD ×7) would silently gut the downstream instrumentation — so the two cases
 * produce DIFFERENT verdicts. The measured dev `~/.comis` is light (LCD=0, budget=0), so
 * this guard is what stops the gate from trimming the whole signal set on a false negative.
 *
 * SECURITY: renderGapGateMarkdown runs `assertNoSecrets` over its output
 * before returning — defense-in-depth. The table carries only counts / signal names /
 * typed verdicts (never raw WARN bodies), but the residency rule is applied uniformly
 * to every persisted-bound string. The secret-sweep lives in cost.ts and is imported,
 * never re-implemented (DRY).
 *
 * @module
 */

import { assertNoSecrets } from "../cost.js";
import type { FleetSignal } from "./fleet-triage-corpus.js";

/**
 * Closed gate-verdict union (never a bare `string`):
 *   - INSTRUMENT-160     — recurs enough in real data → worth instrumenting.
 *   - SKIP-NEVER-RECURS  — CONFIDENT skip: emitting path exercised, WARN never fired.
 *   - ALREADY-STRUCTURED — already queryable cross-session (session_summary/billing) — a contrast item.
 *   - OUT-OF-SCOPE       — deferred (model-health native stdout) — noted, never scored.
 *   - INCONCLUSIVE       — 0 observed because the path wasn't hit (NOT a confident SKIP).
 */
export type GateVerdict =
  | "INSTRUMENT-160"
  | "SKIP-NEVER-RECURS"
  | "ALREADY-STRUCTURED"
  | "OUT-OF-SCOPE"
  | "INCONCLUSIVE";

/**
 * One row of the gap-gate table — a per-signal verdict on whether the downstream work
 * should instrument it. Carries only counts / a signal name / a typed verdict — no raw
 * WARN bodies — so JSON.stringify(row) and the rendered markdown pass assertNoSecrets.
 */
export interface GapGateRow {
  signal: FleetSignal["signal"];
  /** What the by-hand review found — the reference count from the corpus. */
  byHandCount: number;
  /** Measured recurrence in the REAL `~/.comis`. */
  realCount: number;
  /** realCount >= RECURRENCE_THRESHOLD. */
  recurs: boolean;
  /** Queryable cross-session today? (true → ALREADY-STRUCTURED contrast item). */
  alreadyStructured: boolean;
  /** Did the emitting code path run on the measured machine? (the confident-SKIP discriminator). */
  pathExercised: boolean;
  /** The deterministic gate verdict. */
  verdict: GateVerdict;
}

/**
 * Recurrence threshold — a candidate "recurs enough to instrument" at >= this many
 * occurrences in the measured window. A LOW named constant because this
 * machine's data is light (~5 mcp lines / the ×7 LCD by-hand); the operator can
 * override it when re-running on a busier production daemon for high-traffic numbers.
 */
export const RECURRENCE_THRESHOLD = 3;

/**
 * The deterministic verdict function — the load-bearing confident-SKIP distinction.
 *
 * Order matters: OUT-OF-SCOPE and ALREADY-STRUCTURED short-circuit BEFORE the count is
 * consulted (a deferred / already-structured signal is never instrumented regardless of
 * count). Only then does recurrence decide: >= threshold → INSTRUMENT-160; otherwise a 0
 * is a CONFIDENT SKIP iff the path was exercised, else INCONCLUSIVE.
 */
function verdict(r: {
  realCount: number;
  alreadyStructured: boolean;
  outOfScope: boolean;
  pathExercised: boolean;
}): GateVerdict {
  if (r.outOfScope) return "OUT-OF-SCOPE"; // model-health native stdout (deferred — NOT scored)
  if (r.alreadyStructured) return "ALREADY-STRUCTURED"; // session_summary/billing — contrast items
  if (r.realCount >= RECURRENCE_THRESHOLD) return "INSTRUMENT-160";
  // 0 (or sub-threshold) + exercised = confident SKIP; 0 + un-exercised = INCONCLUSIVE.
  return r.pathExercised ? "SKIP-NEVER-RECURS" : "INCONCLUSIVE";
}

/** True for the signals deferred OUT of scope (native node-llama-cpp stdout). */
function isOutOfScope(signal: FleetSignal["signal"]): boolean {
  return signal === "model-health-deferred";
}

/**
 * Map corpus signals + measured recurrence counts into raw {@link GapGateRow}s.
 *
 * For each corpus signal, look up its measured `{ realCount, pathExercised, outOfScope? }`
 * (a MISSING entry defaults to realCount 0 / pathExercised false → INCONCLUSIVE, never a
 * crash — the tolerant-counter rule, mirroring diagnosis-harness.ts
 * recordMetrics skip-not-throw on untrusted input). `model-health-deferred` is ALWAYS
 * out-of-scope. The verdict + recurs flags are computed here; buildGapGateTable
 * normalizes/recomputes them so the verdict logic is also unit-testable on a raw row.
 */
export function recordSignalRecurrence(
  corpus: FleetSignal[],
  measured: Map<
    FleetSignal["signal"],
    { realCount: number; pathExercised: boolean; outOfScope?: boolean }
  >,
): GapGateRow[] {
  return corpus.map((sig) => {
    const m = measured.get(sig.signal);
    const realCount = m?.realCount ?? 0;
    const pathExercised = m?.pathExercised ?? false;
    const outOfScope = isOutOfScope(sig.signal) || (m?.outOfScope ?? false);
    return {
      signal: sig.signal,
      byHandCount: sig.byHandCount,
      realCount,
      recurs: realCount >= RECURRENCE_THRESHOLD,
      alreadyStructured: sig.alreadyStructured,
      pathExercised,
      verdict: verdict({ realCount, alreadyStructured: sig.alreadyStructured, outOfScope, pathExercised }),
    };
  });
}

/**
 * Normalize a set of raw {@link GapGateRow}s: recompute `recurs` and `verdict` from the
 * row's inputs (realCount / alreadyStructured / pathExercised / signal) so the verdict
 * logic is exercised on a row-in → row-out boundary (mirroring the
 * buildGatingTable(rows)→rows signature). Idempotent: feeding rows from
 * recordSignalRecurrence back through this yields identical verdicts.
 *
 * `outOfScope` is re-derived from the signal name (model-health-deferred) — a row never
 * needs to carry a separate flag.
 */
export function buildGapGateTable(rows: GapGateRow[]): GapGateRow[] {
  return rows.map((row) => {
    const outOfScope = isOutOfScope(row.signal);
    return {
      ...row,
      recurs: row.realCount >= RECURRENCE_THRESHOLD,
      verdict: verdict({
        realCount: row.realCount,
        alreadyStructured: row.alreadyStructured,
        outOfScope,
        pathExercised: row.pathExercised,
      }),
    };
  });
}

/**
 * Render the gap-gate table as markdown: a title, a data-scoped CAVEAT block, one row
 * per signal, and a summary line counting INSTRUMENT-160 verdicts (the reorder/trim
 * signal the downstream planner reads).
 *
 * The CAVEAT block (the WARNING-PARTIAL-GATE analog in diagnosis-gating-report.ts)
 * makes the gate's data-dependence explicit: a 0 on a lightly-used dev daemon is
 * INCONCLUSIVE, not a confident SKIP — re-run on production for high-traffic numbers.
 *
 * Runs `assertNoSecrets` over the output before returning (defense-in-depth — the
 * residency rule applied to every persisted-bound string).
 */
export function renderGapGateMarkdown(
  rows: GapGateRow[],
  meta: { host: string; date: string; sinceHours: number },
): string {
  const instrumentCount = rows.filter((r) => r.verdict === "INSTRUMENT-160").length;
  const inconclusiveCount = rows.filter((r) => r.verdict === "INCONCLUSIVE").length;

  const lines: string[] = [];
  lines.push("# Fleet gap-gate (Phase 158) — the GATE for Phase 160");
  lines.push("");
  lines.push(
    `> CAVEAT: measured on ${meta.host} @ ${meta.date}, window ${meta.sinceHours}h. ` +
      "Recurrence is DATA-DEPENDENT — a 0 on this lightly-used dev daemon is INCONCLUSIVE, " +
      "not a confident SKIP. Re-run on a production daemon for high-traffic numbers.",
  );
  lines.push("");
  lines.push("| signal | byHand | realCount | recurs | structured | verdict |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of rows) {
    lines.push(
      `| ${r.signal} | ${r.byHandCount} | ${r.realCount} | ${r.recurs ? "yes" : "no"} | ` +
        `${r.alreadyStructured ? "yes" : "no"} | ${r.verdict} |`,
    );
  }
  lines.push("");
  lines.push(
    `**Summary:** ${instrumentCount} INSTRUMENT-160 verdict(s) of ${rows.length} signal(s) — ` +
      "these are the log-only signals Phase 160 should instrument.",
  );
  if (inconclusiveCount > 0) {
    // An INCONCLUSIVE is NOT a confident SKIP. Surface the count so the
    // reorder/trim decision is not made on absence-of-evidence from a light daemon.
    lines.push("");
    lines.push(
      `**NOTE — INCONCLUSIVE:** ${inconclusiveCount} signal(s) showed 0 occurrences on an ` +
        "un-exercised path — this is INCONCLUSIVE, not a confident SKIP. Re-run on a busier " +
        "daemon before trimming these from Phase 160.",
    );
  }
  lines.push("");

  const output = lines.join("\n");
  // Never persist/return a string that carries a credential shape.
  assertNoSecrets(output, "gap-gate table");
  return output;
}
