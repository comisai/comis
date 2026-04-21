// SPDX-License-Identifier: Apache-2.0
/**
 * Secrets remediation actions (advisory only).
 *
 * Creates advisory actions for secrets-related findings. These cannot
 * be auto-remediated -- credentials must be manually migrated to .env
 * files. Actions will show up as "skipped" in fix results.
 *
 * @module
 */

import { err } from "@comis/shared";
import type { SecurityFinding } from "../types.js";
import type { RemediationAction } from "../fix-types.js";

/**
 * Create advisory remediation actions for secrets-related findings.
 *
 * All SEC-SECRET-* findings produce advisory actions that cannot auto-apply.
 * The apply() method returns an error with guidance for manual migration.
 *
 * @param findings - Security findings from the audit
 * @returns Array of advisory remediation actions
 */
export function createSecretsFixes(findings: SecurityFinding[]): RemediationAction[] {
  const actions: RemediationAction[] = [];

  for (const finding of findings) {
    if (!finding.code.startsWith("SEC-SECRET")) continue;

    actions.push({
      code: finding.code,
      description: `Advisory: ${finding.message}`,
      preview: () => "Cannot auto-remediate secrets -- manual migration to .env required",
      apply: async () => err(new Error("Manual action required: move credentials to .env file")),
    });
  }

  return actions;
}
