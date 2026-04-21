// SPDX-License-Identifier: Apache-2.0
/**
 * Config health check unit tests.
 *
 * Tests config-health check for missing, corrupt, schema-invalid,
 * and valid config file scenarios.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type { DoctorContext } from "../types.js";

// Mock node:fs readFileSync
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

// Mock yaml parse
vi.mock("yaml", () => ({
  parse: vi.fn(),
}));

// Mock @comis/core AppConfigSchema
vi.mock("@comis/core", () => ({
  AppConfigSchema: {
    safeParse: vi.fn(),
  },
}));

const { readFileSync } = await import("node:fs");
const { parse: parseYaml } = await import("yaml");
const { AppConfigSchema } = await import("@comis/core");
const { configHealthCheck } = await import("./config-health.js");

const baseContext: DoctorContext = {
  configPaths: [],
  dataDir: "/tmp/test-comis",
  daemonPidFile: "/tmp/test-comis/daemon.pid",
};

describe("configHealthCheck", () => {
  beforeEach(() => {
    vi.mocked(readFileSync).mockReset();
    vi.mocked(parseYaml).mockReset();
    vi.mocked(AppConfigSchema.safeParse).mockReset();
  });

  it("produces fail when no config paths provided", async () => {
    const findings = await configHealthCheck.run({ ...baseContext, configPaths: [] });

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("fail");
    expect(findings[0].message).toContain("No config file paths");
    expect(findings[0].repairable).toBe(true);
  });

  it("produces fail when config file not found", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const findings = await configHealthCheck.run({
      ...baseContext,
      configPaths: ["/tmp/missing.yaml"],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("fail");
    expect(findings[0].message).toContain("No config file found");
  });

  it("produces fail when config is corrupt YAML", async () => {
    vi.mocked(readFileSync).mockReturnValue("invalid: {yaml" as never);
    vi.mocked(parseYaml).mockImplementation(() => {
      throw new SyntaxError("Unexpected token");
    });

    const findings = await configHealthCheck.run({
      ...baseContext,
      configPaths: ["/tmp/corrupt.yaml"],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("fail");
    expect(findings[0].message).toContain("corrupt");
    expect(findings[0].repairable).toBe(true);
  });

  it("produces warn when config has schema validation issues", async () => {
    vi.mocked(readFileSync).mockReturnValue("tenantId: test\n" as never);
    vi.mocked(parseYaml).mockReturnValue({ invalid: true });
    vi.mocked(AppConfigSchema.safeParse).mockReturnValue({
      success: false,
      error: {
        issues: [{ path: ["agents"], message: "Required" }],
      },
    } as never);

    const findings = await configHealthCheck.run({
      ...baseContext,
      configPaths: ["/tmp/bad-schema.yaml"],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("warn");
    expect(findings[0].message).toContain("validation issues");
  });

  it("produces pass for valid config", async () => {
    vi.mocked(readFileSync).mockReturnValue("tenantId: default\n" as never);
    vi.mocked(parseYaml).mockReturnValue({ tenantId: "default" });
    vi.mocked(AppConfigSchema.safeParse).mockReturnValue({ success: true } as never);

    const findings = await configHealthCheck.run({
      ...baseContext,
      configPaths: ["/tmp/valid.yaml"],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("pass");
    expect(findings[0].message).toContain("valid");
  });
});
