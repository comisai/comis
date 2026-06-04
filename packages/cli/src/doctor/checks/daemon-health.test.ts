// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon health check unit tests.
 *
 * Tests daemon-health check for missing PID, invalid PID content,
 * stale PID (process not alive), and running process scenarios.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DoctorContext } from "../types.js";

// Mock node:fs readFileSync
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

const { readFileSync } = await import("node:fs");
const { daemonHealthCheck } = await import("./daemon-health.js");

const baseContext: DoctorContext = {
  configPaths: [],
  dataDir: "/tmp/test-comis",
  daemonPidFile: "/tmp/test-comis/daemon.pid",
};

describe("daemonHealthCheck", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(readFileSync).mockReset();
  });

  afterEach(() => {
    if (killSpy) {
      killSpy.mockRestore();
    }
  });

  it("produces warn when PID file not found", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const findings = await daemonHealthCheck.run(baseContext);

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("warn");
    expect(findings[0].message).toContain("PID file not found");
  });

  it("produces warn when PID file has invalid content", async () => {
    vi.mocked(readFileSync).mockReturnValue("garbage" as never);

    const findings = await daemonHealthCheck.run(baseContext);

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("warn");
    expect(findings[0].message).toContain("invalid value");
  });

  it("produces fail for stale PID (process not alive)", async () => {
    vi.mocked(readFileSync).mockReturnValue("99999999" as never);

    // Spy on process.kill to throw (simulates process not running)
    killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
      throw new Error("ESRCH: no such process");
    }) as never);

    const findings = await daemonHealthCheck.run(baseContext);

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("fail");
    expect(findings[0].message).toContain("Stale PID");
    expect(findings[0].repairable).toBe(true);
  });

  it("produces pass when process is alive", async () => {
    // Use the current process PID -- process.kill(pid, 0) succeeds for own process
    vi.mocked(readFileSync).mockReturnValue(String(process.pid) as never);

    const findings = await daemonHealthCheck.run(baseContext);

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("pass");
    expect(findings[0].message).toContain("running");
  });

  it("produces pass via .daemon.lock when daemon.pid is absent (service-managed daemon)", async () => {
    // A systemd / direct-`node` daemon (the installer's production path) never
    // writes daemon.pid -- only the CLI launcher does. The daemon DOES write
    // <dataDir>/.daemon.lock (acquireDataDirLock) on every boot. Doctor must
    // fall back to that authoritative lock instead of declaring the daemon down.
    vi.mocked(readFileSync).mockImplementation(((p: string) => {
      if (p === "/tmp/test-comis/daemon.pid") {
        throw new Error("ENOENT: no such file or directory");
      }
      if (p === "/tmp/test-comis/.daemon.lock") {
        return String(process.pid); // own PID -> alive
      }
      throw new Error("ENOENT: no such file or directory");
    }) as never);

    const findings = await daemonHealthCheck.run(baseContext);

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("pass");
    expect(findings[0].message).toContain("running");
  });

  it("warns when .daemon.lock holds a dead PID and no daemon.pid exists", async () => {
    vi.mocked(readFileSync).mockImplementation(((p: string) => {
      if (p === "/tmp/test-comis/daemon.pid") {
        throw new Error("ENOENT: no such file or directory");
      }
      if (p === "/tmp/test-comis/.daemon.lock") {
        return "99999999"; // implausible PID
      }
      throw new Error("ENOENT: no such file or directory");
    }) as never);

    killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
      throw new Error("ESRCH: no such process");
    }) as never);

    const findings = await daemonHealthCheck.run(baseContext);

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("warn");
    expect(findings[0].message).toContain("PID file not found");
  });
});
