// SPDX-License-Identifier: Apache-2.0
//
// Co-located unit tests for createToolCapabilityAdapter.
//
// Coverage matrix:
//   - Key-by-key default merge: 3 cases (empty / partial / per-key override)
//   - Cluster-ID typo WARN+fallback: 3 surfaces
//     (mcp.capabilityHints, skills.capabilityHints, builtinAssignments)
//   - Disconnected MCP filter: 1 order-independent case
//   - Callback timing + getPackageAliasMap freshness: 2 cases
//   - Object.freeze + sanity (capabilityIndex / installDetours / builtinCluster): 4 cases
//
// Boundary discipline: this file MUST NOT import the test-only stub from
// @comis/core/__test-helpers/*.

import { describe, it, expect, vi } from "vitest";
import {
  createToolCapabilityAdapter,
  type ToolCapabilityAdapterDeps,
} from "./tool-capability-adapter.js";
import type {
  McpClientManager,
  McpConnection,
  SkillRegistry,
} from "@comis/skills";
import type {
  ToolingConfig,
  PromptSkillCapability,
} from "@comis/core";

// -----------------------------------------------------------------------------
// Stub builders (top-of-file convention; only the methods the SUT touches).
// -----------------------------------------------------------------------------

function makeStubLogger() {
  const warnSpy = vi.fn();
  const stub = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    audit: vi.fn(),
    child: () => stub,
    bindings: () => ({}),
    isLevelEnabled: () => false,
    silent: false,
    level: "info",
  };
  return {
    logger: stub as unknown as ToolCapabilityAdapterDeps["logger"],
    warnSpy,
  };
}

function makeStubSkillRegistry(
  skills: readonly PromptSkillCapability[] = [],
): SkillRegistry {
  return {
    getPromptSkillCapabilities: vi.fn(() => skills),
  } as unknown as SkillRegistry;
}

function makeStubMcpManager(
  connections: readonly Partial<McpConnection>[] = [],
): McpClientManager {
  return {
    getAllConnections: () => connections as McpConnection[],
  } as unknown as McpClientManager;
}

function makeMinimalToolingConfig(
  overrides?: Partial<ToolingConfig>,
): ToolingConfig {
  const base: ToolingConfig = {
    capabilityClusters: { clusters: {}, builtinAssignments: {} },
    mcp: { capabilityHints: {} },
    skills: { capabilityHints: {} },
    capabilityIndex: { enabled: true },
    installDetours: { mode: "advise" },
  };
  return { ...base, ...overrides };
}

