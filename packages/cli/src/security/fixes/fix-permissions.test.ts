// SPDX-License-Identifier: Apache-2.0
/**
 * Permission fix unit tests.
 *
 * Verifies createPermissionFixes produces correct remediation actions
 * for config file, data directory, and state file permission findings,
 * handles chmod failures, and skips findings without paths or
 * unrecognized codes.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type { SecurityFinding } from "../types.js";

// Mock node:fs at module level
vi.mock("node:fs", () => ({
  chmodSync: vi.fn(),
}));

const { chmodSync } = await import("node:fs");
const { createPermissionFixes } = await import("./fix-permissions.js");

describe("createPermissionFixes", () => {
  beforeEach(() => {
    vi.mocked(chmodSync).mockReset();
  });

  it("returns empty actions for empty findings array", () => {
    const actions = createPermissionFixes([]);

    expect(actions).toHaveLength(0);
  });

  it("creates action for config file chmod 600 finding", async () => {
    const findings: SecurityFinding[] = [
      {
        category: "file-permissions",
        severity: "critical",
        message: "Config file is world-readable: /etc/comis/config.yaml",
        remediation: "chmod 600 /etc/comis/config.yaml",
        code: "SEC-PERM-001",
        path: "/etc/comis/config.yaml",
      },
    ];

    const actions = createPermissionFixes(findings);

    expect(actions).toHaveLength(1);
    expect(actions[0].code).toBe("SEC-PERM-001");
    expect(actions[0].preview()).toContain("chmod 600");
    expect(actions[0].preview()).toContain("/etc/comis/config.yaml");

    const result = await actions[0].apply();
    expect(result.ok).toBe(true);
    expect(chmodSync).toHaveBeenCalledWith("/etc/comis/config.yaml", 0o600);
  });

  it("creates action for data dir chmod 700 finding", async () => {
    const findings: SecurityFinding[] = [
      {
        category: "file-permissions",
        severity: "warning",
        message: "Data directory overly permissive: /var/comis",
        remediation: "chmod 700 /var/comis",
        code: "SEC-PERM-003",
        path: "/var/comis",
      },
    ];

    const actions = createPermissionFixes(findings);

    expect(actions).toHaveLength(1);
    expect(actions[0].code).toBe("SEC-PERM-003");
    expect(actions[0].preview()).toContain("chmod 700");

    const result = await actions[0].apply();
    expect(result.ok).toBe(true);
    expect(chmodSync).toHaveBeenCalledWith("/var/comis", 0o700);
  });

  it("creates action for state file chmod 600 finding", async () => {
    const findings: SecurityFinding[] = [
      {
        category: "state-protection",
        severity: "critical",
        message: "Data directory is world-writable: /tmp/data",
        remediation: "chmod 600 /tmp/data",
        code: "SEC-STATE-002",
        path: "/tmp/data",
      },
    ];

    const actions = createPermissionFixes(findings);

    expect(actions).toHaveLength(1);
    expect(actions[0].code).toBe("SEC-STATE-002");

    const result = await actions[0].apply();
    expect(result.ok).toBe(true);
    expect(chmodSync).toHaveBeenCalledWith("/tmp/data", 0o600);
  });

  it("skips findings without a path property", () => {
    const findings: SecurityFinding[] = [
      {
        category: "file-permissions",
        severity: "critical",
        message: "Config file is world-readable",
        remediation: "chmod 600",
        code: "SEC-PERM-001",
        // no path
      },
    ];

    const actions = createPermissionFixes(findings);

    expect(actions).toHaveLength(0);
  });

  it("returns err() when chmodSync throws EPERM error", async () => {
    vi.mocked(chmodSync).mockImplementation(() => {
      throw new Error("EPERM: operation not permitted");
    });

    const findings: SecurityFinding[] = [
      {
        category: "file-permissions",
        severity: "critical",
        message: "Config file is world-readable: /root/config.yaml",
        remediation: "chmod 600 /root/config.yaml",
        code: "SEC-PERM-001",
        path: "/root/config.yaml",
      },
    ];

    const actions = createPermissionFixes(findings);

    expect(actions).toHaveLength(1);
    const result = await actions[0].apply();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("EPERM");
    }
  });

  it("skips findings with unrecognized codes", () => {
    const findings: SecurityFinding[] = [
      {
        category: "audit-logging",
        severity: "info",
        message: "Audit logging not enabled",
        remediation: "Enable audit logging",
        code: "SEC-AUDIT-001",
        path: "/tmp/audit.log",
      },
    ];

    const actions = createPermissionFixes(findings);

    expect(actions).toHaveLength(0);
  });

  it("handles multiple permission findings in one call", async () => {
    const findings: SecurityFinding[] = [
      {
        category: "file-permissions",
        severity: "critical",
        message: "Config world-readable",
        remediation: "chmod 600",
        code: "SEC-PERM-001",
        path: "/etc/config.yaml",
      },
      {
        category: "file-permissions",
        severity: "warning",
        message: "Data dir overly permissive",
        remediation: "chmod 700",
        code: "SEC-PERM-003",
        path: "/var/data",
      },
      {
        category: "state-protection",
        severity: "critical",
        message: "DB world-writable",
        remediation: "chmod 600",
        code: "SEC-STATE-003",
        path: "/var/data/app.db",
      },
    ];

    const actions = createPermissionFixes(findings);

    expect(actions).toHaveLength(3);
    expect(actions[0].code).toBe("SEC-PERM-001");
    expect(actions[1].code).toBe("SEC-PERM-003");
    expect(actions[2].code).toBe("SEC-STATE-003");
  });
});
