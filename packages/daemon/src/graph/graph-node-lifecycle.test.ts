// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for graph-node-lifecycle: spawnReadyNodes prewarm-aware stagger
 * and graphNodeDepth threading to SpawnParams.
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnReadyNodes, spawnNode } from "./graph-node-lifecycle.js";
import type {
  CoordinatorSharedState,
  GraphRunState,
  CoordinatorConfig,
  GraphCoordinatorDeps,
} from "./graph-coordinator-state.js";

// ---------------------------------------------------------------------------
// Minimal mock factories
// ---------------------------------------------------------------------------

function makeGraphRunState(overrides?: Partial<GraphRunState>): GraphRunState {
  return {
    graphId: "test-graph",
    graphTraceId: "trace-1",
    graph: {
      graph: { label: "test", nodes: [], edges: [] },
    } as any,
    stateMachine: {
      getReadyNodes: () => [],
      getNodeState: () => undefined,
      markNodeRunning: () => ({ ok: true, value: undefined }),
      markNodeFailed: () => ({ ok: true, value: undefined }),
    } as any,
    runIdToNode: new Map(),
    nodeOutputs: new Map(),
    nodeTimers: new Map(),
    retryTimers: new Map(),
    graphTimer: undefined,
    startedAt: Date.now(),
    runningCount: 0,
    nodeProgress: false,
    skippedNodesEmitted: new Set(),
    cumulativeTokens: 0,
    cumulativeCost: 0,
    sharedDir: "/tmp/test-shared",
    driverStates: new Map(),
    driverRunIdMap: new Map(),
    waitHandlers: new Map(),
    syntheticRunResults: new Map(),
    nodeCacheData: new Map(),
    ...overrides,
  };
}

function makeState(): CoordinatorSharedState {
  return {
    graphs: new Map(),
    globalActiveSubAgents: 0,
    spawnQueue: [],
  };
}

function makeConfig(overrides?: Partial<CoordinatorConfig>): CoordinatorConfig {
  return {
    maxConcurrency: 10,
    maxResultLength: 12000,
    graphRetentionMs: 3600000,
    maxGlobalSubAgents: 20,
    maxParallelSpawns: 10,
    spawnStaggerMs: 2000,
    maxGraphs: 100,
    sweepIntervalMs: 60000,
    ...overrides,
  };
}

function makeDeps(): Pick<GraphCoordinatorDeps, "logger" | "subAgentRunner" | "eventBus" | "defaultAgentId" | "nodeTypeRegistry"> {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    subAgentRunner: {
      spawn: vi.fn().mockReturnValue("run-1"),
      killRun: vi.fn(),
      getRunStatus: vi.fn(),
    },
    eventBus: {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as any,
    defaultAgentId: "default",
    nodeTypeRegistry: undefined,
  };
}

// ---------------------------------------------------------------------------
// spawnReadyNodes: prewarm-aware stagger
// ---------------------------------------------------------------------------

