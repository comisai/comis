// SPDX-License-Identifier: Apache-2.0
/**
 * M2 deterministic fleet-gap-gate measurement (Phase 158 — PROVE & gate, M2).
 *
 * THE GATE for Phase 160. A standalone `tsx` one-shot that reads the REAL
 * `~/.comis` READ-ONLY, counts how often each currently-log-only signal recurs
 * (structured `session_summary` rows via the typed `ObservabilityStore`; the
 * log-only candidates via a bounded ONE-TIME `daemon.log` substring scan — the
 * ONLY sanctioned grep, because deciding whether to instrument is its whole
 * purpose), feeds the counts to the Plan-01 scorers, and writes the gap-gate
 * decision in TWO places: the git-ignored machine ledger
 * (`benchmarks/live/<date>-<sha>/`) and the human `158-GAP-GATE.md` the
 * Phase-160 planner reads.
 *
 * RUN:
 *   pnpm build                                  # required: imports the @comis/memory dist
 *   npx tsx scripts/fleet-gate/measure.ts [--since-hours N] [--datadir PATH]
 *
 * It READS the real `~/.comis` READ-ONLY and writes NOTHING to it:
 *  - `memory.db` is opened `{ readonly: true, fileMustExist: true }`.
 *  - it calls NO data-dir writer (no session-index append, no store mutation, no
 *    file write into the data dir); the only persisted writes target `benchmarks/`
 *    + `.planning/`. The Phase-155 no-prod-datadir rule is WRITE-only, and this is
 *    a `scripts/` one-shot (NOT under vitest), so the D9 VITEST branch is moot.
 *  - NO LLM, NO key, NO live-gate flag, NO new env var — the datadir resolves from
 *    `os.homedir()` or the explicit `--datadir` arg only.
 *
 * IMPORT NOTE: `createObservabilityStore` is imported by a DIRECT relative path
 * to the built dist (`../../packages/memory/dist/index.js`) rather than the bare
 * `@comis/memory` specifier — at the repo root only `@comis/core` is symlinked
 * into `node_modules/@comis/`, so a bare `npx tsx` (which has no vitest
 * dist-alias) cannot resolve `@comis/memory`. The direct-dist import is the
 * 149-02 one-off precedent (a direct packages-dist import in a one-off).
 * Requires `pnpm build` first so the dist exists.
 *
 * @module
 */

import Database from "better-sqlite3";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createObservabilityStore } from "../../packages/memory/dist/index.js";
import {
  loadCorpus,
  type FleetSignal,
} from "../../test/live/support/fleet-triage-corpus.js";
import {
  recordSignalRecurrence,
  buildGapGateTable,
  renderGapGateMarkdown,
  type GapGateRow,
} from "../../test/live/support/fleet-recurrence-gate.js";
import { writeLedger, type LiveTestReport } from "../../test/live/report.js";

const __dirnameLocal = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirnameLocal, "../..");
const FIXTURES_DIR = resolve(REPO_ROOT, "test/live/fixtures/fleet-triage");
const GAP_GATE_DOC = resolve(
  REPO_ROOT,
  ".planning/phases/158-prove-gate-fleet-triage-baseline/158-GAP-GATE.md",
);

/**
 * The HOST label embedded in the written artifact is a NON-PII placeholder, NOT
 * `os.hostname()`. A real hostname (e.g. `Moshes-MacBook-Pro-2.local`) is operator
 * PII that slips past `SECRET_PATTERN` (it is not credential-shaped), so it must
 * never be written into a persisted artifact (T-158-03-02).
 */
const HOST_LABEL = "operator-daemon";

// ---------------------------------------------------------------------------
// Arg parsing — no env var (RESEARCH §Secrets/env, A1).
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { sinceHours: number; datadir: string } {
  let sinceHours = 24;
  let datadir = resolve(homedir(), ".comis");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since-hours" && argv[i + 1] !== undefined) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) sinceHours = n;
    } else if (a === "--datadir" && argv[i + 1] !== undefined) {
      datadir = resolve(String(argv[++i]));
    }
  }
  return { sinceHours, datadir };
}

