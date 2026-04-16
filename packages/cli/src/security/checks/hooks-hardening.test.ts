/**
 * Hooks hardening check unit tests.
 *
 * Verifies that hooksHardeningCheck detects behavior-modifying hooks,
 * hooks active without audit logging, and returns no findings for
 * disabled plugins or safe configurations.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { hooksHardeningCheck } from "./hooks-hardening.js";
import type { AuditContext } from "../types.js";
import type { AppConfig } from "@comis/core";

/** Base audit context with no config. */
const baseContext: AuditContext = {
  configPaths: [],
  dataDir: "/tmp/test-data",
  skillsPaths: [],
};

/** Create a minimal context with plugins and optional security config. */
function contextWithPlugins(
  plugins: Record<string, unknown>,
  security?: Record<string, unknown>,
): AuditContext {
  return {
    ...baseContext,
    config: {
      plugins: { plugins },
      ...(security ? { security } : {}),
    } as unknown as AppConfig,
  };
}

describe("hooksHardeningCheck", () => {
  it("returns empty findings when no plugins config", async () => {
    const findings = await hooksHardeningCheck.run(baseContext);

    expect(findings).toHaveLength(0);
  });

  it("returns empty findings when plugins object is empty", async () => {
    const findings = await hooksHardeningCheck.run(
      contextWithPlugins({}),
    );

    expect(findings).toHaveLength(0);
  });

  it("produces warning for behavior-modifying hook (before_send)", async () => {
    const findings = await hooksHardeningCheck.run(
      contextWithPlugins({
        "my-plugin": {
          enabled: true,
          config: { hooks: { before_send: {} } },
        },
      }),
    );

    const finding = findings.find((f) => f.code === "SEC-HOOK-001");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.message).toContain("my-plugin");
    expect(finding!.message).toContain("before_send");
  });

  it("produces warning for before_agent_start hook", async () => {
    const findings = await hooksHardeningCheck.run(
      contextWithPlugins({
        "modifier-plugin": {
          enabled: true,
          config: { hooks: { before_agent_start: {} } },
        },
      }),
    );

    const finding = findings.find((f) => f.code === "SEC-HOOK-001");
    expect(finding).toBeDefined();
    expect(finding!.message).toContain("before_agent_start");
  });

  it("does NOT produce a finding for non-behavior-modifying hooks", async () => {
    const findings = await hooksHardeningCheck.run(
      contextWithPlugins({
        "log-plugin": {
          enabled: true,
          config: { hooks: { after_send: {} } },
        },
      }),
    );

    expect(findings.some((f) => f.code === "SEC-HOOK-001")).toBe(false);
  });

  it("produces critical when hooks active but auditLog is false", async () => {
    const findings = await hooksHardeningCheck.run(
      contextWithPlugins(
        {
          "my-plugin": {
            enabled: true,
            config: { hooks: { after_send: {} } },
          },
        },
        { auditLog: false },
      ),
    );

    const finding = findings.find((f) => f.code === "SEC-HOOK-002");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("critical");
    expect(finding!.message).toContain("without audit logging");
  });

  it("returns empty findings for disabled plugins with hooks", async () => {
    const findings = await hooksHardeningCheck.run(
      contextWithPlugins({
        "my-plugin": {
          enabled: false,
          config: { hooks: { before_send: {} } },
        },
      }),
    );

    expect(findings).toHaveLength(0);
  });

  it("skips plugins where config.hooks is not an object", async () => {
    const findings = await hooksHardeningCheck.run(
      contextWithPlugins({
        "my-plugin": {
          enabled: true,
          config: { hooks: "not-an-object" },
        },
      }),
    );

    expect(findings).toHaveLength(0);
  });
});
