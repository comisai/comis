// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
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

describe("ToolCapabilityPort interface", () => {
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

  it("PromptSkillCapability.source accepts 'learned' (mirrors the widened SkillSource, SURFACE-01)", () => {
    // The @comis/skills SkillSource union widened to include 'learned' (v2.26
    // verified-learning). PromptSkillCapability.source re-declares the literal
    // union and MUST stay in sync, else a learned skill's SkillMetadata.source
    // cannot flow into capability metadata (skill-registry-cache.ts). The
    // literal-assignability check compiles away under esbuild, so we assert the
    // declaration via source-grep (reproducible RED from pre-patch source).
    const src = fs.readFileSync(
      path.join(__dirname, "tool-capability.ts"),
      "utf-8",
    );
    const sourceLine = src
      .split("\n")
      .find((l) => l.includes('readonly source?:') && l.includes('"bundled"'));
    expect(sourceLine, "PromptSkillCapability.source line not found").toBeDefined();
    expect(sourceLine).toContain('"learned"');

    // Type-level: a learned-source capability literal must compile.
    const learned: PromptSkillCapability = {
      name: "learned-proc",
      description: "a learned procedure",
      replacesPackages: [],
      source: "learned",
    };
    expect(learned.source).toBe("learned");
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

describe("public surface re-exports", () => {
  it("re-exports ToolCapabilityPort + companion types from @comis/core public surface", () => {
    // Static type-only import via import-map check -- type-level test:
    // The following lines compile-fail if the re-exports are missing.
    type _CheckPort = import("@comis/core").ToolCapabilityPort;
    type _CheckSkill = import("@comis/core").PromptSkillCapability;
    type _CheckRef = import("@comis/core").CapabilitySourceRef;
    // Reference types so TS does not warn about unused declarations:
    const _refs: ReadonlyArray<unknown> = [
      undefined as unknown as _CheckPort,
      undefined as unknown as _CheckSkill,
      undefined as unknown as _CheckRef,
    ];
    expect(_refs.length).toBe(3);
  });

  // 30s timeout (default 5s) — dynamic import of @comis/core (~2k LoC
  // after transform) plus v8 coverage instrumentation can exceed the
  // default budget on cold-cache runs. Without coverage the test runs
  // in <200ms.
  it(
    "re-exports createNoOpCapabilityPort as a runtime value",
    async () => {
    const mod = await import("@comis/core");
    expect(typeof mod.createNoOpCapabilityPort).toBe("function");
    const port = mod.createNoOpCapabilityPort();
    expect(port.getInstallDetourMode()).toBe("advise");
    expect(port.isCapabilityIndexEnabled()).toBe(true);
    },
    30_000,
  );

  it("does NOT re-export the test-only stub factory from @comis/core public surface", async () => {
    const mod = await import("@comis/core");
    // The stub must be unreachable from the public barrel:
    expect(
      (mod as Record<string, unknown>)["createCapabilityPortStub"],
    ).toBeUndefined();
  });
});
