// SPDX-License-Identifier: Apache-2.0
/**
 * Log Validation Utility: Post-process structured logs for unexpected issues.
 *
 * Validates Pino structured JSON log output by detecting unexpected error
 * and warning entries, filtering known acceptable patterns (from intentional
 * test-triggered errors), and categorizing issues by severity and subsystem.
 *
 * Works with the existing log-verifier.ts infrastructure for parsing and
 * pattern matching.
 *
 * @module
 */

import { filterLogs, type LogEntry, type LogPattern } from "./log-verifier.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single unexpected log issue found during validation. */
export interface LogIssue {
  severity: "error" | "warn";
  subsystem: string;
  message: string;
  entry: LogEntry;
}

/** Complete report from log validation. */
export interface LogValidationReport {
  totalEntries: number;
  issues: LogIssue[];
  bySubsystem: Record<string, LogIssue[]>;
  bySeverity: Record<string, LogIssue[]>;
  clean: boolean;
}

// ---------------------------------------------------------------------------
// Known acceptable patterns allowlist
// ---------------------------------------------------------------------------

/**
 * Known acceptable error/warning patterns produced by intentional test behavior.
 *
 * Each pattern is documented with the test file and requirement that produces it.
 * These entries are filtered out during validation -- they are expected, not bugs.
 */
const KNOWN_ACCEPTABLE: LogPattern[] = [
  // log-verification.test.ts LOG-03: Intentional invalid RPC call to test error logging
  { level: "warn", msg: /RPC call failed: config\.read/ },

  // log-orchestration.test.ts LOG-06: Intentional invalid RPC call that surfaces
  // at the JSON-RPC method-error level (one layer below the RPC-call failure log).
  { level: "error", msg: /JSON-RPC method error/ },

  // log-verification.test.ts LOG-02: Intentional tool failure to test audit logging
  { msg: /Tool audit: fail-tool failed/ },

  // Test harness exit override artifact from daemon-harness.ts
  { msg: /Daemon exit with code/ },

  // daemon-shutdown.test.ts: Intentional SIGTERM to test graceful shutdown
  { level: "error", msg: /SIGTERM received/ },

  // daemon-shutdown.test.ts: Expected warning during shutdown sequence
  { level: "warn", msg: /Graceful shutdown/ },

  // Agent error path tests: Intentional agent execution failures
  { level: "error", msg: /Agent execution error/ },

  // Circuit breaker tests: Intentional circuit breaker trips
  { level: "warn", msg: /Circuit breaker/ },

  // Budget guard tests: Intentional budget exhaustion
  { level: "warn", msg: /Execution blocked by budget guard/ },

  // RPC adapter catch blocks: Operational failures logged at WARN
  { level: "warn", msg: /^RPC .+ failed$/ },

  // Sandbox CPU kill tests: Intentional sandbox execution timeouts/failures
  { level: "error", msg: /Sandbox execution/ },

  // daemon-config-rejection.test.ts: Intentional invalid config to test rejection
  { level: "error", msg: /Config validation/ },

  // daemon-hotreload.test.ts: Intentional invalid config for hot-reload rejection
  { msg: /Hot-reload rejected/ },

  // ChaosEchoAdapter tests: Intentional fault injection for resilience testing
  { msg: /ChaosEcho/ },

  // All test daemons: dev mode HTTP warning (TLS not configured in test configs)
  { level: "warn", msg: /Gateway starting in dev mode/ },

  // All test daemons: canary secret not configured (test envs don't set COMIS_CANARY_SECRET)
  { level: "warn", msg: /Canary secret not configured/ },

  // All test daemons: TLS not configured (test configs use plain HTTP)
  { level: "warn", msg: /Gateway running without TLS/ },
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate log entries for unexpected error and warning entries.
 *
 * Filters entries for "error" and "warn" levels, checks each against the
 * known acceptable patterns allowlist, and builds a categorized report of
 * any unexpected issues found.
 *
 * @param entries - Parsed log entries from parseLogLines() or getEntries()
 * @returns Validation report with issues categorized by severity and subsystem
 */
export function validateLogs(entries: LogEntry[]): LogValidationReport {
  const issues: LogIssue[] = [];

  // Get all error and warn entries
  const errorEntries = filterLogs(entries, { level: "error" });
  const warnEntries = filterLogs(entries, { level: "warn" });

  for (const entry of [...errorEntries, ...warnEntries]) {
    // Check if this entry matches any known acceptable pattern
    const isKnown = KNOWN_ACCEPTABLE.some(
      (pattern) => filterLogs([entry], pattern).length > 0,
    );
    if (isKnown) continue;

    issues.push({
      severity: entry.level as "error" | "warn",
      subsystem:
        (entry.module as string) || (entry.name as string) || "unknown",
      message: entry.msg,
      entry,
    });
  }

  // Categorize by subsystem
  const bySubsystem: Record<string, LogIssue[]> = {};
  for (const issue of issues) {
    (bySubsystem[issue.subsystem] ??= []).push(issue);
  }

  // Categorize by severity
  const bySeverity: Record<string, LogIssue[]> = {};
  for (const issue of issues) {
    (bySeverity[issue.severity] ??= []).push(issue);
  }

  return {
    totalEntries: entries.length,
    issues,
    bySubsystem,
    bySeverity,
    clean: issues.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

/**
 * Format a log validation report as a human-readable string.
 *
 * Clean reports produce a single-line confirmation.
 * Reports with issues produce a multi-section breakdown by severity and subsystem.
 *
 * @param report - The validation report from validateLogs()
 * @returns Formatted report string
 */
export function formatReport(report: LogValidationReport): string {
  if (report.clean) {
    return `Log validation: CLEAN (${report.totalEntries} entries, 0 unexpected issues)`;
  }

  const lines: string[] = [];

  lines.push("Log Validation Report");
  lines.push("====================");
  lines.push(`Total entries: ${report.totalEntries}`);
  lines.push(`Unexpected issues: ${report.issues.length}`);
  lines.push("");

  // By Severity
  lines.push("By Severity:");
  for (const [severity, issues] of Object.entries(report.bySeverity)) {
    lines.push(`  ${severity} (${issues.length}):`);
    for (const issue of issues) {
      lines.push(`    - [${issue.subsystem}] ${issue.message}`);
    }
  }

  lines.push("");

  // By Subsystem
  lines.push("By Subsystem:");
  for (const [subsystem, issues] of Object.entries(report.bySubsystem)) {
    lines.push(`  ${subsystem} (${issues.length}):`);
    for (const issue of issues) {
      lines.push(`    - [${issue.severity}] ${issue.message}`);
    }
  }

  return lines.join("\n");
}
