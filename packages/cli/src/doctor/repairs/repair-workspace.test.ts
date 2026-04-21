// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for repair-workspace module.
 *
 * Verifies directory creation for data, log, and skills directories.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { repairWorkspace } from "./repair-workspace.js";
import type { DoctorFinding } from "../types.js";

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
}));

import { mkdirSync } from "node:fs";

describe("repairWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty actions when no repairable findings", async () => {
    const findings: DoctorFinding[] = [
      { category: "workspace", check: "Data directory", status: "pass", message: "Exists", repairable: false },
    ];

    const result = await repairWorkspace(findings, "/data");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it("creates missing data directory", async () => {
    const findings: DoctorFinding[] = [
      {
        category: "workspace",
        check: "Data directory",
        status: "fail",
        message: "Data directory missing",
        repairable: true,
      },
    ];

    const result = await repairWorkspace(findings, "/home/user/.comis");

    expect(result.ok).toBe(true);
    expect(mkdirSync).toHaveBeenCalledWith("/home/user/.comis", { recursive: true, mode: 0o700 });
  });

  it("creates missing log directory", async () => {
    const findings: DoctorFinding[] = [
      {
        category: "workspace",
        check: "Log directory",
        status: "fail",
        message: "Log directory missing",
        repairable: true,
      },
    ];

    const result = await repairWorkspace(findings, "/data");

    expect(result.ok).toBe(true);
    expect(mkdirSync).toHaveBeenCalledWith("/data/logs", { recursive: true, mode: 0o700 });
  });

  it("creates missing skills directory from finding message path", async () => {
    const findings: DoctorFinding[] = [
      {
        category: "workspace",
        check: "Skills directory",
        status: "fail",
        message: "Skills directory missing: /data/skills/custom",
        repairable: true,
      },
    ];

    const result = await repairWorkspace(findings, "/data");

    expect(result.ok).toBe(true);
    expect(mkdirSync).toHaveBeenCalledWith("/data/skills/custom", { recursive: true, mode: 0o700 });
  });

  it("handles Data directory writable check", async () => {
    const findings: DoctorFinding[] = [
      {
        category: "workspace",
        check: "Data directory writable",
        status: "fail",
        message: "Data directory not writable",
        repairable: true,
      },
    ];

    const result = await repairWorkspace(findings, "/data");

    expect(result.ok).toBe(true);
    expect(mkdirSync).toHaveBeenCalledWith("/data", { recursive: true, mode: 0o700 });
  });
});
