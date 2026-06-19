// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for graph-node-lifecycle: spawnReadyNodes prewarm-aware stagger
 * and graphNodeDepth threading to SpawnParams.
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnReadyNodes, spawnNode, handleSubAgentCompleted } from "./graph-node-lifecycle.js";
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
    nodeTokenSpend: new Map(),
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
    subAgentTokenBudget: null,
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

// ---------------------------------------------------------------------------
// handleSubAgentCompleted: per-node budget (BUDGET-02/03; D3/D5)
// ---------------------------------------------------------------------------

describe("handleSubAgentCompleted: per-node budget", () => {
  // A completion-path deps mock: getRunStatus returns a run with a response so
  // the success branch has output; eventBus.emit is spied for the event assertions.
  function makeCompletionDeps(): Parameters<typeof handleSubAgentCompleted>[1] {
    return {
      subAgentRunner: {
        spawn: vi.fn().mockReturnValue("run-1"),
        killRun: vi.fn(),
        getRunStatus: vi.fn().mockReturnValue({ status: "completed", result: { response: "ok" }, sessionKey: "sk-1" }),
      },
      eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      sendToChannel: vi.fn().mockResolvedValue(true),
      touchParentSession: vi.fn(),
    } as unknown as Parameters<typeof handleSubAgentCompleted>[1];
  }

  function makeCompletionConfig(subAgentTokenBudget: number | null = null): Parameters<typeof handleSubAgentCompleted>[2] {
    return { maxResultLength: 12000, subAgentTokenBudget } as unknown as Parameters<typeof handleSubAgentCompleted>[2];
  }

  // A graph state with a single node + a stubbed state machine that records the
  // markNodeFailed/markNodeCompleted calls. `callOrder` captures the relative
  // ordering of markNodeFailed vs the handleBudgetExceeded callback for D5.
  function makeBudgetGs(opts: {
    nodes: Array<{ nodeId: string; tokenBudget?: number; agentId?: string }>;
    graphBudget?: { maxTokens?: number; maxCost?: number };
    onFailure?: "fail-fast" | "continue";
    runNodeId: string;
    callOrder: string[];
  }): {
    gs: GraphRunState;
    markNodeFailed: ReturnType<typeof vi.fn>;
    markNodeCompleted: ReturnType<typeof vi.fn>;
    finalStatus: { value: string };
  } {
    const finalStatus = { value: "running" };
    const markNodeFailed = vi.fn((..._args: unknown[]) => {
      opts.callOrder.push("markNodeFailed");
      finalStatus.value = "failed";
      return { ok: true, value: { skipped: [], newlyReady: [], retrying: [] } };
    });
    const markNodeCompleted = vi.fn((..._args: unknown[]) => {
      finalStatus.value = "completed";
      return { ok: true, value: [] };
    });
    const stateMachine = {
      isTerminal: vi.fn().mockReturnValue(false),
      markNodeCompleted,
      markNodeFailed,
      getNodeState: vi.fn(() => ({ status: finalStatus.value, startedAt: 1000 })),
      snapshot: vi.fn(() => ({ nodes: new Map(), graphStatus: "running", executionOrder: [], isTerminal: false })),
      getReadyNodes: vi.fn(() => []),
    } as unknown as GraphRunState["stateMachine"];

    const gs = makeGraphRunState({
      graph: {
        graph: {
          label: "budget-test",
          nodes: opts.nodes.map((n) => ({ nodeId: n.nodeId, task: "t", dependsOn: [], retries: 0, ...n })),
          edges: [],
          ...(opts.graphBudget ? { budget: opts.graphBudget } : {}),
          ...(opts.onFailure ? { onFailure: opts.onFailure } : {}),
        },
      } as any,
      stateMachine,
      runIdToNode: new Map([["run-1", opts.runNodeId]]),
      sharedDir: "",
    });
    return { gs, markNodeFailed, markNodeCompleted, finalStatus };
  }

  const noopCallbacks = (handleBudgetExceeded: ReturnType<typeof vi.fn>): Parameters<typeof handleSubAgentCompleted>[5] => ({
    spawnReadyNodes: vi.fn(),
    handleGraphCompletion: vi.fn(),
    handleBudgetExceeded,
  });

  it("BUDGET-02 node-only breach fails the node terminally and does NOT abort the graph", () => {
    const callOrder: string[] = [];
    const { gs, markNodeFailed, markNodeCompleted } = makeBudgetGs({
      nodes: [{ nodeId: "n1", tokenBudget: 1_000, agentId: "child-a" }],
      onFailure: "continue",
      runNodeId: "n1",
      callOrder,
    });
    const deps = makeCompletionDeps();
    const handleBudgetExceeded = vi.fn();

    handleSubAgentCompleted(
      makeState(), deps, makeCompletionConfig(), gs,
      { runId: "run-1", success: true, tokensUsed: 5_000, cost: 0.1 },
      noopCallbacks(handleBudgetExceeded),
    );

    // The breaching SUCCESSFUL run is failed terminally, NOT completed.
    expect(markNodeFailed).toHaveBeenCalledTimes(1);
    const failArgs = markNodeFailed.mock.calls[0];
    expect(String(failArgs[1])).toContain("budget");
    expect(failArgs[3]).toEqual({ terminal: true });
    expect(markNodeCompleted).not.toHaveBeenCalled();
    // The per-node breach never alone aborts the graph.
    expect(handleBudgetExceeded).not.toHaveBeenCalled();
    // subagent:budget_exceeded emitted with the node's child agent + token numbers.
    const emit = (deps.eventBus.emit as ReturnType<typeof vi.fn>);
    const breach = emit.mock.calls.find((c) => c[0] === "subagent:budget_exceeded");
    expect(breach).toBeDefined();
    expect(breach![1]).toMatchObject({ graphId: gs.graphId, nodeId: "n1", agentId: "child-a", tokenBudget: 1_000, tokensUsed: 5_000 });
  });

  it("BUDGET-02 within budget completes the node and emits no breach", () => {
    const callOrder: string[] = [];
    const { gs, markNodeFailed, markNodeCompleted } = makeBudgetGs({
      nodes: [{ nodeId: "n1", tokenBudget: 1_000, agentId: "child-a" }],
      onFailure: "continue",
      runNodeId: "n1",
      callOrder,
    });
    const deps = makeCompletionDeps();
    const handleBudgetExceeded = vi.fn();

    handleSubAgentCompleted(
      makeState(), deps, makeCompletionConfig(), gs,
      { runId: "run-1", success: true, tokensUsed: 500, cost: 0.01 },
      noopCallbacks(handleBudgetExceeded),
    );

    expect(markNodeCompleted).toHaveBeenCalledTimes(1);
    expect(markNodeFailed).not.toHaveBeenCalled();
    const emit = (deps.eventBus.emit as ReturnType<typeof vi.fn>);
    expect(emit.mock.calls.find((c) => c[0] === "subagent:budget_exceeded")).toBeUndefined();
  });

  it("D5 node-first precedence: markNodeFailed runs BEFORE handleBudgetExceeded", () => {
    const callOrder: string[] = [];
    const { gs } = makeBudgetGs({
      nodes: [{ nodeId: "n1", tokenBudget: 1_000, agentId: "child-a" }],
      graphBudget: { maxTokens: 4_000 },
      runNodeId: "n1",
      callOrder,
    });
    const deps = makeCompletionDeps();
    const handleBudgetExceeded = vi.fn(() => { callOrder.push("handleBudgetExceeded"); });

    handleSubAgentCompleted(
      makeState(), deps, makeCompletionConfig(), gs,
      { runId: "run-1", success: true, tokensUsed: 5_000, cost: 0.1 },
      noopCallbacks(handleBudgetExceeded),
    );

    // Node fails first (per-node), THEN the cumulative abort fires — in series.
    expect(callOrder).toEqual(["markNodeFailed", "handleBudgetExceeded"]);
  });

  it("D3 inherit-share: no node budget → cap = graphBudget.maxTokens / total node count", () => {
    const callOrder: string[] = [];
    // 3 nodes, graph budget 9_000 → inherited per-node cap = 3_000.
    const { gs, markNodeFailed } = makeBudgetGs({
      nodes: [{ nodeId: "n1", agentId: "child-a" }, { nodeId: "n2" }, { nodeId: "n3" }],
      graphBudget: { maxTokens: 9_000 },
      onFailure: "continue",
      runNodeId: "n1",
      callOrder,
    });
    const deps = makeCompletionDeps();
    const handleBudgetExceeded = vi.fn();

    handleSubAgentCompleted(
      makeState(), deps, makeCompletionConfig(), gs,
      { runId: "run-1", success: true, tokensUsed: 4_000, cost: 0.05 },
      noopCallbacks(handleBudgetExceeded),
    );

    expect(markNodeFailed).toHaveBeenCalledTimes(1);
    const emit = (deps.eventBus.emit as ReturnType<typeof vi.fn>);
    const breach = emit.mock.calls.find((c) => c[0] === "subagent:budget_exceeded");
    expect(breach).toBeDefined();
    expect(breach![1]).toMatchObject({ tokenBudget: 3_000, tokensUsed: 4_000 });
  });

  it("D3 inherit-share: within inherited cap → no breach", () => {
    const callOrder: string[] = [];
    const { gs, markNodeFailed } = makeBudgetGs({
      nodes: [{ nodeId: "n1" }, { nodeId: "n2" }, { nodeId: "n3" }],
      graphBudget: { maxTokens: 9_000 },
      onFailure: "continue",
      runNodeId: "n1",
      callOrder,
    });
    const deps = makeCompletionDeps();

    handleSubAgentCompleted(
      makeState(), deps, makeCompletionConfig(), gs,
      { runId: "run-1", success: true, tokensUsed: 2_000, cost: 0.02 },
      noopCallbacks(vi.fn()),
    );

    expect(markNodeFailed).not.toHaveBeenCalled();
    const emit = (deps.eventBus.emit as ReturnType<typeof vi.fn>);
    expect(emit.mock.calls.find((c) => c[0] === "subagent:budget_exceeded")).toBeUndefined();
  });

  it("BUDGET-03 records nodeTokenSpend and enriches graph:node_updated with tokensUsed/cost", () => {
    const callOrder: string[] = [];
    const { gs } = makeBudgetGs({
      nodes: [{ nodeId: "n1", agentId: "child-a" }],
      runNodeId: "n1",
      callOrder,
    });
    const deps = makeCompletionDeps();

    handleSubAgentCompleted(
      makeState(), deps, makeCompletionConfig(), gs,
      { runId: "run-1", success: true, tokensUsed: 1_234, cost: 0.07 },
      noopCallbacks(vi.fn()),
    );

    expect(gs.nodeTokenSpend.get("n1")).toBe(1_234);
    const emit = (deps.eventBus.emit as ReturnType<typeof vi.fn>);
    const nodeUpdated = emit.mock.calls.filter((c) => c[0] === "graph:node_updated").pop();
    expect(nodeUpdated).toBeDefined();
    expect(nodeUpdated![1]).toMatchObject({ tokensUsed: 1_234, cost: 0.07 });
  });

  it("BUDGET-03 byte-identical: no node budget + no graph budget → no breach branch, node completes", () => {
    const callOrder: string[] = [];
    const { gs, markNodeFailed, markNodeCompleted } = makeBudgetGs({
      nodes: [{ nodeId: "n1", agentId: "child-a" }],
      runNodeId: "n1",
      callOrder,
    });
    const deps = makeCompletionDeps();
    const handleBudgetExceeded = vi.fn();

    handleSubAgentCompleted(
      makeState(), deps, makeCompletionConfig(null), gs,
      { runId: "run-1", success: true, tokensUsed: 999_999, cost: 9.9 },
      noopCallbacks(handleBudgetExceeded),
    );

    // No budget resolved anywhere → no per-node branch, node completes as today.
    expect(markNodeFailed).not.toHaveBeenCalled();
    expect(markNodeCompleted).toHaveBeenCalledTimes(1);
    expect(handleBudgetExceeded).not.toHaveBeenCalled();
    const emit = (deps.eventBus.emit as ReturnType<typeof vi.fn>);
    expect(emit.mock.calls.find((c) => c[0] === "subagent:budget_exceeded")).toBeUndefined();
    // The emit still carries the node's tokensUsed/cost (additive, from Test 5's enrichment).
    const nodeUpdated = emit.mock.calls.filter((c) => c[0] === "graph:node_updated").pop();
    expect(nodeUpdated![1]).toMatchObject({ tokensUsed: 999_999, cost: 9.9 });
  });
});
