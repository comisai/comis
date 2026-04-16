/**
 * Action confirmation security check.
 *
 * Verifies that destructive action confirmation is enabled and
 * that the auto-approve list does not contain dangerous patterns
 * that could bypass safety gates.
 *
 * @module
 */

import type { SecurityCheck, SecurityFinding } from "../types.js";

/** Dangerous patterns that should not appear in auto-approve lists. */
const DANGEROUS_AUTO_APPROVE_PATTERNS = ["delete", "drop", "rm", "destroy", "kill"];

/**
 * Action confirmation check.
 *
 * Evaluates action confirmation configuration for:
 * - Disabled destructive action confirmation
 * - Dangerous actions in auto-approve list
 */
export const actionConfirmationCheck: SecurityCheck = {
  id: "action-confirmation",
  name: "Action Confirmation",
  run: async (context) => {
    const findings: SecurityFinding[] = [];

    if (!context.config?.security?.actionConfirmation) {
      return findings;
    }

    const confirmation = context.config.security.actionConfirmation;

    if (confirmation.requireForDestructive === false) {
      findings.push({
        category: "action-confirmation",
        severity: "warning",
        message: "Destructive action confirmation disabled",
        remediation:
          "Enable security.actionConfirmation.requireForDestructive to require human approval for destructive actions",
        code: "SEC-ACTION-001",
      });
    }

    if (confirmation.autoApprove && confirmation.autoApprove.length > 0) {
      const dangerous = confirmation.autoApprove.filter((action) =>
        DANGEROUS_AUTO_APPROVE_PATTERNS.some((pattern) => action.toLowerCase().includes(pattern)),
      );

      if (dangerous.length > 0) {
        findings.push({
          category: "action-confirmation",
          severity: "critical",
          message: `Destructive actions in auto-approve list: ${dangerous.join(", ")}`,
          remediation:
            "Remove destructive action patterns from security.actionConfirmation.autoApprove",
          code: "SEC-ACTION-002",
        });
      }
    }

    return findings;
  },
};
