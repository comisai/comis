// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the per-node token-budget helpers (BUDGET-02/03; D2/D3/D5).
 * Covers resolveNodeBudget's 4-way precedence, applyNodeBudgetBreach's record +
 * terminal-fail + event branches, and emitSkipsAndSpawnReady's dedup/spawn paths.
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { resolveNodeBudget, applyNodeBudgetBreach, emitSkipsAndSpawnReady } from "./graph-node-budget.js";
import type { GraphRunState } from "./graph-coordinator-state.js";

function makeGs(opts: {
  nodes: Array<{ nodeId: string; tokenBudget?: number; agentId?: string }>;
  graphBudget?: { maxTokens?: number; maxCost?: number };
  isTerminal?: boolean;
  markNodeFailed?: ReturnType<typeof vi.fn>;
}): GraphRunState {
  return {
    graphId: "g1",
    graph: {
      graph: {
        nodes: opts.nodes.map((n) => ({ dependsOn: [], task: "t", retries: 0, ...n })),
        ...(opts.graphBudget ? { budget: opts.graphBudget } : {}),
      },
    },
    stateMachine: {
      isTerminal: vi.fn().mockReturnValue(opts.isTerminal ?? false),
      markNodeFailed: opts.markNodeFailed ?? vi.fn(() => ({ ok: true, value: { skipped: [], newlyReady: [], retrying: [] } })),
    },
    nodeTokenSpend: new Map<string, number>(),
    skippedNodesEmitted: new Set<string>(),
  } as unknown as GraphRunState;
}

describe("resolveNodeBudget — precedence (D3)", () => {
  it("node.tokenBudget wins over operator default and inherit-share", () => {
    const gs = makeGs({ nodes: [{ nodeId: "n1", tokenBudget: 500 }], graphBudget: { maxTokens: 9_000 } });
    expect(resolveNodeBudget(gs, "n1", 2_000)).toBe(500);
  });

  it("operator default applies when node.tokenBudget unset", () => {
    const gs = makeGs({ nodes: [{ nodeId: "n1" }], graphBudget: { maxTokens: 9_000 } });
    expect(resolveNodeBudget(gs, "n1", 2_000)).toBe(2_000);
  });

  it("inherit-share = floor(graphBudget.maxTokens / total nodes) when no node/operator budget", () => {
    const gs = makeGs({ nodes: [{ nodeId: "n1" }, { nodeId: "n2" }, { nodeId: "n3" }], graphBudget: { maxTokens: 10_000 } });
    expect(resolveNodeBudget(gs, "n1", null)).toBe(3_333); // floor(10000/3)
  });

  it("undefined (unbounded) when no node budget, no operator default, no graph budget", () => {
    const gs = makeGs({ nodes: [{ nodeId: "n1" }] });
    expect(resolveNodeBudget(gs, "n1", null)).toBeUndefined();
  });

  it("undefined when a graph budget exists but has no maxTokens (cost-only budget)", () => {
    const gs = makeGs({ nodes: [{ nodeId: "n1" }], graphBudget: { maxCost: 5 } });
    expect(resolveNodeBudget(gs, "n1", null)).toBeUndefined();
  });
});

