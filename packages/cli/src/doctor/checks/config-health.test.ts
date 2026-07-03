// SPDX-License-Identifier: Apache-2.0
/**
 * Config health check unit tests.
 *
 * Tests config-health check for missing, corrupt, schema-invalid,
 * unresolved-secret-reference, and valid config scenarios — driven through
 * the shared store-aware resolution on the context (the check's contract).
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type { DoctorContext } from "../types.js";

// Mock the shared resolver so the fallback path (no resolution on the
// context) is observable without touching the real filesystem.
vi.mock("../config-resolve.js", () => ({
  resolveDoctorConfig: vi.fn(),
}));

const { resolveDoctorConfig } = await import("../config-resolve.js");
const { configHealthCheck } = await import("./config-health.js");

const baseContext: DoctorContext = {
  configPaths: ["/cfg/config.yaml"],
  dataDir: "/tmp/test-comis",
  daemonPidFile: "/tmp/test-comis/daemon.pid",
};

describe("configHealthCheck", () => {
  beforeEach(() => {
    vi.mocked(resolveDoctorConfig).mockReset();
  });

  it("produces fail when no config paths provided", async () => {
    const findings = await configHealthCheck.run({ ...baseContext, configPaths: [] });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("fail");
    expect(findings[0]?.message).toContain("No config file paths");
    expect(findings[0]?.repairable).toBe(true);
  });

  it("produces fail when config file not found", async () => {
    const findings = await configHealthCheck.run({
      ...baseContext,
      configResolution: {
        loadError: { kind: "missing", message: "No config file found at any configured path" },
      },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("fail");
    expect(findings[0]?.message).toContain("No config file found");
    expect(findings[0]?.repairable).toBe(true);
  });

  it("produces fail when config is corrupt YAML", async () => {
    const findings = await configHealthCheck.run({
      ...baseContext,
      configResolution: {
        foundPath: "/cfg/config.yaml",
        loadError: { kind: "unparseable", message: "Config file is corrupt: /cfg/config.yaml" },
      },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("fail");
    expect(findings[0]?.message).toContain("corrupt");
    expect(findings[0]?.repairable).toBe(true);
  });

  it("produces warn when config has schema validation issues", async () => {
    const findings = await configHealthCheck.run({
      ...baseContext,
      configResolution: {
        foundPath: "/cfg/config.yaml",
        validationIssues: ["agents: Required"],
      },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("warn");
    expect(findings[0]?.message).toContain("validation issues");
  });

  it("names unresolved secret references and the places checked before the validation noise they cause", async () => {
    const findings = await configHealthCheck.run({
      ...baseContext,
      configResolution: {
        foundPath: "/cfg/config.yaml",
        unresolvedRefs: [{ path: "gateway.tokens[0].secret", varName: "COMIS_GATEWAY_TOKEN" }],
        validationIssues: [
          "gateway.tokens.0.secret: Too small: expected string to have >=32 characters",
        ],
      },
    });

    expect(findings).toHaveLength(2);
    expect(findings[0]?.status).toBe("warn");
    expect(findings[0]?.message).toContain("COMIS_GATEWAY_TOKEN");
    expect(findings[0]?.message).toContain("gateway.tokens[0].secret");
    expect(findings[0]?.message).toContain("encrypted secret store");
    expect(findings[1]?.status).toBe("warn");
    expect(findings[1]?.message).toContain("validation issues");
  });

  it("produces pass for valid config", async () => {
    const findings = await configHealthCheck.run({
      ...baseContext,
      configResolution: {
        foundPath: "/cfg/config.yaml",
        config: {} as never,
      },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("pass");
    expect(findings[0]?.message).toContain("valid");
  });

  it("falls back to resolving the config itself when the context carries no resolution", async () => {
    vi.mocked(resolveDoctorConfig).mockReturnValue({
      foundPath: "/cfg/config.yaml",
      config: {} as never,
    });

    const findings = await configHealthCheck.run({ ...baseContext });

    expect(vi.mocked(resolveDoctorConfig)).toHaveBeenCalledWith(["/cfg/config.yaml"]);
    expect(findings[0]?.status).toBe("pass");
  });
});
