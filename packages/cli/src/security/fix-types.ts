/**
 * Remediation type system for security fix actions.
 *
 * Defines the interfaces for remediation actions (dry-run preview + apply)
 * and aggregated fix results (applied, skipped, failed).
 *
 * @module
 */

import type { Result } from "@comis/shared";

/**
 * A single remediation action that can preview or apply a fix.
 *
 * Each action corresponds to a security finding and provides:
 * - A human-readable description of what will be fixed
 * - A preview string for dry-run output
 * - An async apply function that executes the fix
 */
export interface RemediationAction {
  /** Finding code this action remediates (e.g., "SEC-PERM-001"). */
  readonly code: string;
  /** Human-readable description of what will be done. */
  readonly description: string;
  /** Dry-run preview output (e.g., "chmod 600 /path/to/file"). */
  preview(): string;
  /** Execute the fix. Returns description of what changed on success, or Error on failure. */
  apply(): Promise<Result<string, Error>>;
}

/**
 * Aggregated result from running security fixes.
 *
 * Separates actions into applied (succeeded), skipped (dry-run or advisory),
 * and failed (error during apply) categories.
 */
export interface FixResult {
  /** Actions that were successfully applied. */
  readonly applied: RemediationAction[];
  /** Actions that were skipped (dry-run mode or advisory-only). */
  readonly skipped: RemediationAction[];
  /** Actions that failed during apply, with the error. */
  readonly failed: ReadonlyArray<{ action: RemediationAction; error: Error }>;
  /** Path to config backup, if one was created. */
  readonly backupPath?: string;
}
