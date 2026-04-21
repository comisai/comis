// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the security audit check runner.
 *
 * Verifies sequential execution, error handling, severity sorting,
 * and the passed flag behavior.
 */

import { describe, it, expect } from "vitest";
import { runSecurityAudit } from "./check-runner.js";
import type { SecurityCheck, SecurityFinding, AuditContext } from "./types.js";

/** Minimal audit context for testing. */
const testContext: AuditContext = {
  configPaths: [],
  dataDir: "/tmp/test-comis",
  skillsPaths: [],
};

describe("runSecurityAudit", () => {
  it("returns empty findings and passed=true with 0 checks", async () => {
    const result = await runSecurityAudit([], testContext);

    expect(result.findings).toEqual([]);
    expect(result.checksRun).toBe(0);
    expect(result.criticalCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.infoCount).toBe(0);
    expect(result.passed).toBe(true);
  });

  it("sorts findings by severity: critical before warning before info", async () => {
    const mixedCheck: SecurityCheck = {
      id: "test-mixed",
      name: "Mixed Findings",
      run: async () => [
        { category: "test", severity: "info", message: "Info item", remediation: "None", code: "T-INFO" },
        { category: "test", severity: "critical", message: "Critical item", remediation: "Fix it", code: "T-CRIT" },
        { category: "test", severity: "warning", message: "Warning item", remediation: "Review", code: "T-WARN" },
      ],
    };

    const result = await runSecurityAudit([mixedCheck], testContext);

    expect(result.findings).toHaveLength(3);
    expect(result.findings[0].severity).toBe("critical");
    expect(result.findings[1].severity).toBe("warning");
    expect(result.findings[2].severity).toBe("info");
    expect(result.checksRun).toBe(1);
    expect(result.criticalCount).toBe(1);
    expect(result.warningCount).toBe(1);
    expect(result.infoCount).toBe(1);
  });

  it("produces SEC-CHECK-ERROR warning when a check throws", async () => {
    const throwingCheck: SecurityCheck = {
      id: "broken-check",
      name: "Broken Check",
      run: async () => {
        throw new Error("Something went wrong");
      },
    };

    const result = await runSecurityAudit([throwingCheck], testContext);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].code).toBe("SEC-CHECK-ERROR");
    expect(result.findings[0].severity).toBe("warning");
    expect(result.findings[0].category).toBe("broken-check");
    expect(result.findings[0].message).toContain("Something went wrong");
    expect(result.passed).toBe(true); // warning, not critical
  });

  it("sets passed=true when no criticals, false when any critical", async () => {
    const warningOnly: SecurityCheck = {
      id: "warn-check",
      name: "Warning Check",
      run: async () => [
        { category: "warn", severity: "warning", message: "Just a warning", remediation: "Review", code: "W-001" },
      ],
    };

    const criticalCheck: SecurityCheck = {
      id: "crit-check",
      name: "Critical Check",
      run: async () => [
        { category: "crit", severity: "critical", message: "Critical issue", remediation: "Fix now", code: "C-001" },
      ],
    };

    const warningResult = await runSecurityAudit([warningOnly], testContext);
    expect(warningResult.passed).toBe(true);

    const criticalResult = await runSecurityAudit([warningOnly, criticalCheck], testContext);
    expect(criticalResult.passed).toBe(false);
    expect(criticalResult.criticalCount).toBe(1);
    expect(criticalResult.warningCount).toBe(1);
  });

  it("sorts by category within same severity for stable output", async () => {
    const multiCategory: SecurityCheck = {
      id: "multi",
      name: "Multi",
      run: async () => [
        { category: "zz-check", severity: "warning", message: "Z warning", remediation: "R", code: "Z-001" },
        { category: "aa-check", severity: "warning", message: "A warning", remediation: "R", code: "A-001" },
      ],
    };

    const result = await runSecurityAudit([multiCategory], testContext);

    expect(result.findings[0].category).toBe("aa-check");
    expect(result.findings[1].category).toBe("zz-check");
  });

  it("aggregates findings from multiple checks", async () => {
    const checkA: SecurityCheck = {
      id: "check-a",
      name: "Check A",
      run: async () => [
        { category: "a", severity: "info", message: "A info", remediation: "None", code: "A-001" },
      ],
    };

    const checkB: SecurityCheck = {
      id: "check-b",
      name: "Check B",
      run: async () => [
        { category: "b", severity: "critical", message: "B critical", remediation: "Fix", code: "B-001" },
        { category: "b", severity: "warning", message: "B warning", remediation: "Review", code: "B-002" },
      ],
    };

    const result = await runSecurityAudit([checkA, checkB], testContext);

    expect(result.findings).toHaveLength(3);
    expect(result.checksRun).toBe(2);
    expect(result.criticalCount).toBe(1);
    expect(result.warningCount).toBe(1);
    expect(result.infoCount).toBe(1);
    // Critical first
    expect(result.findings[0].severity).toBe("critical");
  });
});
