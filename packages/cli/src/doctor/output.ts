// SPDX-License-Identifier: Apache-2.0
/**
 * Doctor diagnostic output rendering.
 *
 * Provides table and JSON output formatters for doctor results.
 * Table output is delegated to the shared `renderFindings` helper in
 * `util/render-findings.ts`; JSON output uses the standard json() helper.
 *
 * @module
 */

import type { DoctorResult } from "./types.js";
import { json } from "../output/format.js";
import {
  renderFindings,
  type NormalizedFinding,
} from "../util/render-findings.js";

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
  const findings: NormalizedFinding[] = result.findings.map((f) => ({
    status: f.status,
    category: f.category,
    title: f.check,
    message: f.message,
    hint: f.suggestion,
    badge: f.repairable ? "[repairable]" : undefined,
  }));

  const summary = {
    total: result.checksRun,
    counts: {
      pass: result.passCount,
      fail: result.failCount,
      warn: result.warnCount,
      skip: result.skipCount,
    },
    footer:
      result.repairableCount > 0
        ? `${result.repairableCount} repairable. Run with --repair to fix.`
        : undefined,
  };

  renderFindings(
    { kind: "findings", findings, summary },
    { renderMode: "compact" },
  );
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
