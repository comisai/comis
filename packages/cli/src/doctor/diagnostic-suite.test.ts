// SPDX-License-Identifier: Apache-2.0
import { AppConfigSchema } from "@comis/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config-resolve.js", () => ({
  resolveDoctorConfig: vi.fn(),
}));

vi.mock("../util/cli-version.js", () => ({
  readCliVersion: vi.fn(() => "test-cli-version"),
}));

const { resolveDoctorConfig } = await import("./config-resolve.js");
const {
  DIAGNOSTIC_CHECKS,
  buildDiagnosticContext,
  resolveDefaultDiagnosticConfigPaths,
} = await import("./diagnostic-suite.js");

describe("diagnostic suite", () => {
  beforeEach(() => {
    vi.mocked(resolveDoctorConfig).mockReset();
  });

  it("keeps health and doctor on the complete ten-check registry", () => {
    expect(DIAGNOSTIC_CHECKS.map((check) => check.id)).toEqual([
      "config-health",
      "daemon-health",
      "gateway-health",
      "version-skew-health",
      "channel-health",
      "msteams-health",
      "workspace-health",
      "oauth-health",
      "secrets-audit",
      "lcd-health",
    ]);
  });

  it("builds every diagnostic context from the store-aware config resolution", () => {
    const config = AppConfigSchema.parse({
      dataDir: "/srv/comis-data",
      gateway: { host: "0.0.0.0", port: 9876 },
    });
    const configResolution = { config, foundPath: "/cfg/config.yaml" };
    vi.mocked(resolveDoctorConfig).mockReturnValue(configResolution);

    const context = buildDiagnosticContext(["/cfg/config.yaml"]);

    expect(resolveDoctorConfig).toHaveBeenCalledWith(["/cfg/config.yaml"]);
    expect(context.configResolution).toBe(configResolution);
    expect(context.config).toBe(config);
    expect(context.dataDir).toBe("/srv/comis-data");
    expect(context.daemonPidFile).toBe("/srv/comis-data/daemon.pid");
    expect(context.memoryDbPath).toBe("/srv/comis-data/memory.db");
    expect(context.gatewayUrl).toBe("http://127.0.0.1:9876");
    expect(context.cliVersion).toBe("test-cli-version");
  });

  it("parses COMIS_CONFIG_PATHS with the documented comma separator", () => {
    expect(
      resolveDefaultDiagnosticConfigPaths(" /cfg/base.yaml, /cfg/local.yaml ", "/home/test"),
    ).toEqual(["/cfg/base.yaml", "/cfg/local.yaml"]);
  });

  it("formats an IPv6 wildcard bind as a valid loopback URL", () => {
    const config = AppConfigSchema.parse({
      dataDir: "/srv/comis-data",
      gateway: { host: "::", port: 9876 },
    });
    vi.mocked(resolveDoctorConfig).mockReturnValue({ config, foundPath: "/cfg/config.yaml" });

    const context = buildDiagnosticContext(["/cfg/config.yaml"]);

    expect(context.gatewayUrl).toBe("http://[::1]:9876");
  });

  it("honors COMIS_DATA_DIR and resolves a relative memory db path like bootstrap", () => {
    const config = AppConfigSchema.parse({ memory: { dbPath: "stores/runtime.db" } });
    vi.mocked(resolveDoctorConfig).mockReturnValue({ config, foundPath: "/cfg/config.yaml" });

    const context = buildDiagnosticContext(["/cfg/config.yaml"], {
      getEnv: (key) => key === "COMIS_DATA_DIR" ? "/srv/runtime" : undefined,
      homeDir: "/home/test",
    });

    expect(context.dataDir).toBe("/srv/runtime");
    expect(context.daemonPidFile).toBe("/srv/runtime/daemon.pid");
    expect(context.memoryDbPath).toBe("/srv/runtime/stores/runtime.db");
  });

  it("treats an empty COMIS_DATA_DIR as unset and uses the injected home default", () => {
    const config = AppConfigSchema.parse({});
    vi.mocked(resolveDoctorConfig).mockReturnValue({ config, foundPath: "/cfg/config.yaml" });

    const context = buildDiagnosticContext(["/cfg/config.yaml"], {
      getEnv: () => "",
      homeDir: "/home/test",
    });

    expect(context.dataDir).toBe("/home/test/.comis");
    expect(context.memoryDbPath).toBe("/home/test/.comis/memory.db");
  });

  it("preserves an absolute memory db path instead of rebasing it under dataDir", () => {
    const config = AppConfigSchema.parse({
      dataDir: "/srv/runtime",
      memory: { dbPath: "/var/lib/comis/custom.db" },
    });
    vi.mocked(resolveDoctorConfig).mockReturnValue({ config, foundPath: "/cfg/config.yaml" });

    const context = buildDiagnosticContext(["/cfg/config.yaml"], { homeDir: "/home/test" });

    expect(context.memoryDbPath).toBe("/var/lib/comis/custom.db");
  });

  it("does not invent a gateway URL when the gateway is explicitly disabled", () => {
    const config = AppConfigSchema.parse({ gateway: { enabled: false } });
    vi.mocked(resolveDoctorConfig).mockReturnValue({ config, foundPath: "/cfg/config.yaml" });

    const context = buildDiagnosticContext(["/cfg/config.yaml"]);

    expect(context.gatewayUrl).toBeUndefined();
  });

  it("formats a TLS IPv6 endpoint as a valid HTTPS URL", () => {
    const config = AppConfigSchema.parse({
      gateway: {
        host: "2001:db8::1",
        port: 8443,
        tls: {
          certPath: "/cert.pem",
          keyPath: "/key.pem",
          caPath: "/ca.pem",
        },
      },
    });
    vi.mocked(resolveDoctorConfig).mockReturnValue({ config, foundPath: "/cfg/config.yaml" });

    const context = buildDiagnosticContext(["/cfg/config.yaml"]);

    expect(context.gatewayUrl).toBe("https://[2001:db8::1]:8443");
  });
});
