// SPDX-License-Identifier: Apache-2.0
/**
 * Gap-report writer — builds and persists the gap report to the ledger.
 *
 * GapReport.phaseOrder: phases 137–144 sorted by observed red probe count
 * (most-broken first). This is the machine-readable input that later phases
 * consume to reorder/gate their execution.
 *
 * All writes run assertNoSecrets before writeFileSync — Information Disclosure
 * mitigation.
 *
 * @module
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { assertNoSecrets } from "../cost.js";
import { CATEGORY_TO_PHASE } from "./probes.js";
import type { SweepResult, ProbeVerdict } from "./sweep.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GapReport {
  runId: string;
  ts: string;
  git_sha: string;
  probeVerdicts: ProbeVerdict[];
  /** Phases 137–144 reordered by observed red probe count (most-broken first).
   * Phases tied at 0 reds appear last in stable ascending order. */
  phaseOrder: number[];
  summary: { green: number; red: number; skip: number };
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** The depth phases gated by the gap report. */
const DEPTH_PHASES = [137, 138, 139, 140, 141, 142, 143, 144] as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Build a GapReport from a SweepResult. Pure function — no file I/O.
 *
 * phaseOrder derivation:
 *   1. Map each ProbeVerdict.category → phase via CATEGORY_TO_PHASE.
 *   2. Count red verdicts per phase.
 *   3. Sort DEPTH_PHASES descending by red count; ties resolved ascending by
 *      phase number (stable, natural order) — so zero-red phases go last in
 *      137..144 order.
 *
 * @param result  - SweepResult from runSweep().
 * @param gitSha  - Git SHA to embed in the report (short or full).
 */
export function buildGapReport(result: SweepResult, gitSha: string): GapReport {
  // Count red verdicts per phase
  const redCounts: Record<number, number> = {};
  for (const phase of DEPTH_PHASES) {
    redCounts[phase] = 0;
  }
  for (const v of result.verdicts) {
    if (v.status === "red") {
      const phase = CATEGORY_TO_PHASE[v.category];
      if (phase !== undefined && phase in redCounts) {
        redCounts[phase]++;
      }
    }
  }

  // Sort: descending red count, then ascending phase number for stable tie-break
  const phaseOrder = ([...DEPTH_PHASES] as number[]).sort((a, b) => {
    const diff = (redCounts[b] ?? 0) - (redCounts[a] ?? 0);
    return diff !== 0 ? diff : a - b;
  });

  const summary = {
    green: result.verdicts.filter((v) => v.status === "green").length,
    red: result.verdicts.filter((v) => v.status === "red").length,
    skip: result.verdicts.filter((v) => v.status === "skip").length,
  };

  return {
    runId: `sweep-${Date.now()}`,
    ts: result.ranAt,
    git_sha: gitSha,
    probeVerdicts: result.verdicts,
    phaseOrder,
    summary,
  };
}

/**
 * Write the gap report to benchmarks/live/<date>-<sha>/gap-report.json.
 * Runs assertNoSecrets on the serialized JSON before writing — throws on
 * any secret-shaped match.
 *
 * assertNoSecrets prevents credential leakage from verdict reasons
 * into the persisted ledger file.
 *
 * @param result        - SweepResult to persist.
 * @param benchmarksDir - Root directory for ledger entries (repo-root/benchmarks).
 * @param gitSha        - Short git SHA for the ledger directory name. If absent,
 *                        resolved via git rev-parse.
 * @returns             The ledger directory path created.
 */
export function writeGapReport(
  result: SweepResult,
  benchmarksDir: string,
  gitSha?: string,
): string {
  const sha = gitSha ?? getGitSha();
  const report = buildGapReport(result, sha);
  const date = new Date(result.ranAt).toISOString().slice(0, 10);
  // Append a millisecond-precision timestamp suffix to the ledger dir
  // so that same-date same-SHA re-runs produce distinct directories and never
  // silently overwrite a prior run's artifacts. The ranAt field is already
  // an ISO string from Date.now(), so it is unique per-run.
  const ts = new Date(result.ranAt).toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const ledgerDir = resolve(benchmarksDir, `live/${date}-${sha}-${ts}`);
  mkdirSync(ledgerDir, { recursive: true });
  const json = JSON.stringify(report, null, 2);
  // Secret-sweep gate BEFORE writeFileSync — no exception
  assertNoSecrets(json, "gap-report.json");
  writeFileSync(resolve(ledgerDir, "gap-report.json"), json, "utf-8");
  return ledgerDir;
}

/**
 * Write a human-readable gap readiness markdown file.
 * Runs assertNoSecrets on the content before writing.
 *
 * Sections:
 *   - Header + metadata (generated timestamp, git sha, summary counts)
 *   - Phase Priority table (phases 137–144, most-broken first)
 *   - Probe Verdicts table (all verdicts with id, category, status, reason)
 *
 * assertNoSecrets on markdown content before write.
 *
 * @param report      - GapReport to render.
 * @param outputPath  - Absolute path to write the markdown file.
 */
export function writeGapReadiness(report: GapReport, outputPath: string): void {
  const phaseRows = report.phaseOrder.map((p, i) => {
    const redCount = report.probeVerdicts.filter(
      (v) => v.status === "red" && CATEGORY_TO_PHASE[v.category] === p,
    ).length;
    return `| ${i + 1} | Phase ${p} | ${redCount} |`;
  });

  // Sanitize reason before inserting into Markdown table — pipes and
  // newlines in API error messages corrupt the table structure.
  const verdictRows = report.probeVerdicts.map((v) => {
    const safeReason = (v.reason ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    return `| ${v.id} | ${v.category} | ${v.status} | ${safeReason} |`;
  });

  const lines = [
    "# Gap Report",
    "",
    `Generated: ${report.ts}`,
    `Git SHA: ${report.git_sha}`,
    `Summary: ${report.summary.green} green / ${report.summary.red} red / ${report.summary.skip} skip`,
    "",
    "## Phase Priority (137–144, most broken first)",
    "",
    "| Priority | Phase | Red Probes |",
    "|----------|-------|------------|",
    ...phaseRows,
    "",
    "## Probe Verdicts",
    "",
    "| Probe ID | Category | Status | Reason |",
    "|----------|----------|--------|--------|",
    ...verdictRows,
  ];

  const content = lines.join("\n") + "\n";
  // Secret-sweep gate BEFORE writeFileSync — no exception
  assertNoSecrets(content, "gap-readiness.md");
  writeFileSync(outputPath, content, "utf-8");
}
