/**
 * Security audit check runner.
 *
 * Executes security checks sequentially for deterministic ordering,
 * catches errors from individual checks to prevent runner crashes,
 * and aggregates findings sorted by severity.
 *
 * @module
 */

import type { SecurityCheck, SecurityFinding, AuditContext, AuditResult, Severity } from "./types.js";

/** Numeric priority for severity sorting (lower = higher priority). */
const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * Run all security checks sequentially and aggregate findings.
 *
 * Each check is wrapped in try/catch: if a check throws, a single
 * warning finding is produced with code "SEC-CHECK-ERROR" instead
 * of crashing the entire audit.
 *
 * Findings are sorted by severity (critical first), then by category
 * for stable output ordering.
 *
 * @param checks - Array of security checks to execute
 * @param context - Audit context with config, paths, etc.
 * @returns Aggregated audit result with sorted findings and summary counts
 */
export async function runSecurityAudit(
  checks: SecurityCheck[],
  context: AuditContext,
): Promise<AuditResult> {
  const allFindings: SecurityFinding[] = [];

  // Execute checks sequentially (not Promise.all) for deterministic ordering
  for (const check of checks) {
    try {
      const findings = await check.run(context);
      allFindings.push(...findings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      allFindings.push({
        category: check.id,
        severity: "warning",
        message: `Check "${check.name}" failed: ${message}`,
        remediation: "Investigate why this check could not complete",
        code: "SEC-CHECK-ERROR",
      });
    }
  }

  // Sort by severity (critical first), then by category for stable ordering
  allFindings.sort((a, b) => {
    const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severityDiff !== 0) return severityDiff;
    return a.category.localeCompare(b.category);
  });

  const criticalCount = allFindings.filter((f) => f.severity === "critical").length;
  const warningCount = allFindings.filter((f) => f.severity === "warning").length;
  const infoCount = allFindings.filter((f) => f.severity === "info").length;

  return {
    findings: allFindings,
    checksRun: checks.length,
    criticalCount,
    warningCount,
    infoCount,
    passed: criticalCount === 0,
  };
}
