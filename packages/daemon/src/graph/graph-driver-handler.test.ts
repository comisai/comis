// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDriverTurnCompleted, executeDriverAction } from "./graph-driver-handler.js";
import type {
  CoordinatorSharedState,
  GraphRunState,
  DriverNodeState,
  CoordinatorConfig,
  GraphCoordinatorDeps,
} from "./graph-coordinator-state.js";
import type { NodeTypeDriver, NodeDriverContext, NodeDriverAction } from "@comis/core";

// ---------------------------------------------------------------------------
// Module mock for node:fs (prevents real file writes from persistArtifacts)
// ---------------------------------------------------------------------------

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockDriver(overrides?: Partial<NodeTypeDriver>): NodeTypeDriver {
  return {
    typeId: "debate",
    name: "Debate",
    description: "Multi-round debate driver",
    configSchema: { parse: vi.fn() } as unknown as NodeTypeDriver["configSchema"],
    defaultTimeoutMs: 300_000,
    estimateDurationMs: vi.fn().mockReturnValue(60_000),
    initialize: vi.fn().mockReturnValue({ action: "spawn", agentId: "bull", task: "argue" } as NodeDriverAction),
    onTurnComplete: vi.fn().mockReturnValue({ action: "wait" } as NodeDriverAction),
    onAbort: vi.fn(),
    ...overrides,
  };
}

function createMockCtx(): NodeDriverContext {
  let state: unknown;
  return {
    nodeId: "debate-node",
    task: "Debate the topic",
    typeConfig: { rounds: 3 },
    sharedDir: "/tmp/graph-shared",
    graphLabel: "test-graph",
    defaultAgentId: "default",
    typeName: "debate",
    getState: () => state,
    setState: (s: unknown) => { state = s; },
  };
}

