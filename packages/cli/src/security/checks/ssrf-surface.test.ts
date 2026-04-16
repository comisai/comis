/**
 * SSRF surface check unit tests.
 *
 * Verifies that ssrfSurfaceCheck detects web tools enabled without
 * the Node.js permission model, permissions active without host
 * restrictions, and returns no findings for secure or tool-free
 * configurations.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { ssrfSurfaceCheck } from "./ssrf-surface.js";
import type { AuditContext } from "../types.js";
import type { AppConfig } from "@comis/core";

/** Base audit context with no config. */
const baseContext: AuditContext = {
  configPaths: [],
  dataDir: "/tmp/test-data",
  skillsPaths: [],
};

/** Create a minimal context with agents and optional security config. */
function contextWithAgents(
  agents: Record<string, unknown>,
  security?: Record<string, unknown>,
): AuditContext {
  return {
    ...baseContext,
    config: {
      agents,
      ...(security ? { security } : {}),
    } as unknown as AppConfig,
  };
}

describe("ssrfSurfaceCheck", () => {
  it("returns empty findings when no agents config", async () => {
    const findings = await ssrfSurfaceCheck.run(baseContext);

    expect(findings).toHaveLength(0);
  });

  it("produces warning when webFetch enabled without permissions", async () => {
    const findings = await ssrfSurfaceCheck.run(
      contextWithAgents({
        a1: { skills: { builtinTools: { webFetch: true } } },
      }),
    );

    const finding = findings.find((f) => f.code === "SEC-SSRF-001");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.message).toContain("a1");
    expect(finding!.message).toContain("webFetch");
  });

  it("produces warning when webSearch enabled without permissions", async () => {
    const findings = await ssrfSurfaceCheck.run(
      contextWithAgents({
        a1: { skills: { builtinTools: { webSearch: true } } },
      }),
    );

    const finding = findings.find((f) => f.code === "SEC-SSRF-001");
    expect(finding).toBeDefined();
    expect(finding!.message).toContain("webSearch");
  });

  it("includes both tool names in message when both enabled", async () => {
    const findings = await ssrfSurfaceCheck.run(
      contextWithAgents({
        a1: { skills: { builtinTools: { webFetch: true, webSearch: true } } },
      }),
    );

    const finding = findings.find((f) => f.code === "SEC-SSRF-001");
    expect(finding).toBeDefined();
    expect(finding!.message).toContain("webFetch");
    expect(finding!.message).toContain("webSearch");
  });

  it("produces warning when permissions enabled but allowedNetHosts is empty", async () => {
    const findings = await ssrfSurfaceCheck.run(
      contextWithAgents(
        { a1: { skills: { builtinTools: { webFetch: true } } } },
        {
          permission: {
            enableNodePermissions: true,
            allowedNetHosts: [],
          },
        },
      ),
    );

    const finding = findings.find((f) => f.code === "SEC-SSRF-002");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.message).toContain("no network host restrictions");
  });

  it("returns empty findings when permissions enabled with allowedNetHosts", async () => {
    const findings = await ssrfSurfaceCheck.run(
      contextWithAgents(
        { a1: { skills: { builtinTools: { webFetch: true } } } },
        {
          permission: {
            enableNodePermissions: true,
            allowedNetHosts: ["api.example.com"],
          },
        },
      ),
    );

    expect(findings).toHaveLength(0);
  });

  it("returns empty findings when no agent has web tools", async () => {
    const findings = await ssrfSurfaceCheck.run(
      contextWithAgents({
        a1: { skills: { builtinTools: { bash: true } } },
      }),
    );

    expect(findings).toHaveLength(0);
  });
});
