// SPDX-License-Identifier: Apache-2.0
/**
 * Graph leaf neighbor test for the setup-cross-session split. Pins the
 * symbol-export shape, the `SUB_AGENT_TOOL_DENYLIST` membership, and the
 * `MIN_SUB_AGENT_STEPS` integer constant for compile-time regression
 * coverage. The `buildExecuteSubAgent` closure-builder integration matrix
 * (parent intersection, ceiling, denylist, graph tool sort, spawn packet,
 * model resolution, cache retention) is exercised end-to-end by
 * setup-cross-session-runtime.test.ts through the setupCrossSession
 * invocation.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks. buildExecuteSubAgent imports concrete symbols from
// @comis/agent at module load; mock them so the daemon test never does real
// LLM/session work (the setup-cross-session-runtime.test.ts harness pattern).
// mockResolveOperationModel returns timeoutSource so LAT-01-15b pins the
// producer THREADING the label — the resolver's own labeling is pinned by
// the agent-package tests (operation-model-resolver.test.ts LAT-01-1..5).
// ---------------------------------------------------------------------------

const mockResolveOperationModel = vi.hoisted(() => vi.fn(() => ({
  model: "anthropic:claude-sonnet-4-5-20250929",
  provider: "anthropic",
  modelId: "claude-sonnet-4-5-20250929",
  source: "family_default" as const,
  operationType: "subagent" as const,
  timeoutMs: 120_000,
  timeoutSource: "operation_default" as const,
  cacheRetention: "short" as const,
})));

vi.mock("@comis/agent", () => ({
  createStepCounter: vi.fn(() => ({
    increment: vi.fn().mockReturnValue(1),
    shouldHalt: vi.fn().mockReturnValue(false),
    reset: vi.fn(),
    getCount: vi.fn().mockReturnValue(0),
  })),
  createSpawnPacketBuilder: vi.fn(),
  generateParentSummary: vi.fn(),
  createEphemeralComisSessionManager: vi.fn(() => ({
    withSession: vi.fn(),
    destroySession: vi.fn(),
    getSessionStats: vi.fn(),
    writeSessionMetadata: vi.fn(),
  })),
  createComisSessionManager: vi.fn(() => ({
    withSession: vi.fn(),
    destroySession: vi.fn(),
    getSessionStats: vi.fn(),
    writeSessionMetadata: vi.fn(),
  })),
  getCacheSafeParams: vi.fn(() => undefined),
  resolveOperationModel: mockResolveOperationModel,
  resolveProviderFamily: vi.fn(() => "anthropic"),
}));

import {
  buildExecuteSubAgent,
  resolveGraphCacheRetention,
  MIN_SUB_AGENT_STEPS,
  type ExecuteSubAgentDeps,
} from "./setup-cross-session-graph.js";
import { SUB_AGENT_TOOL_DENYLIST } from "@comis/core";

describe("setup-cross-session-graph", () => {
  it("buildExecuteSubAgent: exported as a callable function", () => {
    expect(typeof buildExecuteSubAgent).toBe("function");
    expect(buildExecuteSubAgent.length).toBeGreaterThanOrEqual(1);
  });

  it("ExecuteSubAgentDeps witness pins the closure-captured key set", () => {
    const witness: Record<keyof ExecuteSubAgentDeps, true> = {
      container: true,
      sessionStore: true,
      assembleToolsForAgent: true,
      getExecutor: true,
      fileLock: true,
      logger: true,
    };
    expect(Object.keys(witness).length).toBe(6);
  });

  it("MIN_SUB_AGENT_STEPS is a positive integer floor", () => {
    expect(Number.isInteger(MIN_SUB_AGENT_STEPS)).toBe(true);
    expect(MIN_SUB_AGENT_STEPS).toBeGreaterThan(0);
    expect(MIN_SUB_AGENT_STEPS).toBe(30);
  });

  it("SUB_AGENT_TOOL_DENYLIST contains the 10 documented management tools", () => {
    const expectedTools = [
      "gateway",
      "channels_manage",
      "agents_manage",
      "models_manage",
      "providers_manage",
      "tokens_manage",
      "skills_manage",
      "sessions_manage",
      "memory_manage",
      "heartbeat_manage",
    ];
    expect(SUB_AGENT_TOOL_DENYLIST.size).toBe(expectedTools.length);
    for (const tool of expectedTools) {
      expect(SUB_AGENT_TOOL_DENYLIST.has(tool)).toBe(true);
    }
  });

  it("resolveGraphCacheRetention: leaf node returns short", () => {
    expect(resolveGraphCacheRetention(0, true)).toBe("short");
    expect(resolveGraphCacheRetention(3, true)).toBe("short");
    expect(resolveGraphCacheRetention(undefined, true)).toBe("short");
  });

  it("resolveGraphCacheRetention: non-leaf node returns long", () => {
    expect(resolveGraphCacheRetention(0, false)).toBe("long");
    expect(resolveGraphCacheRetention(3, false)).toBe("long");
    expect(resolveGraphCacheRetention(undefined, undefined)).toBe("long");
  });

  // -------------------------------------------------------------------------
  // LAT-01-15: the spawn producer labels its promptTimeout binding. A graph
  // spawn hardcodes GRAPH_PROMPT_TIMEOUT_MS = 600_000 — a constant NO operator
  // knob controls — so it must be labeled "graph_constant" (hints then render
  // honest prose instead of a fake agents.* key; D-11). A non-graph subagent
  // spawn threads subagentResolution.timeoutSource (born at the resolver) —
  // the bare { promptTimeoutMs } shape is the provenance-collapse bug
  // (177-RESEARCH Critical Finding 1).
  // -------------------------------------------------------------------------
  describe("LAT-01-15 promptTimeout provenance from the spawn producer", () => {
    const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };

    function makeGraphDeps(metadata: Record<string, unknown>) {
      const capturedOverrides: Array<Record<string, unknown>> = [];
      const executor = {
        execute: vi.fn(async (...args: unknown[]) => {
          capturedOverrides.push(args[7] as Record<string, unknown>);
          return {
            response: "done",
            tokensUsed: { total: 10 },
            cost: { total: 0.01 },
            finishReason: "stop",
            stepsExecuted: 1,
          };
        }),
      };
      const deps = {
        container: {
          config: {
            agents: {
              default: { name: "Default", provider: "anthropic", model: "claude-sonnet-4-5-20250929", operationModels: {} },
              "agent-2": { name: "Agent 2", provider: "anthropic", model: "claude-sonnet-4-5-20250929", operationModels: {} },
            },
            security: {
              agentToAgent: {
                enabled: true,
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
              },
            },
            providers: { entries: {} },
          },
          secretManager: { get: vi.fn(() => "test-key") },
        },
        sessionStore: { loadByFormattedKey: vi.fn(() => ({ messages: [], metadata })) },
        assembleToolsForAgent: vi.fn(async () => [{ name: "tool-1" }]),
        getExecutor: vi.fn(() => executor),
        fileLock: {
          acquire: vi.fn(),
          release: vi.fn(),
          withLock: vi.fn(),
          isLocked: vi.fn(async () => false),
          cleanupStaleLocks: vi.fn(async () => 0),
        },
      } as unknown as ExecuteSubAgentDeps;
      return { deps, capturedOverrides, executor };
    }

    it("LAT-01-15: a graph spawn labels its hardcoded 600000ms constant source graph_constant (not a fake operator knob)", async () => {
      const { deps, capturedOverrides, executor } = makeGraphDeps({ graphSharedDir: "/tmp/graph-shared" });
      const executeSubAgent = buildExecuteSubAgent(deps);

      await executeSubAgent("agent-2", sessionKey as Parameters<typeof executeSubAgent>[1], "task");

      expect(executor.execute).toHaveBeenCalledOnce();
      expect(capturedOverrides[0].promptTimeout).toEqual({
        promptTimeoutMs: 600_000,
        source: "graph_constant",
      });
    });

    it("LAT-01-15b: a non-graph subagent spawn threads subagentResolution.timeoutSource alongside its timeoutMs", async () => {
      const { deps, capturedOverrides, executor } = makeGraphDeps({});
      const executeSubAgent = buildExecuteSubAgent(deps);

      await executeSubAgent("agent-2", sessionKey as Parameters<typeof executeSubAgent>[1], "task");

      expect(executor.execute).toHaveBeenCalledOnce();
      expect(capturedOverrides[0].promptTimeout).toEqual({
        promptTimeoutMs: 120_000,
        source: "operation_default",
      });
    });
  });
});