function createMockDeps(): Pick<GraphCoordinatorDeps, "subAgentRunner" | "eventBus" | "logger" | "sendToChannel"> {
  return {
    subAgentRunner: {
      spawn: vi.fn().mockReturnValue("run-1"),
      killRun: vi.fn().mockReturnValue({ killed: true }),
      getRunStatus: vi.fn(),
    },
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as GraphCoordinatorDeps["eventBus"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    sendToChannel: vi.fn().mockResolvedValue(true),
  };
}

function createMockConfig(): Pick<CoordinatorConfig, "maxGlobalSubAgents" | "maxParallelSpawns"> {
  return {
    maxGlobalSubAgents: 20,
    maxParallelSpawns: 10,
  };
}

function createMockCallbacks() {
  return {
    markNodeFailed: vi.fn(),
    handleBudgetExceeded: vi.fn(),
    spawnReadyNodes: vi.fn(),
    handleGraphCompletion: vi.fn(),
  };
}

function createMinimalGraphRunState(overrides?: Partial<GraphRunState>): GraphRunState {
  return {
    graphId: "graph-1",
    graphTraceId: "trace-1",
    graph: {
      graph: {
        nodes: [{ nodeId: "debate-node", task: "Debate", dependsOn: [], retries: 0 }],
      },
      layers: [],
      nodeLookup: new Map(),
    } as unknown as GraphRunState["graph"],
    stateMachine: {
      isTerminal: vi.fn().mockReturnValue(false),
      markNodeCompleted: vi.fn(),
      markNodeFailed: vi.fn(),
    } as unknown as GraphRunState["stateMachine"],
    runIdToNode: new Map(),
    nodeOutputs: new Map(),
    nodeTimers: new Map(),
    retryTimers: new Map(),
    graphTimer: undefined,
    startedAt: Date.now(),
    runningCount: 1,
    nodeProgress: false,
    skippedNodesEmitted: new Set(),
    cumulativeTokens: 0,
    cumulativeCost: 0,
    sharedDir: "/tmp/graph-shared",
    driverStates: new Map(),
    driverRunIdMap: new Map([["run-1", { nodeId: "debate-node", agentId: "bull" }]]),
    waitHandlers: new Map(),
    syntheticRunResults: new Map(),
    nodeCacheData: new Map(),
    graphToolNames: ["tool-a", "tool-b"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Persistent session key capture tests
// ---------------------------------------------------------------------------

describe("handleDriverTurnCompleted captures persistentSessionKey", () => {
  let deps: ReturnType<typeof createMockDeps>;
  let config: ReturnType<typeof createMockConfig>;
  let callbacks: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    deps = createMockDeps();
    config = createMockConfig();
    callbacks = createMockCallbacks();
  });

  it("captures persistentSessionKey on first successful turn", () => {
    const driver = createMockDriver({
      onTurnComplete: vi.fn().mockReturnValue({ action: "wait" } as NodeDriverAction),
    });
    const ds: DriverNodeState = {
      driver,
      ctx: createMockCtx(),
      currentRunId: "run-1",
    };
    const gs = createMinimalGraphRunState();
    gs.driverStates.set("debate-node", ds);

    // Mock getRunStatus to return a completed run with sessionKey
    vi.mocked(deps.subAgentRunner.getRunStatus).mockReturnValue({
      status: "completed",
      result: { response: "I argue that..." },
      sessionKey: "default:debate-node1:debategraph1node1",
    });

    const state: CoordinatorSharedState = {
      graphs: new Map([["graph-1", gs]]),
      globalActiveSubAgents: 1,
      spawnQueue: [],
    };

    handleDriverTurnCompleted(state, deps, config, gs, "debate-node", {
      runId: "run-1",
      success: true,
      tokensUsed: 100,
      cost: 0.01,
    }, callbacks);

    // persistentSessionKey should be captured from the first completed run
    expect(ds.persistentSessionKey).toBe("default:debate-node1:debategraph1node1");

    // Logger should record the capture
    expect(deps.logger!.debug).toHaveBeenCalledWith(
      expect.objectContaining({ persistentSessionKey: "default:debate-node1:debategraph1node1" }),
      expect.stringContaining("Captured persistent session key from first driver round"),
    );
  });

  it("does NOT overwrite existing persistentSessionKey on subsequent turns", () => {
    const driver = createMockDriver({
      onTurnComplete: vi.fn().mockReturnValue({ action: "wait" } as NodeDriverAction),
    });
    const ds: DriverNodeState = {
      driver,
      ctx: createMockCtx(),
      currentRunId: "run-2",
      persistentSessionKey: "existing-key",
    };
    const gs = createMinimalGraphRunState();
    gs.driverStates.set("debate-node", ds);
    gs.driverRunIdMap.set("run-2", { nodeId: "debate-node", agentId: "bull" });

    vi.mocked(deps.subAgentRunner.getRunStatus).mockReturnValue({
      status: "completed",
      result: { response: "Counter argument..." },
      sessionKey: "default:different-key:debategraph1node2",
    });

    const state: CoordinatorSharedState = {
      graphs: new Map([["graph-1", gs]]),
      globalActiveSubAgents: 1,
      spawnQueue: [],
    };

    handleDriverTurnCompleted(state, deps, config, gs, "debate-node", {
      runId: "run-2",
      success: true,
      tokensUsed: 50,
      cost: 0.005,
    }, callbacks);

    // persistentSessionKey should remain unchanged
    expect(ds.persistentSessionKey).toBe("existing-key");
  });
});

// ---------------------------------------------------------------------------
// executeDriverAction reuseSessionKey threading
// ---------------------------------------------------------------------------

describe("executeDriverAction passes reuseSessionKey to spawn", () => {
  let deps: ReturnType<typeof createMockDeps>;
  let config: ReturnType<typeof createMockConfig>;
  let callbacks: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    deps = createMockDeps();
    config = createMockConfig();
    callbacks = createMockCallbacks();
  });

  it("passes reuseSessionKey and graphToolNames to subAgentRunner.spawn", () => {
    const driver = createMockDriver();
    const ds: DriverNodeState = {
      driver,
      ctx: createMockCtx(),
    };
    const gs = createMinimalGraphRunState({
      callerSessionKey: "default:user1:channel1",
      callerAgentId: "parent-agent",
    });
    gs.driverStates.set("debate-node", ds);

    const state: CoordinatorSharedState = {
      graphs: new Map([["graph-1", gs]]),
      globalActiveSubAgents: 0,  // Under capacity so gatedSpawn executes immediately
      spawnQueue: [],
    };

    const action: NodeDriverAction = {
      action: "spawn",
      agentId: "bull",
      task: "round 2 argument",
      reuseSessionKey: "default:debate-node1:debategraph1node1",
    };

    executeDriverAction(state, deps, config, gs, "debate-node", action, callbacks);

    // spawn should be called with reuseSessionKey
    expect(deps.subAgentRunner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        reuseSessionKey: "default:debate-node1:debategraph1node1",
        graphToolNames: ["tool-a", "tool-b"],
        task: "round 2 argument",
        agentId: "bull",
        callerType: "graph",
      }),
    );

    // ds.currentRunId should be set
    expect(ds.currentRunId).toBe("run-1");
  });
});

// ---------------------------------------------------------------------------
// executeDriverAction: mcpServers pre-seeding for spawn actions
// ---------------------------------------------------------------------------