describe("spawnReadyNodes: prewarm-aware stagger", () => {
  let state: CoordinatorSharedState;
  let deps: ReturnType<typeof makeDeps>;
  let config: CoordinatorConfig;

  beforeEach(() => {
    state = makeState();
    deps = makeDeps();
    config = makeConfig();
  });

  it("spawns all nodes immediately when cachePrewarmed is true", () => {
    const spawnNodeFn = vi.fn();
    const gs = makeGraphRunState({
      cachePrewarmed: true,
      stateMachine: {
        getReadyNodes: () => ["node-a", "node-b", "node-c"],
        getNodeState: () => ({ status: "ready" }),
      } as any,
    });

    spawnReadyNodes(state, deps, config, gs, { spawnNode: spawnNodeFn });

    // All 3 nodes should be spawned immediately (no stagger)
    expect(spawnNodeFn).toHaveBeenCalledTimes(3);
    expect(spawnNodeFn).toHaveBeenCalledWith(gs, "node-a");
    expect(spawnNodeFn).toHaveBeenCalledWith(gs, "node-b");
    expect(spawnNodeFn).toHaveBeenCalledWith(gs, "node-c");
  });

  it("uses event-driven stagger when cachePrewarmed is false (even with many tools)", () => {
    vi.useFakeTimers();
    const spawnNodeFn = vi.fn();
    const gs = makeGraphRunState({
      cachePrewarmed: false,
      stateMachine: {
        getReadyNodes: () => ["node-a", "node-b", "node-c"],
        getNodeState: (id: string) => ({ status: "ready", nodeId: id }),
      } as any,
    });

    spawnReadyNodes(state, deps, config, gs, { spawnNode: spawnNodeFn });

    // Only first node spawned immediately; rest are staggered
    expect(spawnNodeFn).toHaveBeenCalledTimes(1);
    expect(spawnNodeFn).toHaveBeenCalledWith(gs, "node-a");

    // After stagger delay, second node spawns
    vi.advanceTimersByTime(config.spawnStaggerMs);
    expect(spawnNodeFn).toHaveBeenCalledTimes(2);

    // After another stagger delay, third node spawns
    vi.advanceTimersByTime(config.spawnStaggerMs);
    expect(spawnNodeFn).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it("uses stagger when cachePrewarmed is undefined (default)", () => {
    vi.useFakeTimers();
    const spawnNodeFn = vi.fn();
    const gs = makeGraphRunState({
      // cachePrewarmed not set (undefined)
      stateMachine: {
        getReadyNodes: () => ["node-a", "node-b"],
        getNodeState: (id: string) => ({ status: "ready", nodeId: id }),
      } as any,
    });

    spawnReadyNodes(state, deps, config, gs, { spawnNode: spawnNodeFn });

    // First node immediate, second staggered
    expect(spawnNodeFn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(config.spawnStaggerMs);
    expect(spawnNodeFn).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("logs prewarm-aware spawn when cachePrewarmed is true", () => {
    const spawnNodeFn = vi.fn();
    const gs = makeGraphRunState({
      cachePrewarmed: true,
      stateMachine: {
        getReadyNodes: () => ["node-a", "node-b"],
      } as any,
    });

    spawnReadyNodes(state, deps, config, gs, { spawnNode: spawnNodeFn });

    expect(deps.logger!.debug).toHaveBeenCalledWith(
      expect.objectContaining({ graphId: "test-graph", nodeCount: 2 }),
      expect.stringContaining("Pre-warmed graph"),
    );
  });
});

// ---------------------------------------------------------------------------
// spawnNode: graphNodeDepth threading
// ---------------------------------------------------------------------------

describe("spawnNode: graphNodeDepth threading", () => {
  let state: CoordinatorSharedState;
  let deps: ReturnType<typeof makeDeps>;
  let config: CoordinatorConfig;

  beforeEach(() => {
    state = makeState();
    deps = makeDeps();
    config = makeConfig();
  });

  it("passes graphNodeDepth=0 for root nodes (dependsOn=[])", () => {
    const gs = makeGraphRunState({
      graph: {
        graph: {
          label: "test",
          nodes: [
            { nodeId: "root-1", task: "Do something", agentId: "agent-1", dependsOn: [] },
          ],
          edges: [],
        },
      } as any,
    });

    const callbacks = {
      markNodeFailed: vi.fn(),
      startDriverNode: vi.fn(),
      spawnReadyNodes: vi.fn(),
    };

    spawnNode(state, deps, config, gs, "root-1", callbacks);

    expect(deps.subAgentRunner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        graphNodeDepth: 0,
      }),
    );
  });

  it("passes graphNodeDepth=1 for downstream nodes (dependsOn non-empty)", () => {
    const gs = makeGraphRunState({
      nodeOutputs: new Map([["upstream-1", "some output"]]),
      graph: {
        graph: {
          label: "test",
          nodes: [
            { nodeId: "down-1", task: "Process {upstream-1}", agentId: "agent-1", dependsOn: ["upstream-1"] },
          ],
          edges: [],
        },
      } as any,
    });

    const callbacks = {
      markNodeFailed: vi.fn(),
      startDriverNode: vi.fn(),
      spawnReadyNodes: vi.fn(),
    };

    spawnNode(state, deps, config, gs, "down-1", callbacks);

    expect(deps.subAgentRunner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        graphNodeDepth: 1,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// spawnNode: mcpServers pre-seeding
// ---------------------------------------------------------------------------

describe("spawnNode: mcpServers pre-seeding", () => {
  let state: CoordinatorSharedState;
  let deps: ReturnType<typeof makeDeps>;
  let config: CoordinatorConfig;

  beforeEach(() => {
    state = makeState();
    deps = makeDeps();
    config = makeConfig();
  });

  it("passes discoveredDeferredTools when node has mcpServers matching graphToolNames", () => {
    const gs = makeGraphRunState({
      graphToolNames: ["mcp__yfinance--get_price", "mcp__yfinance--get_chart", "mcp__context7--query"],
      graph: {
        graph: {
          label: "test",
          nodes: [
            { nodeId: "node-1", task: "Get stock data", agentId: "agent-1", dependsOn: [], mcpServers: ["yfinance"] },
          ],
          edges: [],
        },
      } as any,
    });

    const callbacks = {
      markNodeFailed: vi.fn(),
      startDriverNode: vi.fn(),
      spawnReadyNodes: vi.fn(),
    };

    spawnNode(state, deps, config, gs, "node-1", callbacks);

    expect(deps.subAgentRunner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        discoveredDeferredTools: ["mcp__yfinance--get_price", "mcp__yfinance--get_chart"],
      }),
    );
  });

  it("does NOT pass discoveredDeferredTools when mcpServers is empty", () => {
    const gs = makeGraphRunState({
      graphToolNames: ["mcp__yfinance--get_price"],
      graph: {
        graph: {
          label: "test",
          nodes: [
            { nodeId: "node-1", task: "Do something", agentId: "agent-1", dependsOn: [], mcpServers: [] },
          ],
          edges: [],
        },
      } as any,
    });

    const callbacks = {
      markNodeFailed: vi.fn(),
      startDriverNode: vi.fn(),
      spawnReadyNodes: vi.fn(),
    };

    spawnNode(state, deps, config, gs, "node-1", callbacks);

    expect(deps.subAgentRunner.spawn).toHaveBeenCalledWith(
      expect.not.objectContaining({
        discoveredDeferredTools: expect.anything(),
      }),
    );
  });

  it("does NOT pass discoveredDeferredTools when graphToolNames is undefined", () => {
    const gs = makeGraphRunState({
      graphToolNames: undefined,
      graph: {
        graph: {
          label: "test",
          nodes: [
            { nodeId: "node-1", task: "Do something", agentId: "agent-1", dependsOn: [], mcpServers: ["yfinance"] },
          ],
          edges: [],
        },
      } as any,
    });

    const callbacks = {
      markNodeFailed: vi.fn(),
      startDriverNode: vi.fn(),
      spawnReadyNodes: vi.fn(),
    };

    spawnNode(state, deps, config, gs, "node-1", callbacks);

    expect(deps.subAgentRunner.spawn).toHaveBeenCalledWith(
      expect.not.objectContaining({
        discoveredDeferredTools: expect.anything(),
      }),
    );
  });

  it("does NOT pass discoveredDeferredTools when mcpServers is undefined (legacy node)", () => {
    const gs = makeGraphRunState({
      graphToolNames: ["mcp__yfinance--get_price"],
      graph: {
        graph: {
          label: "test",
          nodes: [
            { nodeId: "node-1", task: "Do something", agentId: "agent-1", dependsOn: [] },
          ],
          edges: [],
        },
      } as any,
    });

    const callbacks = {
      markNodeFailed: vi.fn(),
      startDriverNode: vi.fn(),
      spawnReadyNodes: vi.fn(),
    };

    spawnNode(state, deps, config, gs, "node-1", callbacks);

    expect(deps.subAgentRunner.spawn).toHaveBeenCalledWith(
      expect.not.objectContaining({
        discoveredDeferredTools: expect.anything(),
      }),
    );
  });

  it("logs pre-seeding debug message when tools are resolved", () => {
    const gs = makeGraphRunState({
      graphToolNames: ["mcp__yfinance--get_price"],
      graph: {
        graph: {
          label: "test",
          nodes: [
            { nodeId: "node-1", task: "Get stock data", agentId: "agent-1", dependsOn: [], mcpServers: ["yfinance"] },
          ],
          edges: [],
        },
      } as any,
    });

    const callbacks = {
      markNodeFailed: vi.fn(),
      startDriverNode: vi.fn(),
      spawnReadyNodes: vi.fn(),
    };

    spawnNode(state, deps, config, gs, "node-1", callbacks);

    expect(deps.logger!.debug).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServers: ["yfinance"], preSeeded: 1 }),
      "Pre-seeding MCP tool discoveries for graph node",
    );
  });
});

// ---------------------------------------------------------------------------
// spawnNode: resolvedLanguage -> envelope Language line (GEN-03 graph leg)
//
// The carrier GraphRunState.resolvedLanguage (set once at graph submission from
// the caller's RequestContext.resolvedLanguage) is threaded into
// buildContextEnvelope, so the enveloped task the node spawns with carries the
// verbatim-preserving Language directive in the conversation language.
// ---------------------------------------------------------------------------

describe("spawnNode: resolvedLanguage threading", () => {
  let state: CoordinatorSharedState;
  let deps: ReturnType<typeof makeDeps>;
  let config: CoordinatorConfig;

  beforeEach(() => {
    state = makeState();
    deps = makeDeps();
    config = makeConfig();
  });

  it("threads a non-en resolvedLanguage into the node task envelope Language line", () => {
    const gs = makeGraphRunState({
      resolvedLanguage: "he",
      graph: {
        graph: {
          label: "test",
          nodes: [
            { nodeId: "node-1", task: "Summarize the findings", agentId: "agent-1", dependsOn: [] },
          ],
          edges: [],
        },
      } as any,
    });

    const callbacks = {
      markNodeFailed: vi.fn(),
      startDriverNode: vi.fn(),
      spawnReadyNodes: vi.fn(),
    };

    spawnNode(state, deps, config, gs, "node-1", callbacks);

    expect(deps.subAgentRunner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        // The enveloped task carries the verbatim-preserving Language directive
        // (I7: same sentence as the 181-04 sub-agent role section).
        task: expect.stringContaining(
          "Produce all user-facing output in he (the conversation language). Code, identifiers, and file paths stay verbatim.",
        ),
      }),
    );
    expect(deps.subAgentRunner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: expect.stringContaining("## Language") }),
    );
  });

  it("emits no Language line in the node task envelope when resolvedLanguage is undefined (I1)", () => {
    const gs = makeGraphRunState({
      // resolvedLanguage not set (undefined)
      graph: {
        graph: {
          label: "test",
          nodes: [
            { nodeId: "node-1", task: "Summarize the findings", agentId: "agent-1", dependsOn: [] },
          ],
          edges: [],
        },
      } as any,
    });

    const callbacks = {
      markNodeFailed: vi.fn(),
      startDriverNode: vi.fn(),
      spawnReadyNodes: vi.fn(),
    };

    spawnNode(state, deps, config, gs, "node-1", callbacks);

    const spawnArg = (deps.subAgentRunner.spawn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { task: string };
    expect(spawnArg.task).not.toContain("## Language");
  });
});

