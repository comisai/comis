// SPDX-License-Identifier: Apache-2.0
/**
 * Browser exposure check unit tests.
 *
 * Verifies that browserExposureCheck detects sandbox-disabled browsers,
 * browser tool enabled without explicit config, and returns no findings
 * when no agent uses browser.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { browserExposureCheck } from "./browser-exposure.js";
import type { AuditContext } from "../types.js";
import type { AppConfig } from "@comis/core";

/** Base audit context with no config. */
const baseContext: AuditContext = {
  configPaths: [],
  dataDir: "/tmp/test-data",
  skillsPaths: [],
};

/** Create a minimal context with agents and optional browser config. */
function contextWithBrowser(
  agents: Record<string, unknown>,
  browser?: Record<string, unknown>,
): AuditContext {
  return {
    ...baseContext,
    config: { agents, ...(browser ? { browser } : {}) } as unknown as AppConfig,
  };
}

describe("browserExposureCheck", () => {
  it("returns empty findings when no agents config", async () => {
    const findings = await browserExposureCheck.run(baseContext);

    expect(findings).toHaveLength(0);
  });

  it("produces warning when agent has browser tool and noSandbox is true", async () => {
    const findings = await browserExposureCheck.run(
      contextWithBrowser(
        { agent1: { skills: { builtinTools: { browser: true } } } },
        { noSandbox: true },
      ),
    );

    const finding = findings.find((f) => f.code === "SEC-BROWSER-001");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.message).toContain("agent1");
    expect(finding!.message).toContain("without sandbox");
  });

  it("produces info when agent has browser tool but browser.enabled is falsy", async () => {
    const findings = await browserExposureCheck.run(
      contextWithBrowser(
        { agent1: { skills: { builtinTools: { browser: true } } } },
      ),
    );

    const finding = findings.find((f) => f.code === "SEC-BROWSER-002");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("info");
    expect(finding!.message).toContain("Browser tool enabled");
  });

  it("returns empty findings when no agent has browser tool", async () => {
    const findings = await browserExposureCheck.run(
      contextWithBrowser(
        { agent1: { skills: { builtinTools: { webFetch: true } } } },
      ),
    );

    expect(findings).toHaveLength(0);
  });

  it("returns empty findings when browser is enabled and sandboxed", async () => {
    const findings = await browserExposureCheck.run(
      contextWithBrowser(
        { agent1: { skills: { builtinTools: { browser: true } } } },
        { enabled: true, noSandbox: false },
      ),
    );

    // Sandbox is on — no unsandboxed browser warning
    expect(findings.some((f) => f.code === "SEC-BROWSER-001")).toBe(false);
    // browser.enabled is true — no "browser tool enabled without config" info
    expect(findings.some((f) => f.code === "SEC-BROWSER-002")).toBe(false);
  });
});
