/**
 * Security audit output rendering.
 *
 * Provides table and JSON output formatters for audit results.
 * Table format uses chalk for severity coloring; JSON format
 * uses the standard json() output helper.
 *
 * @module
 */

import chalk from "chalk";
import type { AuditResult, Severity } from "./types.js";
import { renderTable } from "../output/table.js";
import { json } from "../output/format.js";

/** Map severity to a colored display string. */
function colorSeverity(severity: Severity): string {
  switch (severity) {
    case "critical":
      return chalk.red.bold("CRITICAL");
    case "warning":
      return chalk.yellow("WARNING");
    case "info":
      return chalk.blue("INFO");
  }
}

/** Map severity to an icon. */
function severityIcon(severity: Severity): string {
  switch (severity) {
    case "critical":
      return chalk.red("X");
    case "warning":
      return chalk.yellow("!");
    case "info":
      return chalk.blue("i");
  }
}

/**
 * Render audit results as a formatted table to stdout.
 *
 * Displays findings with severity-colored icons, category, message,
 * and remediation. Prints a summary line below the table.
 *
 * @param result - The aggregated audit result to render
 */
export function renderAuditTable(result: AuditResult): void {
  if (result.findings.length === 0) {
    console.log(chalk.green("\n  No security findings.\n"));
  } else {
    const rows = result.findings.map((f) => [
      severityIcon(f.severity),
      colorSeverity(f.severity),
      f.category,
      f.message,
      f.remediation,
    ]);

    renderTable(["", "Severity", "Category", "Message", "Remediation"], rows);
  }

  // Summary line
  const parts = [
    `${result.checksRun} checks run`,
    chalk.red.bold(`${result.criticalCount} critical`),
    chalk.yellow(`${result.warningCount} warnings`),
    chalk.blue(`${result.infoCount} info`),
  ];
  console.log(`\n  ${parts.join(", ")}`);

  if (result.passed) {
    console.log(chalk.green("  Audit PASSED (no critical findings)\n"));
  } else {
    console.log(chalk.red.bold("  Audit FAILED (critical findings detected)\n"));
  }
}

/**
 * Render audit results as structured JSON to stdout.
 *
 * Outputs a JSON object with checksRun, passed, summary counts,
 * and the full findings array.
 *
 * @param result - The aggregated audit result to render
 */
export function renderAuditJson(result: AuditResult): void {
  json({
    checksRun: result.checksRun,
    passed: result.passed,
    summary: {
      critical: result.criticalCount,
      warning: result.warningCount,
      info: result.infoCount,
    },
    findings: result.findings,
  });
}