// ---------------------------------------------------------------------------
// graph-node-lifecycle honors §1.4 mode invariants on substrate-routed writes
//
// The node-lifecycle's two write sites — the `${nodeId}-output.md`
// auto-persist (line 605) and the `persistArtifacts` filename loop
// (line 780) — are now routed through `writeRegularFile`. The substrate's
// chmod-by-fd primitive enforces mode 0o600 on every successful open.
// ---------------------------------------------------------------------------
describe("graph-node-lifecycle honors §1.4 file mode invariant", () => {
  it("write_regular_file_substrate_produces_artifact_with_mode_0o600", async () => {
    // Direct substrate-level test mirroring the migrated node-lifecycle
    // call shape (both auto-persist and persistArtifacts use the same
    // `writeRegularFile({path, content, confinedBaseDir: gs.sharedDir})`
    // signature; one test covers the shared invariant).
    const { mkdtempSync, statSync, rmSync, mkdirSync: realMkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { writeRegularFile } = await import("@comis/observability");

    const baseDir = mkdtempSync(join(tmpdir(), "comis-graph-lifecycle-mode-"));
    const sharedDir = join(baseDir, "graph-shared");
    realMkdirSync(sharedDir, { recursive: true, mode: 0o700 });
    try {
      const target = join(sharedDir, "node-1-output.md");
      const result = writeRegularFile({
        path: target,
        content: "Node-lifecycle output artifact for mode-invariant test",
        confinedBaseDir: sharedDir,
      });
      expect(result.ok).toBe(true);
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
