/**
 * Security fix runner.
 *
 * Collects remediation actions from all fix creators, then either
 * previews them (dry-run) or applies them sequentially with config
 * backup support.
 *
 * @module
 */

import { copyFileSync, existsSync } from "node:fs";
import type { AuditResult } from "./types.js";
import type { RemediationAction, FixResult } from "./fix-types.js";
import { createPermissionFixes } from "./fixes/fix-permissions.js";
import { createSecretsFixes } from "./fixes/fix-secrets.js";
import { createConfigFixes } from "./fixes/fix-config.js";

/**
 * Create a simple timestamped backup of a file.
 *
 * Copies the source to `{path}.backup.{timestamp}`.
 * Returns the backup path on success, null on failure.
 *
 * Note: createTimestampedBackup from @comis/core is not exported
 * from the main entry point, so we use a local helper matching the
 * pattern established in repair-config.ts.
 */
function createBackup(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "")
      .replace("T", "T")
      .slice(0, 15) + "Z";
    const backupPath = `${filePath}.backup.${timestamp}`;
    copyFileSync(filePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

/**
 * Options for the security fix runner.
 */
export interface FixOptions {
  /** If true, apply fixes. If false (default), dry-run preview only. */
  readonly apply: boolean;
}

/**
 * Run security fixes based on audit results.
 *
 * 1. Collects remediation actions from all fix creators.
 * 2. In dry-run mode (apply=false): returns all actions as skipped.
 * 3. In apply mode (apply=true): backs up config files, executes
 *    each action sequentially, sorts into applied/failed/skipped.
 *
 * @param auditResult - Result from runSecurityAudit
 * @param configPaths - Config file paths for backup
 * @param options - Fix options (apply mode)
 * @returns Aggregated fix result
 */
export async function runSecurityFix(
  auditResult: AuditResult,
  configPaths: string[],
  options: FixOptions,
): Promise<FixResult> {
  const findings = [...auditResult.findings];

  // Collect all remediation actions from fix creators
  const allActions: RemediationAction[] = [
    ...createPermissionFixes(findings),
    ...createSecretsFixes(findings),
    ...createConfigFixes(findings, configPaths),
  ];

  // Dry-run mode: return all actions as skipped, no mutations
  if (!options.apply) {
    return {
      applied: [],
      skipped: allActions,
      failed: [],
      backupPath: undefined,
    };
  }

  // Apply mode: backup configs first, then execute actions
  let backupPath: string | undefined;
  for (const configPath of configPaths) {
    const result = createBackup(configPath);
    if (result) {
      // Store the first successful backup path for reporting
      backupPath ??= result;
    }
  }

  const applied: RemediationAction[] = [];
  const skipped: RemediationAction[] = [];
  const failed: Array<{ action: RemediationAction; error: Error }> = [];

  // Execute each action sequentially
  for (const action of allActions) {
    const result = await action.apply();
    if (result.ok) {
      applied.push(action);
    } else {
      failed.push({ action, error: result.error });
    }
  }

  return { applied, skipped, failed, backupPath };
}