describe("applyNodeBudgetBreach", () => {
  function makeDeps() {
    return {
      eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as never,
      logger: { warn: vi.fn() },
      defaultAgentId: "default-agent",
    };
  }

  it("records nodeTokenSpend even when no budget resolves (no breach)", () => {
    const gs = makeGs({ nodes: [{ nodeId: "n1" }] });
    const result = applyNodeBudgetBreach(makeDeps(), { subAgentTokenBudget: null }, gs, "n1", 12345);
    expect(result.breached).toBe(false);
    expect(gs.nodeTokenSpend.get("n1")).toBe(12345);
  });

  it("breaches, terminal-fails the node, and emits subagent:budget_exceeded attributed to the child agent (M3)", () => {
    const markNodeFailed = vi.fn(() => ({ ok: true, value: { skipped: ["dep"], newlyReady: [], retrying: [] } }));
    const gs = makeGs({ nodes: [{ nodeId: "n1", tokenBudget: 1_000, agentId: "child-x" }], markNodeFailed });
    const deps = makeDeps();
    const result = applyNodeBudgetBreach(deps, { subAgentTokenBudget: null }, gs, "n1", 5_000, "sk-9");

    expect(result.breached).toBe(true);
    expect(result.failResult?.skipped).toEqual(["dep"]);
    // Terminal flag is set on the fail (D2).
    expect(markNodeFailed).toHaveBeenCalledWith("n1", expect.stringContaining("budget"), "sk-9", { terminal: true });
    const emit = deps.eventBus.emit as unknown as ReturnType<typeof vi.fn>;
    const breach = emit.mock.calls.find((c) => c[0] === "subagent:budget_exceeded");
    expect(breach![1]).toMatchObject({ graphId: "g1", nodeId: "n1", agentId: "child-x", tokenBudget: 1_000, tokensUsed: 5_000 });
  });

  it("falls back to defaultAgentId in the event when the node has no agentId (M3)", () => {
    const gs = makeGs({ nodes: [{ nodeId: "n1", tokenBudget: 1_000 }] });
    const deps = makeDeps();
    applyNodeBudgetBreach(deps, { subAgentTokenBudget: null }, gs, "n1", 5_000);
    const emit = deps.eventBus.emit as unknown as ReturnType<typeof vi.fn>;
    const breach = emit.mock.calls.find((c) => c[0] === "subagent:budget_exceeded");
    expect(breach![1]).toMatchObject({ agentId: "default-agent" });
  });

  it("does NOT breach when the graph is already terminal (guards a late completion)", () => {
    const markNodeFailed = vi.fn();
    const gs = makeGs({ nodes: [{ nodeId: "n1", tokenBudget: 1_000 }], isTerminal: true, markNodeFailed });
    const result = applyNodeBudgetBreach(makeDeps(), { subAgentTokenBudget: null }, gs, "n1", 5_000);
    expect(result.breached).toBe(false);
    expect(markNodeFailed).not.toHaveBeenCalled();
    expect(gs.nodeTokenSpend.get("n1")).toBe(5_000); // spend still recorded
  });

  it("warns and reports no failResult when the terminal-fail transition errors", () => {
    const markNodeFailed = vi.fn(() => ({ ok: false, error: "bad transition" }));
    const gs = makeGs({ nodes: [{ nodeId: "n1", tokenBudget: 1_000 }], markNodeFailed });
    const deps = makeDeps();
    const result = applyNodeBudgetBreach(deps, { subAgentTokenBudget: null }, gs, "n1", 5_000);
    expect(result.breached).toBe(true);
    expect(result.failResult).toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "internal" }),
      expect.stringContaining("Budget-fail node transition failed"),
    );
  });
});

describe("emitSkipsAndSpawnReady", () => {
  it("emits skipped (deduped) and queues a spawn pass on newlyReady", async () => {
    const emit = vi.fn();
    const spawnReadyNodes = vi.fn();
    const gs = makeGs({ nodes: [{ nodeId: "n1" }] });
    gs.skippedNodesEmitted.add("already"); // pre-emitted — must NOT re-emit
    emitSkipsAndSpawnReady({ eventBus: { emit } as never }, gs, { skipped: ["already", "fresh"], newlyReady: ["r1"] }, spawnReadyNodes);

    const skips = emit.mock.calls.filter((c) => c[0] === "graph:node_updated").map((c) => (c[1] as { nodeId: string }).nodeId);
    expect(skips).toEqual(["fresh"]); // "already" deduped
    await Promise.resolve(); // flush the microtask
    expect(spawnReadyNodes).toHaveBeenCalledWith(gs);
  });

  it("does not queue a spawn pass when newlyReady is empty", async () => {
    const spawnReadyNodes = vi.fn();
    const gs = makeGs({ nodes: [{ nodeId: "n1" }] });
    emitSkipsAndSpawnReady({ eventBus: { emit: vi.fn() } as never }, gs, { skipped: [], newlyReady: [] }, spawnReadyNodes);
    await Promise.resolve();
    expect(spawnReadyNodes).not.toHaveBeenCalled();
  });
});