// ---------------------------------------------------------------------------
// The bounded one-time daemon.log scan (the ONLY sanctioned grep).
// ---------------------------------------------------------------------------

/**
 * Count a log-only signal's recurrence as a SUBSTRING count over the rendered
 * Pino lines. Tolerant by construction (Security V5): a substring count over
 * `split("\n")` is line-tolerant — a hostile/malformed WARN body cannot crash
 * the counter, and we never `JSON.parse` a line. Returns 0 (not a throw) when
 * the log file is absent (rotated away / a different machine).
 *
 * Scans BOTH the live `daemon.log` and the rotated `daemon.1.log` when present —
 * the daemon log rotates, and on a lightly-used dev box the current signal may
 * live only in the rotated file (RESEARCH §Environment Availability).
 */
function countLogOnlySignal(logsDir: string, needles: string[]): number {
  let total = 0;
  for (const file of ["daemon.log", "daemon.1.log"]) {
    const path = resolve(logsDir, file);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      continue; // unreadable → count nothing for this file (non-fatal)
    }
    for (const line of text.split("\n")) {
      if (needles.some((n) => line.includes(n))) total += 1;
    }
  }
  return total;
}

/**
 * Per-signal measured recurrence + whether the emitting path was EXERCISED on
 * the measured machine. `pathExercised` is the Pitfall-4 discriminator: a 0 on
 * an EXERCISED path is a confident SKIP, a 0 on an UN-exercised path is
 * INCONCLUSIVE. It is defaulted CONSERVATIVELY — TRUE only with positive
 * evidence the relevant subsystem ran — so a 0 on a FLAGSHIP signal (LCD ×7,
 * MCP churn) yields INCONCLUSIVE, never a false confident SKIP that would gut
 * Phase 160.
 */
interface Measured {
  realCount: number;
  pathExercised: boolean;
}