describe("executeDriverAction passes discoveredDeferredTools for mcpServers nodes", () => {
  let deps: ReturnType<typeof createMockDeps>;
  let config: ReturnType<typeof createMockConfig>;
  let callbacks: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    deps = createMockDeps();
    config = createMockConfig();
    callbacks = createMockCallbacks();
  });

  it("includes discoveredDeferredTools in spawn when node has mcpServers", () => {
    const driver = createMockDriver();
    const ds: DriverNodeState = {
      driver,
      ctx: createMockCtx(),
    };
    const gs = createMinimalGraphRunState({
      graphToolNames: ["mcp__yfinance--get_price", "mcp__yfinance--get_chart", "mcp__context7--query"],
      graph: {
        graph: {
          nodes: [
            { nodeId: "debate-node", task: "Debate", dependsOn: [], retries: 0, mcpServers: ["yfinance"] },
          ],
        },
      } as unknown as GraphRunState["graph"],
    });
    gs.driverStates.set("debate-node", ds);

    const state: CoordinatorSharedState = {
      graphs: new Map([["graph-1", gs]]),
      globalActiveSubAgents: 0,
      spawnQueue: [],
    };

    const action: NodeDriverAction = {
      action: "spawn",
      agentId: "bull",
      task: "argue for yfinance data",
    };

    executeDriverAction(state, deps, config, gs, "debate-node", action, callbacks);

    expect(deps.subAgentRunner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        discoveredDeferredTools: ["mcp__yfinance--get_price", "mcp__yfinance--get_chart"],
      }),
    );
  });

  it("includes discoveredDeferredTools in spawn_all when node has mcpServers", () => {
    const driver = createMockDriver({
      onParallelTurnComplete: vi.fn().mockReturnValue({ action: "complete", output: "done" }),
    });
    const ds: DriverNodeState = {
      driver,
      ctx: createMockCtx(),
    };
    const gs = createMinimalGraphRunState({
      graphToolNames: ["mcp__yfinance--get_price", "mcp__context7--query"],
      graph: {
        graph: {
          nodes: [
            { nodeId: "debate-node", task: "Debate", dependsOn: [], retries: 0, mcpServers: ["yfinance"] },
          ],
        },
      } as unknown as GraphRunState["graph"],
    });
    gs.driverStates.set("debate-node", ds);

    const state: CoordinatorSharedState = {
      graphs: new Map([["graph-1", gs]]),
      globalActiveSubAgents: 0,
      spawnQueue: [],
    };

    const action: NodeDriverAction = {
      action: "spawn_all",
      spawns: [
        { agentId: "bull", task: "argue for" },
        { agentId: "bear", task: "argue against" },
      ],
    };

    executeDriverAction(state, deps, config, gs, "debate-node", action, callbacks);

    // Both spawns should include discoveredDeferredTools
    expect(deps.subAgentRunner.spawn).toHaveBeenCalledTimes(2);
    expect(deps.subAgentRunner.spawn).toHaveBeenNthCalledWith(1,
      expect.objectContaining({
        discoveredDeferredTools: ["mcp__yfinance--get_price"],
      }),
    );
    expect(deps.subAgentRunner.spawn).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        discoveredDeferredTools: ["mcp__yfinance--get_price"],
      }),
    );
  });

  it("merges accumulatedDiscoveries with pre-seeded tools", () => {
    const driver = createMockDriver();
    const ds: DriverNodeState = {
      driver,
      ctx: createMockCtx(),
      accumulatedDiscoveries: ["mcp__extra--tool_a"],
    };
    const gs = createMinimalGraphRunState({
      graphToolNames: ["mcp__yfinance--get_price", "mcp__context7--query"],
      graph: {
        graph: {
          nodes: [
            { nodeId: "debate-node", task: "Debate", dependsOn: [], retries: 0, mcpServers: ["yfinance"] },
          ],
        },
      } as unknown as GraphRunState["graph"],
    });
    gs.driverStates.set("debate-node", ds);

    const state: CoordinatorSharedState = {
      graphs: new Map([["graph-1", gs]]),
      globalActiveSubAgents: 0,
      spawnQueue: [],
    };

    const action: NodeDriverAction = {
      action: "spawn",
      agentId: "bull",
      task: "round 2",
    };

    executeDriverAction(state, deps, config, gs, "debate-node", action, callbacks);

    // Should include both pre-seeded and accumulated tools
    expect(deps.subAgentRunner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        discoveredDeferredTools: ["mcp__yfinance--get_price", "mcp__extra--tool_a"],
      }),
    );
  });

  it("does NOT include discoveredDeferredTools when node has no mcpServers and no accumulatedDiscoveries", () => {
    const driver = createMockDriver();
    const ds: DriverNodeState = {
      driver,
      ctx: createMockCtx(),
    };
    const gs = createMinimalGraphRunState({
      graphToolNames: ["mcp__yfinance--get_price"],
    });
    gs.driverStates.set("debate-node", ds);

    const state: CoordinatorSharedState = {
      graphs: new Map([["graph-1", gs]]),
      globalActiveSubAgents: 0,
      spawnQueue: [],
    };

    const action: NodeDriverAction = {
      action: "spawn",
      agentId: "bull",
      task: "argue",
    };

    executeDriverAction(state, deps, config, gs, "debate-node", action, callbacks);

    expect(deps.subAgentRunner.spawn).toHaveBeenCalledWith(
      expect.not.objectContaining({
        discoveredDeferredTools: expect.anything(),
      }),
    );
  });
});
