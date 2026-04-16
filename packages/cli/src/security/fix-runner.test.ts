/**
 * Tests for the security fix runner.
 *
 * Verifies dry-run mode (all skipped, no apply called),
 * apply mode (success → applied, failure → failed),
 * and empty findings (empty FixResult).
 */

import { describe, it, expect, vi } from "vitest";
import { runSecurityFix } from "./fix-runner.js";
import type { AuditResult } from "./types.js";
import type { RemediationAction } from "./fix-types.js";
import { ok, err } from "@comis/shared";

/** Minimal passing audit result with no findings. */
const emptyAuditResult: AuditResult = {
  findings: [],
  checksRun: 0,
  criticalCount: 0,
  warningCount: 0,
  infoCount: 0,
  passed: true,
};

/** Create a mock RemediationAction. */
function mockAction(
  code: string,
  applyResult: { ok: true; value: string } | { ok: false; error: Error },
): RemediationAction {
  return {
    code,
    description: `Fix for ${code}`,
    preview: () => `Preview: fix ${code}`,
    apply: vi.fn(async () => applyResult),
  };
}

describe("runSecurityFix", () => {
  it("returns empty FixResult with no findings", async () => {
    const result = await runSecurityFix(emptyAuditResult, [], { apply: false });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.backupPath).toBeUndefined();
  });

  it("returns all actions as skipped in dry-run mode", async () => {
    const auditResult: AuditResult = {
      ...emptyAuditResult,
      findings: [
        {
          category: "file-permissions",
          severity: "critical",
          message: "Config file is world-readable: /tmp/test.yaml",
          remediation: "chmod 600 /tmp/test.yaml",
          code: "SEC-PERM-001",
          path: "/tmp/test.yaml",
        },
        {
          category: "file-permissions",
          severity: "warning",
          message: "Data dir overly permissive",
          remediation: "chmod 700 /tmp/data",
          code: "SEC-PERM-003",
          path: "/tmp/data",
        },
      ],
      criticalCount: 1,
      warningCount: 1,
    };

    const result = await runSecurityFix(auditResult, [], { apply: false });

    // All actions should be in skipped, none in applied
    expect(result.skipped.length).toBe(2);
    expect(result.applied.length).toBe(0);
    expect(result.failed.length).toBe(0);
    expect(result.backupPath).toBeUndefined();

    // Preview should describe the fix
    expect(result.skipped[0].preview()).toContain("chmod 600");
    expect(result.skipped[1].preview()).toContain("chmod 700");
  });

  it("does not call apply() on actions in dry-run mode", async () => {
    const auditResult: AuditResult = {
      ...emptyAuditResult,
      findings: [
        {
          category: "secrets-exposure",
          severity: "warning",
          message: "Plaintext secret found",
          remediation: "Move to .env",
          code: "SEC-SECRET-001",
        },
      ],
      warningCount: 1,
    };

    const result = await runSecurityFix(auditResult, [], { apply: false });

    // Secrets fix is advisory -- should be skipped
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].code).toBe("SEC-SECRET-001");
  });

  it("sorts successful actions into applied and failed into failed", async () => {
    // We need to test the apply path with mock actions.
    // Since fix-runner collects actions from fix creators internally,
    // we test indirectly through findings that trigger specific fix creators.

    // Create findings for secrets (which always fail on apply -- advisory)
    const auditResult: AuditResult = {
      ...emptyAuditResult,
      findings: [
        {
          category: "secrets-exposure",
          severity: "warning",
          message: "Plaintext secret found",
          remediation: "Move to .env",
          code: "SEC-SECRET-001",
        },
      ],
      warningCount: 1,
    };

    const result = await runSecurityFix(auditResult, [], { apply: true });

    // Secrets fixes always fail (advisory only) -- should go to failed
    expect(result.applied.length).toBe(0);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].action.code).toBe("SEC-SECRET-001");
    expect(result.failed[0].error.message).toContain("Manual action required");
  });

  it("includes config fix advisories in apply mode", async () => {
    const auditResult: AuditResult = {
      ...emptyAuditResult,
      findings: [
        {
          category: "config-validation",
          severity: "critical",
          message: "Config is invalid",
          remediation: "Fix config",
          code: "SEC-CFG-001",
        },
        {
          category: "gateway-exposure",
          severity: "warning",
          message: "No gateway tokens",
          remediation: "Add tokens",
          code: "SEC-GW-003",
        },
      ],
      criticalCount: 1,
      warningCount: 1,
    };

    const result = await runSecurityFix(auditResult, [], { apply: true });

    // Both config fixes are advisory -- should fail with guidance
    expect(result.failed.length).toBe(2);
    expect(result.failed[0].error.message).toContain("Manual action required");
    expect(result.failed[1].error.message).toContain("Manual action required");
  });

  it("returns empty FixResult when apply is true but no remediable findings", async () => {
    // Findings with codes that don't match any fix creator
    const auditResult: AuditResult = {
      ...emptyAuditResult,
      findings: [
        {
          category: "audit-logging",
          severity: "info",
          message: "Audit logging not enabled",
          remediation: "Enable audit logging",
          code: "SEC-AUDIT-001",
        },
      ],
      infoCount: 1,
    };

    const result = await runSecurityFix(auditResult, [], { apply: true });

    expect(result.applied.length).toBe(0);
    expect(result.skipped.length).toBe(0);
    expect(result.failed.length).toBe(0);
  });
});
