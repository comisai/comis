// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for repair-config module.
 *
 * Verifies config repair handles missing config, corrupt config,
 * and no-repairable-findings cases.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { repairConfig } from "./repair-config.js";
import type { DoctorFinding } from "../types.js";

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
}));

import { writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";

describe("repairConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty actions when no repairable findings", async () => {
    const findings: DoctorFinding[] = [
      { category: "config", check: "Config file", status: "pass", message: "OK", repairable: false },
    ];

    const result = await repairConfig(findings, []);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("creates missing config with defaults", async () => {
    const findings: DoctorFinding[] = [
      {
        category: "config",
        check: "Config file",
        status: "fail",
        message: "Config not found at /home/user/.comis/config.yaml",
        repairable: true,
      },
    ];

    const result = await repairConfig(findings, ["/custom/config.yaml"]);

    expect(result.ok).toBe(true);
    expect(mkdirSync).toHaveBeenCalledWith("/custom", { recursive: true, mode: 0o700 });
    expect(writeFileSync).toHaveBeenCalledWith(
      "/custom/config.yaml",
      expect.stringContaining("tenantId"),
      { mode: 0o600 },
    );
  });

  it("backs up corrupt config before writing defaults", async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const findings: DoctorFinding[] = [
      {
        category: "config",
        check: "Config file",
        status: "fail",
        message: "Config file is corrupt",
        repairable: true,
      },
    ];

    const result = await repairConfig(findings, ["/etc/comis/config.yaml"]);

    expect(result.ok).toBe(true);
    expect(copyFileSync).toHaveBeenCalledWith(
      "/etc/comis/config.yaml",
      expect.stringContaining(".backup."),
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      "/etc/comis/config.yaml",
      expect.stringContaining("tenantId"),
      { mode: 0o600 },
    );
  });

  it("uses fallback config path when configPaths is empty", async () => {
    const findings: DoctorFinding[] = [
      {
        category: "config",
        check: "Config file",
        status: "fail",
        message: "No config not found",
        repairable: true,
      },
    ];

    const result = await repairConfig(findings, []);

    expect(result.ok).toBe(true);
    // Falls back to homedir + /.comis/config.yaml
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("/.comis/config.yaml"),
      expect.any(String),
      { mode: 0o600 },
    );
  });
});
