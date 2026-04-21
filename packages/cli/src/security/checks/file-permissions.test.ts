// SPDX-License-Identifier: Apache-2.0
/**
 * File permissions check unit tests.
 *
 * Verifies that filePermissionsCheck produces correct findings for
 * world-readable, group-readable, restrictive, and missing config files,
 * plus overly permissive data directories.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type { AuditContext } from "../types.js";

// Mock node:fs at module level
vi.mock("node:fs", () => ({
  statSync: vi.fn(),
}));

const { statSync } = await import("node:fs");
const { filePermissionsCheck } = await import("./file-permissions.js");

/** Base audit context for testing. */
const baseContext: AuditContext = {
  configPaths: [],
  dataDir: "/tmp/test-data",
  skillsPaths: [],
};

describe("filePermissionsCheck", () => {
  beforeEach(() => {
    vi.mocked(statSync).mockReset();
  });

  it("produces critical finding for world-readable config (mode 644)", async () => {
    vi.mocked(statSync).mockReturnValue({ mode: 0o100644 } as ReturnType<typeof statSync>);

    const findings = await filePermissionsCheck.run({
      ...baseContext,
      configPaths: ["/tmp/config.yaml"],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].code).toBe("SEC-PERM-001");
    expect(findings[0].message).toContain("world-readable");
  });

  it("produces warning for group-readable config (mode 640)", async () => {
    vi.mocked(statSync).mockReturnValue({ mode: 0o100640 } as ReturnType<typeof statSync>);

    const findings = await filePermissionsCheck.run({
      ...baseContext,
      configPaths: ["/tmp/config.yaml"],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].code).toBe("SEC-PERM-002");
  });

  it("produces no finding for restrictive config (mode 600)", async () => {
    vi.mocked(statSync).mockReturnValue({ mode: 0o100600 } as ReturnType<typeof statSync>);

    const findings = await filePermissionsCheck.run({
      ...baseContext,
      configPaths: ["/tmp/config.yaml"],
    });

    // mode 600 for config + mode 600 for dataDir (no finding for config)
    // dataDir also uses statSync, so mock returns 600 for that too
    const configFindings = findings.filter((f) => f.code.startsWith("SEC-PERM-00") && f.code !== "SEC-PERM-003");
    expect(configFindings).toHaveLength(0);
  });

  it("ignores ENOENT errors (missing file)", async () => {
    const enoentError = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    vi.mocked(statSync).mockImplementation(() => {
      throw enoentError;
    });

    const findings = await filePermissionsCheck.run({
      ...baseContext,
      configPaths: ["/tmp/missing.yaml"],
    });

    expect(findings).toHaveLength(0);
  });

  it("produces warning for overly permissive data directory (mode 755)", async () => {
    vi.mocked(statSync).mockReturnValue({ mode: 0o040755 } as ReturnType<typeof statSync>);

    const findings = await filePermissionsCheck.run({
      ...baseContext,
      configPaths: [],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].code).toBe("SEC-PERM-003");
    expect(findings[0].message).toContain("overly permissive");
  });
});
