// SPDX-License-Identifier: Apache-2.0
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
  /**
   * Phase 10 SC-10-2 (Plan 10-04): numeric seconds until profile expiry.
   *
   * ROADMAP success criterion 2 names this field by name -- exposed as a
   * structured numeric so JSON-format consumers (log aggregators,
   * dashboards) can compare it against thresholds without parsing the
   * human-readable `message` string. Only `oauth-health.ts`
   * `profileExpiryFinding` populates this; all other doctor-check findings
   * leave it undefined. Value is `Math.floor(msUntilExpiry / 1000)`
   * (negative for already-expired profiles to preserve sign-of-direction).
   */
  readonly secsUntilExpiry?: number;
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
  /**
   * Phase 10 SC-10-2 (Plan 10-04): opt-in refresh-test toggle from the
   * `--refresh-test` flag on `comis doctor`. When true, the OAuth health
   * check performs a real refresh against the provider per profile -- a
   * side effect that rotates the refresh token at OpenAI's end (D-10-04-01
   * mandates default OFF; D-10-04-02 mandates --help warns the operator).
   */
  readonly refreshTest?: boolean;
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
