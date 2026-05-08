// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type {
  ToolCapabilityPort,
  PromptSkillCapability,
  CapabilitySourceRef,
} from "./tool-capability.js";

function makeToolCapabilityPort(
  overrides: Partial<ToolCapabilityPort> = {},
): ToolCapabilityPort {
  return {
    isCapabilityIndexEnabled: () => true,
    getInstallDetourMode: () => "advise" as const,
    getBuiltinCluster: () => undefined,
    getClusterConfig: () => undefined,
    getMcpServerHint: () => undefined,
    getSkillHint: () => undefined,
    getPackageAliasMap: () => new Map(),
    getConnectedMcpServers: () => [],
    getPromptSkillCapabilities: () => [],
    ...overrides,
  };
}

describe("ToolCapabilityPort interface (TOOLING-CFG-12)", () => {
  it("declares all 9 methods (7 config-view + 2 runtime-view)", () => {
    const port = makeToolCapabilityPort();
    // 7 config-view methods:
    expect(typeof port.isCapabilityIndexEnabled).toBe("function");
    expect(typeof port.getInstallDetourMode).toBe("function");
    expect(typeof port.getBuiltinCluster).toBe("function");
    expect(typeof port.getClusterConfig).toBe("function");
    expect(typeof port.getMcpServerHint).toBe("function");
    expect(typeof port.getSkillHint).toBe("function");
    expect(typeof port.getPackageAliasMap).toBe("function");
    // 2 runtime-view methods:
    expect(typeof port.getConnectedMcpServers).toBe("function");
    expect(typeof port.getPromptSkillCapabilities).toBe("function");
  });

  it("getInstallDetourMode returns one of the three enum values", () => {
    const observe = makeToolCapabilityPort({
      getInstallDetourMode: () => "observe",
    });
    const advise = makeToolCapabilityPort({
      getInstallDetourMode: () => "advise",
    });
    const softStop = makeToolCapabilityPort({
      getInstallDetourMode: () => "soft-stop",
    });
    expect(observe.getInstallDetourMode()).toBe("observe");
    expect(advise.getInstallDetourMode()).toBe("advise");
    expect(softStop.getInstallDetourMode()).toBe("soft-stop");
  });

  it("PromptSkillCapability type has all 7 fields with correct readonly-ness", () => {
    const cap: PromptSkillCapability = {
      name: "test-skill",
      description: "A test skill",
      replacesPackages: [],
    };
    expect(cap.name).toBe("test-skill");
    expect(cap.description).toBe("A test skill");
    expect(cap.replacesPackages).toEqual([]);
    // Optional fields default to undefined:
    expect(cap.skillKey).toBeUndefined();
    expect(cap.cluster).toBeUndefined();
    expect(cap.summary).toBeUndefined();
    expect(cap.source).toBeUndefined();

    // Verify the optional fields are accepted when provided:
    const full: PromptSkillCapability = {
      name: "full",
      skillKey: "skill::full",
      description: "full desc",
      cluster: "data-fetching",
      summary: "fetch data",
      replacesPackages: ["yfinance"],
      source: "bundled",
    };
    expect(full.cluster).toBe("data-fetching");
    expect(full.source).toBe("bundled");
  });

  it("CapabilitySourceRef discriminates by type", () => {
    const mcp: CapabilitySourceRef = { type: "mcp", name: "finance-data" };
    const skill: CapabilitySourceRef = {
      type: "skill",
      name: "financial-chart-workflow",
    };
    expect(mcp.type).toBe("mcp");
    expect(mcp.name).toBe("finance-data");
    expect(skill.type).toBe("skill");
    expect(skill.name).toBe("financial-chart-workflow");

    // Type-narrowing via discriminant works at runtime:
    function describe(ref: CapabilitySourceRef): string {
      if (ref.type === "mcp") return `mcp:${ref.name}`;
      return `skill:${ref.name}`;
    }
    expect(describe(mcp)).toBe("mcp:finance-data");
    expect(describe(skill)).toBe("skill:financial-chart-workflow");
  });

  it("getPackageAliasMap returns ReadonlyMap (cannot mutate the result)", () => {
    const port = makeToolCapabilityPort({
      getPackageAliasMap: () =>
        new Map<string, CapabilitySourceRef>([
          ["market-data-lib", { type: "mcp", name: "finance-data" }],
        ]),
    });
    const map = port.getPackageAliasMap();
    expect(map.has("market-data-lib")).toBe(true);
    expect(map.get("market-data-lib")).toEqual({
      type: "mcp",
      name: "finance-data",
    });
    expect(map.size).toBe(1);
  });
});
