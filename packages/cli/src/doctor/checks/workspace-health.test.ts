/**
 * Workspace health check unit tests.
 *
 * Tests workspace-health check for missing data dir, not writable
 * data dir, missing log dir, and healthy workspace scenarios.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type { DoctorContext } from "../types.js";

// Mock node:fs for existsSync and accessSync
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  accessSync: vi.fn(),
  constants: { W_OK: 2 },
}));

const { existsSync, accessSync } = await import("node:fs");
const { workspaceHealthCheck } = await import("./workspace-health.js");

const baseContext: DoctorContext = {
  configPaths: [],
  dataDir: "/tmp/test-comis",
  daemonPidFile: "/tmp/test-comis/daemon.pid",
};

describe("workspaceHealthCheck", () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
    vi.mocked(accessSync).mockReset();
  });

  it("produces fail when data directory missing", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const findings = await workspaceHealthCheck.run(baseContext);

    // Should have fail for data dir + warn for log dir (also missing)
    const dataFinding = findings.find((f) => f.check === "Data directory");
    expect(dataFinding).toBeDefined();
    expect(dataFinding!.status).toBe("fail");
    expect(dataFinding!.message).toContain("missing");
    expect(dataFinding!.repairable).toBe(true);
  });

  it("produces fail when data directory not writable", async () => {
    // existsSync returns true for dataDir, but accessSync throws
    vi.mocked(existsSync).mockImplementation((p) => {
      // Data dir exists but log dir doesn't
      return p === baseContext.dataDir;
    });
    vi.mocked(accessSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const findings = await workspaceHealthCheck.run(baseContext);

    const writableFinding = findings.find((f) => f.check === "Data directory writable");
    expect(writableFinding).toBeDefined();
    expect(writableFinding!.status).toBe("fail");
    expect(writableFinding!.message).toContain("not writable");
  });

  it("produces warn when log directory missing", async () => {
    // Data dir exists and is writable, but log dir is missing
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === baseContext.dataDir) return true;
      if (p === baseContext.dataDir + "/logs") return false;
      return true;
    });
    vi.mocked(accessSync).mockImplementation(() => {
      // No error -- data dir is writable
    });

    const findings = await workspaceHealthCheck.run(baseContext);

    const logFinding = findings.find((f) => f.check === "Log directory");
    expect(logFinding).toBeDefined();
    expect(logFinding!.status).toBe("warn");
    expect(logFinding!.message).toContain("Log directory missing");
  });

  it("produces pass when all directories healthy", async () => {
    // All paths exist and are writable
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(accessSync).mockImplementation(() => {
      // No error
    });

    const findings = await workspaceHealthCheck.run(baseContext);

    const passFinding = findings.find((f) => f.status === "pass");
    expect(passFinding).toBeDefined();
    expect(passFinding!.check).toBe("Workspace directories");
    expect(passFinding!.message).toContain("healthy");
  });
});