function measure(datadir: string, sinceHours: number): {
  measured: Map<FleetSignal["signal"], Measured>;
  structuredSummaryCount: number;
  structuredAvailable: boolean;
} {
  const logsDir = resolve(datadir, "logs");
  const measured = new Map<FleetSignal["signal"], Measured>();

  // --- STRUCTURED recurrence (the sanctioned typed path) -------------------
  // session_summary is the ALREADY-STRUCTURED contrast item (queryable today).
  // Wrap the DB open so an absent memory.db degrades to INCONCLUSIVE (non-fatal,
  // RESEARCH §Environment Availability) rather than crashing the gate.
  let structuredSummaryCount = 0;
  let structuredAvailable = false;
  const dbPath = resolve(datadir, "memory.db");
  if (existsSync(dbPath)) {
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const store = createObservabilityStore(db);
      const rows = store.queryDiagnostics({
        category: "session_summary",
        sinceMs: Date.now() - sinceHours * 3_600_000,
      });
      structuredSummaryCount = rows.length;
      structuredAvailable = true;
    } catch (err) {
      console.error(
        `[fleet-gate] structured read skipped (non-fatal): ${err instanceof Error ? err.name : "error"}`,
      );
    } finally {
      db?.close();
    }
  }

  // session-degradation rides the structured surface — alreadyStructured in the
  // corpus → ALWAYS the ALREADY-STRUCTURED verdict regardless of count. We record
  // its measured recurrence (the session_summary row count) for transparency; the
  // verdict function short-circuits on the corpus alreadyStructured flag.
  measured.set("session-degradation", {
    realCount: structuredSummaryCount,
    pathExercised: structuredAvailable,
  });

  // --- LOG-ONLY recurrence (the bounded one-time grep) ---------------------
  // VERIFIED emit strings (RESEARCH §"Code Examples" + re-confirmed on disk):
  //   "LCD ingest skipped: live/store divergence"  -> lcd-ingest.ts:276 (errorKind "precondition")
  //   "LCD leaf pass skipped: ordinal-window divergence" -> lcd-compaction-trigger.ts:398 (the twin)
  //   "reconnect_failed" / "MCP client error"      -> mcp-client-reconnect.ts:379 / :117
  //   "budget_exceeded"                            -> events-infra.ts:622 / aggregator.ts:78
  //   "are not reachable in"                       -> setup-storage-mismatch-warn.ts (config posture findings)
  const lcdCount = countLogOnlySignal(logsDir, [
    "LCD ingest skipped",
    "LCD leaf pass skipped",
  ]);
  const mcpCount = countLogOnlySignal(logsDir, ["reconnect_failed", "MCP client error"]);
  const budgetCount = countLogOnlySignal(logsDir, ["budget_exceeded"]);
  const configCount = countLogOnlySignal(logsDir, ["are not reachable in"]);

  // pathExercised: default FALSE for the log-only candidates unless we have
  // POSITIVE, signal-specific evidence the subsystem ran. We have NO such
  // independent evidence on this measurement (no per-subsystem boot marker is
  // counted), so each log-only candidate is conservatively UN-exercised — a 0
  // therefore resolves to INCONCLUSIVE (NOT a confident SKIP). This is the
  // load-bearing flagship protection: the FLAGSHIP signals (lcd-ingest-skipped,
  // mcp-reconnect) are NEVER written as SKIP-NEVER-RECURS on a 0 count. A positive
  // count (>= RECURRENCE_THRESHOLD) still resolves to INSTRUMENT-160 regardless.
  measured.set("lcd-ingest-skipped", { realCount: lcdCount, pathExercised: false });
  measured.set("mcp-reconnect", { realCount: mcpCount, pathExercised: false });
  measured.set("budget-exceeded", { realCount: budgetCount, pathExercised: false });
  measured.set("config-posture", { realCount: configCount, pathExercised: false });

  // model-health-deferred: native node-llama-cpp stdout is OUT of the milestone
  // (deferred). We do NOT instrument/capture it — the corpus signal name makes the
  // verdict OUT-OF-SCOPE. No measured entry needed (the scorer derives it).

  return { measured, structuredSummaryCount, structuredAvailable };
}

// ---------------------------------------------------------------------------
// The two-place gate artifact.
// ---------------------------------------------------------------------------

/** Map a GateVerdict to the ledger VerdictRow status (machine artifact). */
function ledgerStatus(verdict: GapGateRow["verdict"]): "passed" | "failed" | "skipped" {
  // INSTRUMENT-160 = the gate's positive signal ("build it"); everything else is
  // either already-done, deferred, or not-yet-evidenced — represented as skipped/
  // failed so the machine ledger carries the verdict without implying a test pass.
  if (verdict === "INSTRUMENT-160") return "passed";
  if (verdict === "ALREADY-STRUCTURED" || verdict === "OUT-OF-SCOPE") return "skipped";
  return "failed"; // SKIP-NEVER-RECURS (confident trim) | INCONCLUSIVE (no evidence)
}

