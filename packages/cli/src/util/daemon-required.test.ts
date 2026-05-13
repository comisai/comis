// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the daemon-guard isDaemonRunning before importing daemon-required.
vi.mock("../sync-tooling/daemon-guard.js", () => ({
  isDaemonRunning: vi.fn(),
}));

import { isDaemonRunning } from "../sync-tooling/daemon-guard.js";
import {
  requireDaemonOrExit,
  REMEDIATION_MESSAGE,
  DAEMON_PROBE_TIMEOUT_MS,
} from "./daemon-required.js";

describe("requireDaemonOrExit (MEM-CTX-PORTS-12)", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    vi.mocked(isDaemonRunning).mockReset();
  });

  it("returns without effect when isDaemonRunning resolves true", async () => {
    vi.mocked(isDaemonRunning).mockResolvedValue(true);
    await expect(requireDaemonOrExit()).resolves.toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("writes REMEDIATION_MESSAGE to stderr and exits with code 4 when isDaemonRunning resolves false", async () => {
    vi.mocked(isDaemonRunning).mockResolvedValue(false);
    await expect(requireDaemonOrExit()).rejects.toThrow(/process\.exit\(4\)/);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = stderrSpy.mock.calls[0]?.[0] as string;
    expect(written).toContain("ERROR: This command requires the comis daemon");
    expect(written).toContain("Start it with:    comis start");
    expect(written.startsWith(REMEDIATION_MESSAGE)).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(4);
  });

  it("respects custom timeoutMs argument", async () => {
    vi.mocked(isDaemonRunning).mockResolvedValue(true);
    await requireDaemonOrExit(50);
    expect(isDaemonRunning).toHaveBeenCalledWith(50);
  });

  it("DAEMON_PROBE_TIMEOUT_MS === 200 (MEM-CTX-PORTS-12 contract)", () => {
    expect(DAEMON_PROBE_TIMEOUT_MS).toBe(200);
  });

  it("REMEDIATION_MESSAGE matches MEM-CTX-PORTS-10 contract — starts with ERROR + names comis start/status/logs", () => {
    expect(REMEDIATION_MESSAGE).toMatch(
      /^ERROR: This command requires the comis daemon, which is not running\./,
    );
    expect(REMEDIATION_MESSAGE).toContain("comis start");
    expect(REMEDIATION_MESSAGE).toContain("comis status");
    expect(REMEDIATION_MESSAGE).toContain("comis logs");
    expect(REMEDIATION_MESSAGE).toContain("comis secrets init");
    expect(REMEDIATION_MESSAGE).toContain("comis secrets audit");
  });
});
