// SPDX-License-Identifier: Apache-2.0
/**
 * Secrets audit health check for `comis doctor`.
 *
 * Wires the existing `auditSecrets()` from `@comis/core` into a DoctorCheck.
 * Mirrors the `oauth-health.ts` pattern: single-purpose check, never throws,
 * maps `AuditFinding[]` → `DoctorFinding[]` preserving severity.
 *
 * Finding mapping:
 *   - AuditFinding.severity === "error" → DoctorFinding.status "fail"
 *   - AuditFinding.severity === "warn"  → DoctorFinding.status "warn"
 *   - AuditFinding.severity === "info"  → DoctorFinding.status "warn" (treat as degraded)
 *   - empty array                       → single "pass" finding
 *   - auditSecrets throws               → single "skip" finding (graceful)
 *
 * @module
 */

import { auditSecrets } from "@comis/core";
import type { AuditFinding } from "@comis/core";
import type { DoctorCheck, DoctorContext, DoctorFinding } from "../types.js";

const CATEGORY = "secrets-audit";
const CHECK_NAME = "Config secrets scan";

function severityToStatus(severity: AuditFinding["severity"]): DoctorFinding["status"] {
  if (severity === "error") return "fail";
  return "warn"; // "warn" | "info" both map to warn
}

function runSecretsAudit(context: DoctorContext): DoctorFinding[] {
  try {
    const findings: AuditFinding[] = auditSecrets({ configPaths: context.configPaths });
    if (findings.length === 0) {
      return [
        {
          category: CATEGORY,
          check: CHECK_NAME,
          status: "pass",
          message: "No plaintext secrets found in config files",
          repairable: false,
        },
      ];
    }
    return findings.map((f): DoctorFinding => ({
      category: CATEGORY,
      check: f.jsonPath,
      status: severityToStatus(f.severity),
      message: f.message,
      suggestion: "Move this value to a SecretRef or environment variable",
      repairable: false,
    }));
  } catch {
    return [
      {
        category: CATEGORY,
        check: CHECK_NAME,
        status: "skip",
        message: "Secrets audit could not complete",
        repairable: false,
      },
    ];
  }
}

export const secretsAuditHealthCheck: DoctorCheck = {
  id: "secrets-audit",
  name: "Secrets Audit",
  run: async (context: DoctorContext): Promise<DoctorFinding[]> => {
    return runSecretsAudit(context);
  },
};
