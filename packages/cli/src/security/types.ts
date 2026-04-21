// SPDX-License-Identifier: Apache-2.0
/**
 * Security audit type system.
 *
 * Defines the core interfaces for security findings, checks,
 * audit context, and audit results. Used by the check runner,
 * individual checks, and output formatters.
 *
 * @module
 */

import type { AppConfig } from "@comis/core";

/** Severity level for a security finding. */
export type Severity = "critical" | "warning" | "info";

/**
 * A single security finding produced by a check.
 *
 * Each finding has a category (which check produced it), severity,
 * human-readable message, remediation advice, a unique code, and
 * an optional filesystem path.
 */
export interface SecurityFinding {
  readonly category: string;
  readonly severity: Severity;
  readonly message: string;
  readonly remediation: string;
  readonly code: string;
  readonly path?: string;
}

/**
 * A security check that can be executed against an audit context.
 *
 * Each check has an ID, human-readable name, and a run function
 * that returns zero or more findings.
 */
export interface SecurityCheck {
  readonly id: string;
  readonly name: string;
  readonly run: (context: AuditContext) => Promise<SecurityFinding[]>;
}

/**
 * Context passed to each security check during an audit.
 *
 * Provides the parsed config (if available), raw config file content,
 * filesystem paths for config files, data directory, and skills paths.
 */
export interface AuditContext {
  readonly config?: AppConfig;
  readonly rawConfigContent?: string;
  readonly configPaths: string[];
  readonly dataDir: string;
  readonly skillsPaths: string[];
}

/**
 * Aggregated result of running all security checks.
 *
 * Includes sorted findings, summary counts, and a passed flag
 * that is true when no critical findings exist.
 */
export interface AuditResult {
  readonly findings: readonly SecurityFinding[];
  readonly checksRun: number;
  readonly criticalCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly passed: boolean;
}
