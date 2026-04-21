// SPDX-License-Identifier: Apache-2.0
/**
 * Model hygiene check unit tests.
 *
 * Verifies that modelHygieneCheck detects missing model allowlists
 * with open failover and weak/small model names, and returns no
 * findings for clean configurations.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { modelHygieneCheck } from "./model-hygiene.js";
import type { AuditContext } from "../types.js";
import type { AppConfig } from "@comis/core";

/** Base audit context with no config. */
const baseContext: AuditContext = {
  configPaths: [],
  dataDir: "/tmp/test-data",
  skillsPaths: [],
};

/** Create a minimal context with agents config. */
function contextWithAgents(agents: Record<string, unknown>): AuditContext {
  return {
    ...baseContext,
    config: { agents } as unknown as AppConfig,
  };
}

describe("modelHygieneCheck", () => {
  it("returns empty findings when no agents config", async () => {
    const findings = await modelHygieneCheck.run(baseContext);

    expect(findings).toHaveLength(0);
  });

  it("produces warning for agent with fallbackModels but no allowedModels", async () => {
    const findings = await modelHygieneCheck.run(
      contextWithAgents({
        agent1: {
          model: "claude-sonnet-4-20250514",
          modelFailover: {
            fallbackModels: ["gpt-4o"],
          },
        },
      }),
    );

    const finding = findings.find((f) => f.code === "SEC-MODEL-001");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.message).toContain("agent1");
    expect(finding!.message).toContain("allowlist");
  });

  it("does NOT produce a finding when allowedModels present with fallbacks", async () => {
    const findings = await modelHygieneCheck.run(
      contextWithAgents({
        agent1: {
          model: "claude-sonnet-4-20250514",
          modelFailover: {
            fallbackModels: ["gpt-4o"],
            allowedModels: ["claude-sonnet-4-20250514", "gpt-4o"],
          },
        },
      }),
    );

    expect(findings.some((f) => f.code === "SEC-MODEL-001")).toBe(false);
  });

  it("produces warning for agent with 'nano' in model name", async () => {
    const findings = await modelHygieneCheck.run(
      contextWithAgents({
        agent1: { model: "gemini-nano-2" },
      }),
    );

    const finding = findings.find((f) => f.code === "SEC-MODEL-002");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.message).toContain("Small parameter");
    expect(finding!.message).toContain("gemini-nano-2");
  });

  it("produces warning for agent with 'mini' in model name", async () => {
    const findings = await modelHygieneCheck.run(
      contextWithAgents({
        agent1: { model: "gpt-4o-mini" },
      }),
    );

    const finding = findings.find((f) => f.code === "SEC-MODEL-002");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.message).toContain("gpt-4o-mini");
  });

  it("returns empty findings for agent with normal model name and no failover", async () => {
    const findings = await modelHygieneCheck.run(
      contextWithAgents({
        agent1: { model: "claude-sonnet-4-20250514" },
      }),
    );

    expect(findings).toHaveLength(0);
  });
});
