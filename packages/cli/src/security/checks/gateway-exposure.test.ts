/**
 * Gateway exposure check unit tests.
 *
 * Verifies that gatewayExposureCheck correctly identifies security risks:
 * binding to 0.0.0.0 without TLS (critical), with TLS (warning),
 * missing auth tokens (critical), wildcard CORS (warning),
 * and produces no findings for secure configurations.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { gatewayExposureCheck } from "./gateway-exposure.js";
import type { AuditContext } from "../types.js";
import type { AppConfig } from "@comis/core";

/** Base audit context with no config. */
const baseContext: AuditContext = {
  configPaths: [],
  dataDir: "/tmp/test-data",
  skillsPaths: [],
};

/** Create a minimal context with gateway config. */
function contextWithGateway(gateway: Record<string, unknown>): AuditContext {
  return {
    ...baseContext,
    config: { gateway } as unknown as AppConfig,
  };
}

describe("gatewayExposureCheck", () => {
  it("returns empty findings when no gateway config", async () => {
    const findings = await gatewayExposureCheck.run(baseContext);

    expect(findings).toHaveLength(0);
  });

  it("produces critical for 0.0.0.0 without TLS", async () => {
    const findings = await gatewayExposureCheck.run(
      contextWithGateway({ host: "0.0.0.0", port: 3000 }),
    );

    const gwFinding = findings.find((f) => f.code === "SEC-GW-001");
    expect(gwFinding).toBeDefined();
    expect(gwFinding!.severity).toBe("critical");
    expect(gwFinding!.message).toContain("0.0.0.0");
    expect(gwFinding!.message).toContain("without TLS");
  });

  it("produces warning for 0.0.0.0 with TLS", async () => {
    const findings = await gatewayExposureCheck.run(
      contextWithGateway({
        host: "0.0.0.0",
        port: 3000,
        tls: { certPath: "/cert", keyPath: "/key" },
      }),
    );

    const gwFinding = findings.find((f) => f.code === "SEC-GW-002");
    expect(gwFinding).toBeDefined();
    expect(gwFinding!.severity).toBe("warning");
    expect(gwFinding!.message).toContain("0.0.0.0");
  });

  it("produces critical for missing tokens", async () => {
    const findings = await gatewayExposureCheck.run(
      contextWithGateway({ host: "127.0.0.1", port: 3000, tokens: [] }),
    );

    const tokenFinding = findings.find((f) => f.code === "SEC-GW-003");
    expect(tokenFinding).toBeDefined();
    expect(tokenFinding!.severity).toBe("critical");
    expect(tokenFinding!.message).toContain("token");
  });

  it("produces warning for wildcard CORS", async () => {
    const findings = await gatewayExposureCheck.run(
      contextWithGateway({
        host: "127.0.0.1",
        port: 3000,
        tokens: ["t1"],
        corsOrigins: ["*"],
      }),
    );

    const corsFinding = findings.find((f) => f.code === "SEC-GW-004");
    expect(corsFinding).toBeDefined();
    expect(corsFinding!.severity).toBe("warning");
    expect(corsFinding!.message).toContain("wildcard");
  });

  it("produces no findings for secure gateway config", async () => {
    const findings = await gatewayExposureCheck.run(
      contextWithGateway({
        host: "127.0.0.1",
        port: 3000,
        tokens: ["t1"],
        corsOrigins: ["https://example.com"],
      }),
    );

    expect(findings).toHaveLength(0);
  });
});