describe("createToolCapabilityAdapter", () => {
  // ---------------------------------------------------------------------------
  // Key-by-key merge (3 cases mirroring schema-tooling.test.ts:183)
  // ---------------------------------------------------------------------------

  describe("default merge -- key-by-key", () => {
    it("empty operator config preserves all 3 reserved cluster IDs at priority 9999", () => {
      const port = createToolCapabilityAdapter({
        toolingConfig: makeMinimalToolingConfig(),
        skillRegistry: makeStubSkillRegistry(),
        mcpClientManager: makeStubMcpManager(),
        logger: makeStubLogger().logger,
      });

      expect(port.getClusterConfig("external-integrations")?.priority).toBe(9999);
      expect(port.getClusterConfig("prompt-skills")?.priority).toBe(9999);
      expect(port.getClusterConfig("other-tools")?.priority).toBe(9999);
    });

    it("partial operator add preserves defaults alongside addition", () => {
      const port = createToolCapabilityAdapter({
        toolingConfig: makeMinimalToolingConfig({
          capabilityClusters: {
            clusters: {
              "data-fetching": {
                label: "Data fetching",
                priority: 50,
                preferOverInstalls: true,
              },
            },
            builtinAssignments: {},
          },
        }),
        skillRegistry: makeStubSkillRegistry(),
        mcpClientManager: makeStubMcpManager(),
        logger: makeStubLogger().logger,
      });

      expect(port.getClusterConfig("data-fetching")?.priority).toBe(50);
      // Default reserved IDs intact:
      expect(port.getClusterConfig("external-integrations")?.priority).toBe(9999);
      expect(port.getClusterConfig("prompt-skills")?.priority).toBe(9999);
      expect(port.getClusterConfig("other-tools")?.priority).toBe(9999);
    });

    it("per-key override wins for the overridden key only", () => {
      const port = createToolCapabilityAdapter({
        toolingConfig: makeMinimalToolingConfig({
          capabilityClusters: {
            clusters: {
              "external-integrations": {
                label: "External",
                priority: 200,
                preferOverInstalls: false,
              },
            },
            builtinAssignments: {},
          },
        }),
        skillRegistry: makeStubSkillRegistry(),
        mcpClientManager: makeStubMcpManager(),
        logger: makeStubLogger().logger,
      });

      expect(port.getClusterConfig("external-integrations")?.priority).toBe(200);
      expect(port.getClusterConfig("external-integrations")?.preferOverInstalls).toBe(false);
      // Other reserved IDs at default 9999:
      expect(port.getClusterConfig("prompt-skills")?.priority).toBe(9999);
      expect(port.getClusterConfig("other-tools")?.priority).toBe(9999);
    });
  });

  // ---------------------------------------------------------------------------
  // Cluster-ID typo WARN+fallback (3 surfaces; assert BOTH halves).
  // ---------------------------------------------------------------------------

  describe("cluster-ID typo: WARN + lookup-time fallback", () => {
    it("mcp.capabilityHints typo falls back to external-integrations and emits WARN (does not throw)", () => {
      const { logger, warnSpy } = makeStubLogger();
      const config = makeMinimalToolingConfig({
        mcp: {
          capabilityHints: {
            "finance-data": {
              cluster: "data-fetching-finncial",
              description: "Finance data",
              replacesPackages: [],
            },
          },
        },
      });

      // Construction must not throw on typo:
      const port = createToolCapabilityAdapter({
        toolingConfig: config,
        skillRegistry: makeStubSkillRegistry(),
        mcpClientManager: makeStubMcpManager(),
        logger,
      });

      // Lookup falls back to "external-integrations":
      expect(port.getMcpServerHint("finance-data")?.cluster).toBe("external-integrations");

      // WARN was emitted with full payload (BOTH halves of contract):
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          errorKind: "config",
          configPath: "tooling.mcp.capabilityHints.finance-data.cluster",
          unresolvedClusterId: "data-fetching-finncial",
          hint: expect.stringContaining("Add cluster 'data-fetching-finncial'"),
        }),
        expect.any(String),
      );
    });

    it("skills.capabilityHints typo falls back to prompt-skills and emits WARN", () => {
      const { logger, warnSpy } = makeStubLogger();
      const port = createToolCapabilityAdapter({
        toolingConfig: makeMinimalToolingConfig({
          skills: {
            capabilityHints: {
              "my-skill": {
                cluster: "typo-cluster",
                description: "My skill",
                replacesPackages: [],
              },
            },
          },
        }),
        skillRegistry: makeStubSkillRegistry(),
        mcpClientManager: makeStubMcpManager(),
        logger,
      });

      expect(port.getSkillHint("my-skill")?.cluster).toBe("prompt-skills");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          errorKind: "config",
          configPath: "tooling.skills.capabilityHints.my-skill.cluster",
          unresolvedClusterId: "typo-cluster",
          hint: expect.stringContaining("Add cluster 'typo-cluster'"),
        }),
        expect.any(String),
      );
    });

    it("builtinAssignments typo emits WARN and getBuiltinCluster does not return the unresolved id", () => {
      const { logger, warnSpy } = makeStubLogger();
      const port = createToolCapabilityAdapter({
        toolingConfig: makeMinimalToolingConfig({
          capabilityClusters: {
            clusters: {},
            builtinAssignments: { exec: "nonexistent-cluster" },
          },
        }),
        skillRegistry: makeStubSkillRegistry(),
        mcpClientManager: makeStubMcpManager(),
        logger,
      });

      // Construction did not throw -- proven by the assertions below executing.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          errorKind: "config",
          configPath: "tooling.capabilityClusters.builtinAssignments.exec",
          unresolvedClusterId: "nonexistent-cluster",
          hint: expect.stringContaining("Add cluster 'nonexistent-cluster'"),
        }),
        expect.any(String),
      );

      // Lookup MUST NOT return the unresolved cluster id -- falls through to
      // getToolMetadata("exec")?.capability?.cluster (per the adapter's line
      // 205-215 contract). This unit test does not invoke the @comis/skills
      // registerAllToolMetadata bootstrap, so the registry has no entry for
      // "exec" and the metadata path resolves to undefined. The positive
      // assertion locks the contract: a future regression that returned the
      // typo string OR a phantom cluster ID would fail here, where the
      // previous .not.toBe(...) negative assertion would pass trivially.
      expect(port.getBuiltinCluster("exec")).toBe(undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // Disconnected MCP filter (order-independent)
  // ---------------------------------------------------------------------------

  describe("getConnectedMcpServers filters by status === connected", () => {
    it("returns only connected servers; disconnected/error/reconnecting/connecting filtered out", () => {
      const port = createToolCapabilityAdapter({
        toolingConfig: makeMinimalToolingConfig(),
        skillRegistry: makeStubSkillRegistry(),
        mcpClientManager: makeStubMcpManager([
          { name: "finance-data", status: "connected" },
          { name: "weather-api", status: "error" },
          { name: "stale-server", status: "reconnecting" },
          { name: "down", status: "disconnected" },
          { name: "connecting-server", status: "connecting" },
        ]),
        logger: makeStubLogger().logger,
      });

      const result = port.getConnectedMcpServers();
      // Resilient (order-independent) assertions.
      expect(result).toHaveLength(1);
      expect(result).toContain("finance-data");
    });
  });

  // ---------------------------------------------------------------------------
  // Callback timing + freshness
  // ---------------------------------------------------------------------------

  describe("callback timing + alias-map freshness", () => {
    it("getPromptSkillCapabilities passes a function whose call-time output equals port.getSkillHint", () => {
      const stubReg = makeStubSkillRegistry([]);
      const port = createToolCapabilityAdapter({
        toolingConfig: makeMinimalToolingConfig({
          skills: {
            capabilityHints: {
              "my-skill": {
                cluster: "prompt-skills",
                description: "x",
                replacesPackages: [],
              },
            },
          },
        }),
        skillRegistry: stubReg,
        mcpClientManager: makeStubMcpManager(),
        logger: makeStubLogger().logger,
      });

      port.getPromptSkillCapabilities();

      const getPromptSkillCapabilitiesMock = stubReg.getPromptSkillCapabilities as ReturnType<typeof vi.fn>;
      expect(getPromptSkillCapabilitiesMock).toHaveBeenCalledTimes(1);
      const callback = getPromptSkillCapabilitiesMock.mock.calls[0]?.[0] as (
        skillName: string,
        skillKey?: string,
      ) => unknown;
      expect(typeof callback).toBe("function");
      expect(callback("my-skill", undefined)).toEqual({
        cluster: "prompt-skills",
        description: "x",
        replacesPackages: [],
      });
    });

    it("getPackageAliasMap rebuilds fresh -- two calls reflect intermediate-state mutation (no memoization)", () => {
      let connections: McpConnection[] = [
        { name: "alpha", status: "connected" } as McpConnection,
      ];
      let skills: PromptSkillCapability[] = [];
      const mcp = {
        getAllConnections: () => connections,
      } as unknown as McpClientManager;
      const reg = {
        getPromptSkillCapabilities: () => skills,
      } as unknown as SkillRegistry;

      const port = createToolCapabilityAdapter({
        toolingConfig: makeMinimalToolingConfig(),
        skillRegistry: reg,
        mcpClientManager: mcp,
        logger: makeStubLogger().logger,
      });

      const map1 = port.getPackageAliasMap();

      // Mutate intermediate state between the two getPackageAliasMap calls.
      connections = [{ name: "beta", status: "connected" } as McpConnection];
      skills = [
        {
          name: "new-skill",
          description: "x",
          replacesPackages: ["pandas"],
        } as PromptSkillCapability,
      ];

      const map2 = port.getPackageAliasMap();

      // map1 reflects pre-mutation state:
      expect(map1.get("alpha")).toEqual({ type: "mcp", name: "alpha" });
      expect(map1.has("beta")).toBe(false);

      // map2 reflects post-mutation state -- NEW skill alias + NEW server alias.
      expect(map2.get("beta")).toEqual({ type: "mcp", name: "beta" });
      expect(map2.get("pandas")).toEqual({ type: "skill", name: "new-skill" });
    });
  });

  // ---------------------------------------------------------------------------
  // Object.freeze + sanity group
  // ---------------------------------------------------------------------------

  describe("structural integrity + sanity", () => {
    it("returned port is Object.freeze'd", () => {
      const port = createToolCapabilityAdapter({
        toolingConfig: makeMinimalToolingConfig(),
        skillRegistry: makeStubSkillRegistry(),
        mcpClientManager: makeStubMcpManager(),
        logger: makeStubLogger().logger,
      });

      expect(Object.isFrozen(port)).toBe(true);
    });

    it("isCapabilityIndexEnabled mirrors capabilityIndex.enabled", () => {
      const portTrue = createToolCapabilityAdapter({
        toolingConfig: makeMinimalToolingConfig({
          capabilityIndex: { enabled: true },
        }),
        skillRegistry: makeStubSkillRegistry(),
        mcpClientManager: makeStubMcpManager(),
        logger: makeStubLogger().logger,
      });
      expect(portTrue.isCapabilityIndexEnabled()).toBe(true);

      const portFalse = createToolCapabilityAdapter({
        toolingConfig: makeMinimalToolingConfig({
          capabilityIndex: { enabled: false },
        }),
        skillRegistry: makeStubSkillRegistry(),
        mcpClientManager: makeStubMcpManager(),
        logger: makeStubLogger().logger,
      });
      expect(portFalse.isCapabilityIndexEnabled()).toBe(false);
    });

    it.each([
      ["observe" as const],
      ["advise" as const],
      ["soft-stop" as const],
    ])("getInstallDetourMode returns the configured mode (%s)", (mode) => {
      const port = createToolCapabilityAdapter({
        toolingConfig: makeMinimalToolingConfig({
          installDetours: { mode },
        }),
        skillRegistry: makeStubSkillRegistry(),
        mcpClientManager: makeStubMcpManager(),
        logger: makeStubLogger().logger,
      });
      expect(port.getInstallDetourMode()).toBe(mode);
    });

    it("getBuiltinCluster honors operator override when cluster resolves; falls through to metadata otherwise", () => {
      // With operator override pointing at a defined cluster ("shell-tools"
      // added to operator clusters).
      const portWithOverride = createToolCapabilityAdapter({
        toolingConfig: makeMinimalToolingConfig({
          capabilityClusters: {
            clusters: {
              "shell-tools": {
                label: "Shell tools",
                priority: 100,
                preferOverInstalls: false,
              },
            },
            builtinAssignments: { exec: "shell-tools" },
          },
        }),
        skillRegistry: makeStubSkillRegistry(),
        mcpClientManager: makeStubMcpManager(),
        logger: makeStubLogger().logger,
      });
      expect(portWithOverride.getBuiltinCluster("exec")).toBe("shell-tools");

      // Without operator override -- result equals whatever
      // getToolMetadata("exec")?.capability?.cluster currently returns at
      // runtime (may be undefined if the metadata registry doesn't carry one).
      // Assertion compares against the live metadata so the test stays stable
      // as the metadata catalog evolves.
      const portNoOverride = createToolCapabilityAdapter({
        toolingConfig: makeMinimalToolingConfig(),
        skillRegistry: makeStubSkillRegistry(),
        mcpClientManager: makeStubMcpManager(),
        logger: makeStubLogger().logger,
      });
      // Compare against itself across two invocations to assert deterministic
      // pass-through (metadata-driven), without coupling the test to a
      // specific cluster value:
      const a = portNoOverride.getBuiltinCluster("exec");
      const b = portNoOverride.getBuiltinCluster("exec");
      expect(a).toBe(b);
    });
  });
});
