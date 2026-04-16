/**
 * Audit logging check unit tests.
 *
 * Verifies that auditLoggingCheck detects disabled audit logging,
 * disabled log redaction, both disabled simultaneously, and produces
 * info finding when both enabled.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { auditLoggingCheck } from "./audit-logging.js";
import type { AuditContext } from "../types.js";
import type { AppConfig } from "@comis/core";

/** Base audit context with no config. */
const baseContext: AuditContext = {
  configPaths: [],
  dataDir: "/tmp/test-data",
  skillsPaths: [],
};

/** Create a minimal context with security config. */
function contextWithSecurity(security: Record<string, unknown>): AuditContext {
  return {
    ...baseContext,
    config: { security } as unknown as AppConfig,
  };
}

describe("auditLoggingCheck", () => {
  it("returns empty findings when no security config", async () => {
    const findings = await auditLoggingCheck.run(baseContext);

    expect(findings).toHaveLength(0);
  });

  it("produces warning when auditLog is false", async () => {
    const findings = await auditLoggingCheck.run(
      contextWithSecurity({ auditLog: false, logRedaction: true }),
    );

    const finding = findings.find((f) => f.code === "SEC-AUDIT-001");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.message).toContain("Audit logging disabled");
  });

  it("produces warning when logRedaction is false", async () => {
    const findings = await auditLoggingCheck.run(
      contextWithSecurity({ auditLog: true, logRedaction: false }),
    );

    const finding = findings.find((f) => f.code === "SEC-AUDIT-002");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.message).toContain("Log redaction disabled");
  });

  it("produces both warnings when both disabled", async () => {
    const findings = await auditLoggingCheck.run(
      contextWithSecurity({ auditLog: false, logRedaction: false }),
    );

    expect(findings).toHaveLength(2);
    expect(findings.some((f) => f.code === "SEC-AUDIT-001")).toBe(true);
    expect(findings.some((f) => f.code === "SEC-AUDIT-002")).toBe(true);
  });

  it("produces info SEC-AUDIT-PASS when both enabled", async () => {
    const findings = await auditLoggingCheck.run(
      contextWithSecurity({ auditLog: true, logRedaction: true }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-AUDIT-PASS");
    expect(findings[0].severity).toBe("info");
    expect(findings[0].message).toContain("enabled");
  });
});
