// SPDX-License-Identifier: Apache-2.0
/**
 * Config fix unit tests.
 *
 * Verifies createConfigFixes produces advisory actions for invalid config
 * and missing gateway token findings, skips unrelated findings, and
 * handles both finding types in a single call.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { createConfigFixes } from "./fix-config.js";
import type { SecurityFinding } from "../types.js";

describe("createConfigFixes", () => {
  it("returns empty actions for empty findings array", () => {
    const actions = createConfigFixes([], []);

    expect(actions).toHaveLength(0);
  });

  it("creates advisory action for invalid config finding", async () => {
    const findings: SecurityFinding[] = [
      {
        category: "config-validation",
        severity: "critical",
        message: "Config file failed validation",
        remediation: "Fix config",
        code: "SEC-CFG-001",
        path: "/etc/comis/config.yaml",
      },
    ];

    const actions = createConfigFixes(findings, []);

    expect(actions).toHaveLength(1);
    expect(actions[0].code).toBe("SEC-CFG-001");
    expect(actions[0].preview()).toContain("Cannot auto-fix");

    const result = await actions[0].apply();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Manual action required");
      expect(result.error.message).toContain("backup");
      expect(result.error.message).toContain("defaults");
    }
  });

  it("creates advisory action for SEC-GW-003 finding", async () => {
    const findings: SecurityFinding[] = [
      {
        category: "gateway-exposure",
        severity: "warning",
        message: "No gateway authentication tokens configured",
        remediation: "Add tokens to gateway config",
        code: "SEC-GW-003",
      },
    ];

    const actions = createConfigFixes(findings, []);

    expect(actions).toHaveLength(1);
    expect(actions[0].code).toBe("SEC-GW-003");
    expect(actions[0].preview()).toContain("Cannot auto-generate");

    const result = await actions[0].apply();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Manual action required");
      expect(result.error.message).toContain("gateway");
      expect(result.error.message).toContain("tokens");
    }
  });

  it("skips findings with unrelated codes", () => {
    const findings: SecurityFinding[] = [
      {
        category: "channel-security",
        severity: "warning",
        message: "Channel not configured",
        remediation: "Configure channel",
        code: "SEC-CHAN-001",
      },
      {
        category: "audit-logging",
        severity: "info",
        message: "Audit logging disabled",
        remediation: "Enable audit",
        code: "SEC-AUDIT-001",
      },
    ];

    const actions = createConfigFixes(findings, []);

    expect(actions).toHaveLength(0);
  });

  it("handles both invalid-config and missing-gateway-token findings in same array", () => {
    const findings: SecurityFinding[] = [
      {
        category: "config-validation",
        severity: "critical",
        message: "Config invalid",
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
    ];

    const actions = createConfigFixes(findings, []);

    expect(actions).toHaveLength(2);
    expect(actions[0].code).toBe("SEC-CFG-001");
    expect(actions[1].code).toBe("SEC-GW-003");
  });

  it("accepts second parameter _configPaths without using it", () => {
    const findings: SecurityFinding[] = [
      {
        category: "config-validation",
        severity: "critical",
        message: "Config invalid",
        remediation: "Fix config",
        code: "SEC-CFG-001",
      },
    ];

    // Pass config paths -- should be accepted but not affect behavior
    const actions = createConfigFixes(findings, ["/etc/comis/config.yaml", "/home/user/.comis/config.yaml"]);

    expect(actions).toHaveLength(1);
    expect(actions[0].code).toBe("SEC-CFG-001");
  });
});
