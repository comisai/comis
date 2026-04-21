// SPDX-License-Identifier: Apache-2.0
/**
 * Doctor check runner.
 *
 * Executes doctor checks sequentially for deterministic ordering,
 * catches errors from individual checks to prevent runner crashes,
 * and aggregates findings with summary counts.
 *
 * @module
 */

import type { DoctorCheck, DoctorContext, DoctorResult } from "./types.js";

/**
 * Run all doctor checks sequentially and aggregate findings.
 *
 * Each check is wrapped in try/catch: if a check throws, a single
 * "skip" finding is produced instead of crashing the entire diagnostic run.
 *
 * Findings are returned in check execution order (no severity sorting).
 *
 * @param checks - Array of doctor checks to execute
 * @param context - Diagnostic context with config, paths, etc.
 * @returns Aggregated doctor result with findings and summary counts
 */
export async function runDoctorChecks(
  checks: DoctorCheck[],
  context: DoctorContext,
): Promise<DoctorResult> {
  const allFindings: DoctorResult["findings"][number][] = [];

  // Execute checks sequentially (not Promise.all) for deterministic ordering
  for (const check of checks) {
    try {
      const findings = await check.run(context);
      allFindings.push(...findings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      allFindings.push({
        category: check.id,
        check: check.name,
        status: "skip",
        message: `Check failed: ${message}`,
        repairable: false,
      });
    }
  }

  const passCount = allFindings.filter((f) => f.status === "pass").length;
  const failCount = allFindings.filter((f) => f.status === "fail").length;
  const warnCount = allFindings.filter((f) => f.status === "warn").length;
  const skipCount = allFindings.filter((f) => f.status === "skip").length;
  const repairableCount = allFindings.filter((f) => f.repairable).length;

  return {
    findings: allFindings,
    checksRun: checks.length,
    passCount,
    failCount,
    warnCount,
    skipCount,
    repairableCount,
  };
}
