// SPDX-License-Identifier: Apache-2.0
/**
 * Config validation security check.
 *
 * Validates that the config file parses correctly against the
 * AppConfigSchema. Parse failures indicate malformed config that
 * could lead to insecure default behavior.
 *
 * @module
 */

import { AppConfigSchema } from "@comis/core";
import type { SecurityCheck, SecurityFinding } from "../types.js";

/**
 * Config validation check.
 *
 * If config is undefined but rawConfigContent exists, attempts safeParse.
 * If config already exists (parsed), emits an info finding confirming validity.
 */
export const configValidationCheck: SecurityCheck = {
  id: "config-validation",
  name: "Config Validation",
  run: async (context) => {
    const findings: SecurityFinding[] = [];

    // Config parsed AND validated → the config-scoped checks (browser exposure,
    // SSRF surface, channel/gateway/webhook security, …) all ran against it.
    if (context.config !== undefined) {
      findings.push({
        category: "config-validation",
        severity: "info",
        message: "Config validates successfully",
        remediation: "None needed",
        code: "SEC-CFG-PASS",
      });
      return findings;
    }

    // From here `context.config` is undefined, so EVERY config-scoped check
    // silently no-ops (each early-returns on a missing config). We must NEVER
    // return empty here: a bare `comis security audit` would then print
    // "Audit PASSED (no critical findings)" while having evaluated nothing
    // config-scoped — a false all-clean. Surface exactly WHY the config is
    // unavailable so the operator cannot read "PASSED" as a security guarantee.

    // (a) buildAuditContext captured a concrete load/validate error — report IT
    //     verbatim rather than guessing "check YAML syntax". The audit validates
    //     the file AS WRITTEN and does not resolve `${ENV}` secret references, so
    //     a runtime-valid production config (e.g. gateway secret `${COMIS_GATEWAY_TOKEN}`)
    //     fails length validation here; the note tells the operator that, so a
    //     harmless env-ref is not mistaken for a syntax error.
    if (context.configError !== undefined) {
      findings.push({
        category: "config-validation",
        severity: "critical",
        message: `Config could not be validated — config-scoped checks were SKIPPED: ${context.configError}`,
        remediation:
          "Fix the reported violation. Note: the audit validates the config file as written and does NOT resolve ${ENV} secret references, so a runtime-valid config that uses e.g. ${COMIS_GATEWAY_TOKEN} will fail here — audit a fully-resolved config to evaluate the config-scoped checks.",
        code: "SEC-CFG-001",
      });
      return findings;
    }

    // (b) Raw content present but no captured error (direct invocation, no
    //     buildAuditContext) — parse + validate it here to report the real reason.
    if (context.rawConfigContent !== undefined) {
      let rawObj: unknown;
      try {
        rawObj = JSON.parse(context.rawConfigContent);
      } catch {
        findings.push({
          category: "config-validation",
          severity: "critical",
          message: "Config file could not be parsed — config-scoped checks were SKIPPED",
          remediation: "Check config file syntax (YAML or JSON format required)",
          code: "SEC-CFG-001",
        });
        return findings;
      }

      const result = AppConfigSchema.safeParse(rawObj);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        findings.push({
          category: "config-validation",
          severity: "critical",
          message: `Config validation failed — config-scoped checks were SKIPPED: ${issues}`,
          remediation: "Fix the reported config schema violations",
          code: "SEC-CFG-001",
        });
      } else {
        findings.push({
          category: "config-validation",
          severity: "info",
          message: "Config validates successfully",
          remediation: "None needed",
          code: "SEC-CFG-PASS",
        });
      }
      return findings;
    }

    // (c) No config was provided at all (no -c/--config). The config-scoped
    //     checks were skipped, so the "PASSED" summary covers only the
    //     filesystem/host checks. Warn so it is not read as a full all-clear.
    findings.push({
      category: "config-validation",
      severity: "warning",
      message:
        "No config file was audited — config-scoped checks (browser exposure, SSRF surface, channel/gateway/webhook security, state protection, …) were SKIPPED",
      remediation:
        "Pass -c/--config <path> so the audit evaluates the config-scoped checks; a bare audit only covers filesystem/host checks",
      code: "SEC-CFG-002",
    });
    return findings;
  },
};
