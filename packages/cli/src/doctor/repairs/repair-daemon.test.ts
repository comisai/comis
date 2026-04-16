/**
 * Tests for repair-daemon module.
 *
 * Verifies stale PID file removal and no-op on non-repairable findings.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { repairDaemon } from "./repair-daemon.js";
import type { DoctorFinding } from "../types.js";

vi.mock("node:fs", () => ({
  unlinkSync: vi.fn(),
}));

import { unlinkSync } from "node:fs";

describe("repairDaemon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty actions when no repairable findings", async () => {
    const findings: DoctorFinding[] = [
      { category: "daemon", check: "PID file", status: "pass", message: "OK", repairable: false },
    ];

    const result = await repairDaemon(findings, "/tmp/daemon.pid");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it("removes stale PID file for repairable finding", async () => {
    const findings: DoctorFinding[] = [
      {
        category: "daemon",
        check: "PID file",
        status: "fail",
        message: "Stale PID file found",
        repairable: true,
      },
    ];

    const result = await repairDaemon(findings, "/tmp/daemon.pid");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]).toContain("Removed stale PID file");
    }
    expect(unlinkSync).toHaveBeenCalledWith("/tmp/daemon.pid");
  });

  it("removes PID file for each repairable finding", async () => {
    const findings: DoctorFinding[] = [
      { category: "daemon", check: "PID-1", status: "fail", message: "Stale", repairable: true },
      { category: "daemon", check: "PID-2", status: "fail", message: "Stale", repairable: true },
    ];

    const result = await repairDaemon(findings, "/var/run/daemon.pid");

    expect(result.ok).toBe(true);
    expect(unlinkSync).toHaveBeenCalledTimes(2);
  });
});
