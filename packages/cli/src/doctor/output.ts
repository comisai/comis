/**
 * Doctor diagnostic output rendering.
 *
 * Provides table and JSON output formatters for doctor results.
 * Table format uses chalk for status coloring with npm-doctor style
 * pass/fail listing. JSON format uses the standard json() helper.
 *
 * @module
 */

import chalk from "chalk";
import type { DoctorResult, DoctorStatus } from "./types.js";
import { json } from "../output/format.js";

/** Map status to a colored icon. */
function statusIcon(status: DoctorStatus): string {
  switch (status) {
    case "pass":
      return chalk.green("v");
    case "fail":
      return chalk.red("X");
    case "warn":
      return chalk.yellow("!");
    case "skip":
      return chalk.gray("-");
  }
}

/**
 * Render doctor results as a formatted table to stdout.
 *
 * Each finding is rendered as a single line with status icon, category,
 * check name, and message. Suggestions are indented below the finding.
 * A summary line is printed at the end.
 *
 * @param result - The aggregated doctor result to render
 */
export function renderDoctorTable(result: DoctorResult): void {
  console.log("");

  if (result.findings.length === 0) {
    console.log(chalk.green("  No findings.\n"));
  } else {
    for (const finding of result.findings) {
      const icon = statusIcon(finding.status);
      const repairable = finding.repairable ? chalk.cyan(" [repairable]") : "";
      console.log(`  ${icon} ${chalk.bold(finding.category)} / ${finding.check}: ${finding.message}${repairable}`);

      if (finding.suggestion) {
        console.log(chalk.gray(`      ${finding.suggestion}`));
      }
    }
  }

  // Summary line
  const parts = [
    `${result.checksRun} checks`,
    chalk.green(`${result.passCount} pass`),
    chalk.red(`${result.failCount} fail`),
    chalk.yellow(`${result.warnCount} warn`),
    chalk.gray(`${result.skipCount} skip`),
  ];
  console.log(`\n  ${parts.join(", ")}.`);

  if (result.repairableCount > 0) {
    console.log(chalk.cyan(`  ${result.repairableCount} repairable. Run with --repair to fix.`));
  }

  console.log("");
}

/**
 * Render doctor results as structured JSON to stdout.
 *
 * Outputs a JSON object with checksRun, summary counts, and findings.
 *
 * @param result - The aggregated doctor result to render
 */
export function renderDoctorJson(result: DoctorResult): void {
  json({
    checksRun: result.checksRun,
    summary: {
      pass: result.passCount,
      fail: result.failCount,
      warn: result.warnCount,
      skip: result.skipCount,
      repairable: result.repairableCount,
    },
    findings: result.findings,
  });
}
