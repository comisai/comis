// SPDX-License-Identifier: Apache-2.0
/**
 * Audit logging security check.
 *
 * Verifies that audit logging and log redaction are enabled to
 * ensure security events are tracked and credentials do not
 * leak into log files.
 *
 * @module
 */

import type { SecurityCheck, SecurityFinding } from "../types.js";

/**
 * Audit logging check.
 *
 * Evaluates security logging configuration for:
 * - Disabled audit logging
 * - Disabled log redaction
 * - Both enabled (info finding)
 */
export const auditLoggingCheck: SecurityCheck = {
  id: "audit-logging",
  name: "Audit Logging",
  run: async (context) => {
    const findings: SecurityFinding[] = [];

    if (!context.config?.security) {
      return findings;
    }

    const security = context.config.security;

    if (security.auditLog === false) {
      findings.push({
        category: "audit-logging",
        severity: "warning",
        message: "Audit logging disabled",
        remediation: "Enable security.auditLog to track security-relevant events",
        code: "SEC-AUDIT-001",
      });
    }

    if (security.logRedaction === false) {
      findings.push({
        category: "audit-logging",
        severity: "warning",
        message: "Log redaction disabled -- credentials may appear in logs",
        remediation: "Enable security.logRedaction to prevent credential leakage in log output",
        code: "SEC-AUDIT-002",
      });
    }

    if (security.auditLog !== false && security.logRedaction !== false) {
      findings.push({
        category: "audit-logging",
        severity: "info",
        message: "Audit logging and log redaction are enabled",
        remediation: "None needed",
        code: "SEC-AUDIT-PASS",
      });
    }

    return findings;
  },
};
