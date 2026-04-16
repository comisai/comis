/**
 * Doctor diagnostic type system.
 *
 * Defines the core interfaces for health check findings, checks,
 * diagnostic context, and aggregated results. Used by the check runner,
 * individual checks, repair modules, and output formatters.
 *
 * @module
 */

import type { AppConfig } from "@comis/core";

/** Status of a single doctor finding. */
export type DoctorStatus = "pass" | "fail" | "warn" | "skip";

/**
 * A single finding produced by a doctor check.
 *
 * Each finding has a category, check name, status, human-readable message,
 * optional suggestion, and whether it can be auto-repaired.
 */
export interface DoctorFinding {
  readonly category: string;
  readonly check: string;
  readonly status: DoctorStatus;
  readonly message: string;
  readonly suggestion?: string;
  readonly repairable: boolean;
}

/**
 * A doctor check that can be executed against a diagnostic context.
 *
 * Each check has an ID, human-readable name, and a run function
 * that returns zero or more findings.
 */
export interface DoctorCheck {
  readonly id: string;
  readonly name: string;
  readonly run: (context: DoctorContext) => Promise<DoctorFinding[]>;
}

/**
 * Context passed to each doctor check during diagnostics.
 *
 * Provides the parsed config (if available), config file paths,
 * data directory, daemon PID file path, and optional gateway URL.
 */
export interface DoctorContext {
  readonly config?: AppConfig;
  readonly configPaths: string[];
  readonly dataDir: string;
  readonly daemonPidFile: string;
  readonly gatewayUrl?: string;
}

/**
 * Aggregated result of running all doctor checks.
 *
 * Includes all findings in check order, summary counts by status,
 * and a count of findings that can be auto-repaired.
 */
export interface DoctorResult {
  readonly findings: readonly DoctorFinding[];
  readonly checksRun: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly warnCount: number;
  readonly skipCount: number;
  readonly repairableCount: number;
}
