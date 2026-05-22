// SPDX-License-Identifier: Apache-2.0
/**
 * Security audit output rendering.
 *
 * Provides table and JSON output formatters for audit results.
 * Table output is delegated to the shared `renderFindings` helper in
 * `util/render-findings.ts`; JSON output uses the standard json() helper.
 *
 * @module
 */

import type { AuditResult } from "./types.js";
import { json } from "../output/format.js";
import {
  renderFindings,
  type NormalizedFinding,
  type NormalizedStatus,
} from "../util/render-findings.js";

/**
 * Map a security `Severity` to the unified `NormalizedStatus`.
 *
 * `"warning"` collapses to `"warn"`; `"critical"` and `"info"` carry through
 * 1:1. The renderer's status-icon switch covers all 6 NormalizedStatus values.
 */
function severityToStatus(severity: AuditResult["findings"][number]["severity"]): NormalizedStatus {
  return severity === "warning" ? "warn" : severity;
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
  const findings: NormalizedFinding[] = result.findings.map((f) => ({
    status: severityToStatus(f.severity),
    category: f.category,
    title: f.code,
    message: f.message,
    hint: f.remediation,
    badge: f.path ? `path=${f.path}` : undefined,
  }));

  const summary = {
    total: result.checksRun,
    counts: {
      critical: result.criticalCount,
      warning: result.warningCount,
      info: result.infoCount,
    },
    footer: result.passed
      ? "Audit PASSED (no critical findings)"
      : "Audit FAILED (critical findings detected)",
  };

  renderFindings(
    { kind: "findings", findings, summary },
    { renderMode: "table" },
  );
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
