// SPDX-License-Identifier: Apache-2.0
/**
 * Report writer — creates .test-live-report.json, append-only ledger
 * under benchmarks/live/<date>-<sha>/, and READINESS.md.
 *
 * All three write paths run assertNoSecrets before any writeFileSync —
 * an Information Disclosure mitigation: the secret-sweep on the serialized JSON
 * prevents credential leakage into persisted artifacts.
 *
 * @module
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { assertNoSecrets } from "./cost.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerdictStatus = "passed" | "failed" | "skipped";

export interface VerdictRow {
  scenarioId: string;
  status: VerdictStatus;
  reason?: string;
  costUsd: number;
  provider?: string;
  modelSnapshot?: string;
}

export type CategoryVerdict =
  | "CERTIFIED"
  | "PARTIAL"
  | "BLOCKED"
  | `SKIPPED(${string})`;

export interface LiveTestReport {
  runId: string;
  ts: string;
  git_sha: string;
  mode: string;
  budget_usd: number;
  total_cost_usd: number;
  verdicts: VerdictRow[];
}

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
// Exported writers
// ---------------------------------------------------------------------------

/**
 * Write a live-test report to the given output path as JSON.
 * Runs assertNoSecrets before writing — throws if any secret-shaped
 * string is found in the serialized report.
 *
 * assertNoSecrets prevents credential leakage.
 */
export function writeReport(report: LiveTestReport, outputPath: string): void {
  const json = JSON.stringify(report, null, 2);
  assertNoSecrets(json, ".test-live-report.json");
  writeFileSync(outputPath, json, "utf-8");
}

/**
 * Write an append-only ledger entry for the given report.
 * Creates benchmarks/live/<date>-<sha>/report.json.
 * Runs assertNoSecrets before writing.
 *
 * @param report - The live test report to persist
 * @param benchmarksDir - Root directory for ledger entries (typically repo-root/benchmarks)
 * @returns The ledger directory path created
 *
 * assertNoSecrets prevents credential leakage into the ledger.
 */
export function writeLedger(
  report: LiveTestReport,
  benchmarksDir: string,
): string {
  const date = new Date().toISOString().slice(0, 10);
  const sha = report.git_sha !== "unknown" ? report.git_sha : getGitSha();
  const ledgerDir = resolve(benchmarksDir, `live/${date}-${sha}`);
  mkdirSync(ledgerDir, { recursive: true });
  const reportPath = resolve(ledgerDir, "report.json");
  const json = JSON.stringify(report, null, 2);
  assertNoSecrets(json, "ledger report");
  writeFileSync(reportPath, json, "utf-8");
  return ledgerDir;
}

/**
 * Write a READINESS.md file with per-category verdicts.
 * Runs assertNoSecrets before writing.
 *
 * assertNoSecrets on READINESS.md content before write.
 */
export function writeReadiness(
  categoryVerdicts: Record<string, CategoryVerdict>,
  outputPath: string,
): void {
  const lines = [
    "# READINESS.md",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Category Verdicts",
    "",
    "| Category | Verdict |",
    "|----------|---------|",
    ...Object.entries(categoryVerdicts).map(
      ([cat, verdict]) => `| ${cat} | ${verdict} |`,
    ),
  ];
  const content = lines.join("\n") + "\n";
  assertNoSecrets(content, "READINESS.md");
  writeFileSync(outputPath, content, "utf-8");
}