/** The human "Findings for Phase 160" section the Phase-160 planner consumes. */
function renderFindings(rows: GapGateRow[], meta: { structuredAvailable: boolean }): string {
  const lines: string[] = [];
  lines.push("## Findings for Phase 160");
  lines.push("");
  lines.push("### Per-signal verdicts");
  lines.push("");
  for (const r of rows) {
    lines.push(`- **${r.signal}** (byHand ${r.byHandCount}, realCount ${r.realCount}) → ${r.verdict}`);
  }
  lines.push("");
  lines.push("### Inherited gaps (SURFACED, not fixed by Phase 158)");
  lines.push("");
  lines.push(
    "1. **`session_summary` rows carry NO `source` field.** The `session:summary` event " +
      "(`events-trajectory.ts:81-92`) and its persisted `obs_diagnostics` row " +
      "(`obs-persistence-wiring.ts:164-183`) omit `source`, so synthetic-exclusion-by-source " +
      "is a NO-OP today. **Phase 159 A2 inherits this gap** — its " +
      "\"synthetic-excluded (`source:'runtime'`)\" requirement must either carry `source` into " +
      "the row or exclude via the session-index join; it cannot filter the row by a `source` " +
      "column that does not exist.",
  );
  lines.push("");
  lines.push(
    "2. **Config posture is only PARTIALLY structured.** `config-audit.jsonl` + the " +
      "`config.observe` audit RPC capture config READS/WRITES (activity), NOT the posture " +
      "FINDINGS (TLS-off / stranded-secret / canary-fallback), which are still log-only Pino " +
      "WARNs (`setup-storage-mismatch-warn.ts`). Phase 160 I3 wants a point-in-time posture " +
      "SNAPSHOT, which neither surface provides today — do not conflate \"config-audit exists\" " +
      "with \"posture findings are queryable\".",
  );
  lines.push("");
  lines.push("### CAVEAT + re-run path");
  lines.push("");
  lines.push(
    `> Measured on \`${HOST_LABEL}\` against the local \`~/.comis\` — a LIGHTLY-USED dev daemon. ` +
      "Recurrence is DATA-DEPENDENT. A realCount of 0 here is INCONCLUSIVE (the emitting path " +
      "was not shown to run), NOT a confident SKIP. **Re-run this script on a production daemon** " +
      "(`npx tsx scripts/fleet-gate/measure.ts --since-hours 168 --datadir <prod ~/.comis>`) for " +
      "high-traffic numbers before trimming any INCONCLUSIVE signal from Phase 160.",
  );
  if (!meta.structuredAvailable) {
    lines.push("");
    lines.push(
      "> NOTE: `memory.db` was absent/unreadable on this run — the structured " +
        "(`session_summary`) count is INCONCLUSIVE, not 0-by-evidence.",
    );
  }
  lines.push("");
  lines.push("### Flagship-signal protection (Pitfall 4)");
  lines.push("");
  lines.push(
    "The milestone's FLAGSHIP signals — **lcd-ingest-skipped** (×7 by hand) and " +
      "**mcp-reconnect** (MCP churn) — DEFAULT TO INSTRUMENT-160 absent POSITIVE never-recurs " +
      "evidence. A 0 count on this light dev daemon resolves to INCONCLUSIVE (an un-exercised " +
      "path), never SKIP-NEVER-RECURS — a false confident-SKIP on a flagship signal would gut " +
      "Phase 160's ingestion track. Where a flagship signal shows INCONCLUSIVE below, Phase 160 " +
      "should treat it as INSTRUMENT unless a production re-run positively shows it never fires " +
      "when its path is exercised.",
  );
  lines.push("");
  lines.push("### Out-of-scope");
  lines.push("");
  lines.push(
    "- **model-health-deferred** (native node-llama-cpp embedding-tokenizer stdout) is OUT of " +
      "the milestone (deferred). This gate marks it OUT-OF-SCOPE and does NOT instrument or " +
      "capture the native stdout line.",
  );
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(): void {
  const { sinceHours, datadir } = parseArgs(process.argv.slice(2));

  // FAIL LOUDLY on a genuine error (e.g. the corpus is missing — a broken
  // checkout). The corpus is a committed artifact; its absence is fatal.
  const corpus = loadCorpus(FIXTURES_DIR);

  const { measured, structuredSummaryCount, structuredAvailable } = measure(datadir, sinceHours);

  // The Plan-01 scorers own the verdict logic. recordSignalRecurrence builds the
  // raw rows; buildGapGateTable normalizes/recomputes (row-in → row-out). The
  // FLAGSHIP-protection invariant — a flagship signal is NEVER post-processed down
  // to SKIP-NEVER-RECURS on a 0 count — holds because we pass pathExercised:false
  // for the log-only candidates and the verdict function returns INCONCLUSIVE (not
  // SKIP) on realCount=0 + !pathExercised. We deliberately do NOT post-process the
  // rows here.
  const rows = buildGapGateTable(recordSignalRecurrence(corpus.signals, measured));

  // Defense-in-depth assertion of the flagship invariant (Pitfall 4): assert no
  // flagship signal landed on a confident SKIP. (renderGapGateMarkdown also sweeps
  // for secrets; this guards the GATE INTEGRITY contract.)
  for (const r of rows) {
    if (
      (r.signal === "lcd-ingest-skipped" || r.signal === "mcp-reconnect") &&
      r.realCount === 0 &&
      r.verdict === "SKIP-NEVER-RECURS"
    ) {
      throw new Error(
        `[fleet-gate] GATE-INTEGRITY violation: flagship signal '${r.signal}' was marked ` +
          "SKIP-NEVER-RECURS on a 0 count — must be INCONCLUSIVE (Pitfall 4).",
      );
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const table = renderGapGateMarkdown(rows, { host: HOST_LABEL, date, sinceHours });

  // --- machine artifact: the git-ignored ledger ---------------------------
  const report: LiveTestReport = {
    runId: `fleet-gate-${Date.now()}`,
    ts: new Date().toISOString(),
    git_sha: "unknown", // writeLedger resolves the real short SHA
    mode: "fleet-gate",
    budget_usd: 0,
    total_cost_usd: 0,
    verdicts: rows.map((r) => ({
      scenarioId: r.signal,
      status: ledgerStatus(r.verdict),
      reason: r.verdict,
      costUsd: 0,
    })),
  };
  const ledgerDir = writeLedger(report, resolve(REPO_ROOT, "benchmarks")); // assertNoSecrets inside
  const tableDoc = `${table}\n${renderFindings(rows, { structuredAvailable })}`;
  // The rendered table already passed assertNoSecrets inside renderGapGateMarkdown;
  // the findings section carries only signal names + the placeholder host. Write it
  // to the ledger as a second sweep point (the file-write side of the residency
  // rule). writeFileSync here targets ONLY benchmarks/ — never the data dir.
  writeFileSync(resolve(ledgerDir, "gap-gate-table.md"), tableDoc, "utf-8");

  // --- human artifact: the .planning/ doc (git-ignored; Phase-160 planner reads) -
  // NEVER `git add -f` this file. writeFileSync targets ONLY .planning/ — never the
  // data dir.
  mkdirSync(dirname(GAP_GATE_DOC), { recursive: true });
  writeFileSync(GAP_GATE_DOC, tableDoc, "utf-8");

  // --- console summary -----------------------------------------------------
  const instrument = rows.filter((r) => r.verdict === "INSTRUMENT-160");
  const inconclusive = rows.filter((r) => r.verdict === "INCONCLUSIVE");
  console.log(
    [
      "Fleet gap-gate (M2) — measured READ-ONLY against the real ~/.comis",
      `  window: ${sinceHours}h   datadir: ${datadir === resolve(homedir(), ".comis") ? "~/.comis" : datadir}`,
      `  structured session_summary rows: ${structuredAvailable ? structuredSummaryCount : "INCONCLUSIVE (memory.db absent)"}`,
      ...rows.map((r) => `  - ${r.signal.padEnd(22)} realCount=${String(r.realCount).padStart(3)}  ${r.verdict}`),
      `  -> ${instrument.length} INSTRUMENT-160, ${inconclusive.length} INCONCLUSIVE`,
      `  ledger:  ${ledgerDir}/gap-gate-table.md`,
      `  gate doc: ${GAP_GATE_DOC}`,
    ].join("\n"),
  );
}

main();
