// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for graph-helpers.ts — focused on transformNodes() field forwarding
 * and the O3 capabilityClass routing in buildGraphInput + isWeakCapabilityClass.
 *
 * These tests exist as a regression guard against the dropped-mcpServers bug
 * (yfinance trace): the daemon RPC pipeline.execute path
 * runs every node through transformNodes() before parseExecutionGraph(), and
 * any field NOT explicitly forwarded here is silently lost. The pipeline
 * tool already emits mcpServers as a camelCase field; the only thing
 * dropping it was the missing conditional spread inside transformNodes.
 *
 * The four cases below pin the contract for both LLM-emitted snake_case
 * (mcp_servers) and graph.load camelCase (mcpServers) inputs, the
 * absent-key case (downstream Zod default applies), and a full mapping
 * regression guard that every other existing field still flows through.
 *
 * O3 routing tests (added for Plan 155-04b):
 *   - isWeakCapabilityClass predicate: small/nano→true, frontier/mid/undefined→false
 *   - buildGraphInput with capabilityClass="frontier": unchanged direct path
 *   - buildGraphInput with capabilityClass="small" + valid graph: returns ValidatedGraph
 *   - buildGraphInput with capabilityClass="small" + invalid (cyclic) graph: throws fail-closed
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { transformNodes, isWeakCapabilityClass, buildGraphInput } from "./graph-helpers.js";

describe("transformNodes", () => {
  it("forwards mcp_servers snake_case input as mcpServers", () => {
    const result = transformNodes([
      { node_id: "x", task: "t", mcp_servers: ["yfinance"] },
    ]);

    expect(result).toHaveLength(1);
    const node = result[0] as Record<string, unknown>;
    expect(node.mcpServers).toEqual(["yfinance"]);
  });

  it("forwards mcpServers camelCase input unchanged through transformer", () => {
    const result = transformNodes([
      { nodeId: "x", task: "t", mcpServers: ["yfinance"] },
    ]);

    expect(result).toHaveLength(1);
    const node = result[0] as Record<string, unknown>;
    expect(node.mcpServers).toEqual(["yfinance"]);
  });

  it("omits mcpServers key entirely when neither input variant is present", () => {
    const result = transformNodes([
      { node_id: "x", task: "t" },
    ]);

    expect(result).toHaveLength(1);
    const node = result[0] as Record<string, unknown>;
    expect("mcpServers" in node).toBe(false);
  });

  it("preserves every existing snake_case to camelCase field mapping", () => {
    const result = transformNodes([
      {
        node_id: "x",
        task: "t",
        agent: "agent-id",
        model: "claude-sonnet-4-5-20250929",
        depends_on: ["a", "b"],
        timeout_ms: 30000,
        max_steps: 50,
        barrier_mode: "any",
        retries: 2,
        context_mode: "graph",
        type_id: "approval-gate",
        type_config: { mode: "noop" },
      },
    ]);

    expect(result).toHaveLength(1);
    const node = result[0] as Record<string, unknown>;
    expect(node.nodeId).toBe("x");
    expect(node.task).toBe("t");
    expect(node.agentId).toBe("agent-id");
    expect(node.model).toBe("claude-sonnet-4-5-20250929");
    expect(node.dependsOn).toEqual(["a", "b"]);
    expect(node.timeoutMs).toBe(30000);
    expect(node.maxSteps).toBe(50);
    expect(node.barrierMode).toBe("any");
    expect(node.retries).toBe(2);
    expect(node.contextMode).toBe("graph");
    expect(node.typeId).toBe("approval-gate");
    expect(node.typeConfig).toEqual({ mode: "noop" });
  });
});

// ---------------------------------------------------------------------------
// Bug-1 (v2.19 OR-01): normalize a lone `type_id:"agent"` (no type_config).
//
// A weak model often emits `type_id:"agent"` for a single-agent node WITHOUT a
// type_config (the node's own `agent` field already specifies the agent). The
// graph validator requires typeId+typeConfig both-or-neither, so the live NVDA
// pipeline (4 analyst nodes, each `type_id:"agent"`, no type_config) was hard-
// rejected ("Graph validation failed: typeId and typeConfig must both be present
// or both absent"). transformNodes must drop the redundant lone `typeId:"agent"`
// so the node runs as a regular single-agent node; an explicit `typeId:"agent"`
// WITH a type_config (deliberate driver use) and all other typed nodes are
// untouched. See design/small-model-orchestration-fidelity.md §4.
// ---------------------------------------------------------------------------
describe("transformNodes — lone typeId:agent normalization (OR-01)", () => {
  it("drops a lone type_id:agent with no type_config (regular single-agent node)", () => {
    const result = transformNodes([
      { node_id: "analyst_technical", task: "Research NVDA technicals", agent: "ta-analyst", max_steps: 30, context_mode: "full", type_id: "agent" },
    ]);
    const node = result[0] as Record<string, unknown>;
    expect("typeId" in node).toBe(false);
    expect(node.agentId).toBe("ta-analyst");
    expect("typeConfig" in node).toBe(false);
  });

  it("preserves type_id:agent WHEN a type_config is present (explicit driver use)", () => {
    const result = transformNodes([
      { node_id: "x", task: "t", type_id: "agent", type_config: { agent: "ta-analyst" } },
    ]);
    const node = result[0] as Record<string, unknown>;
    expect(node.typeId).toBe("agent");
    expect(node.typeConfig).toEqual({ agent: "ta-analyst" });
  });

  it("does NOT normalize other typed nodes — a lone type_id:debate keeps its typeId", () => {
    const result = transformNodes([
      { node_id: "x", task: "t", type_id: "debate" },
    ]);
    const node = result[0] as Record<string, unknown>;
    expect(node.typeId).toBe("debate");
  });
});

describe("buildGraphInput — lone typeId:agent DAG no longer rejected (OR-01, live NVDA payload)", () => {
  // The exact shape the live qwen3.6 model emitted to graph.execute, which was
  // hard-rejected with "Graph validation failed: typeId and typeConfig must both
  // be present or both absent."
  const NVDA_PARAMS: Record<string, unknown> = {
    nodes: [
      { node_id: "analyst_technical", task: "NVDA technical analysis", agent: "ta-analyst", max_steps: 30, context_mode: "full", type_id: "agent" },
      { node_id: "analyst_fundamentals", task: "NVDA fundamental analysis", agent: "ta-analyst", max_steps: 30, context_mode: "full", type_id: "agent" },
      { node_id: "analyst_industry", task: "NVDA industry analysis", agent: "ta-analyst", max_steps: 30, context_mode: "full", type_id: "agent" },
      { node_id: "analyst_valuation", task: "NVDA valuation analysis", agent: "ta-analyst", max_steps: 30, context_mode: "full", type_id: "agent" },
    ],
  };

  it("does NOT throw on the lone-typeId:agent NVDA payload (was: Graph validation failed)", () => {
    expect(() => buildGraphInput(NVDA_PARAMS)).not.toThrow();
  });

  it("normalizes each node to a regular single-agent node (agentId set, typeId undefined)", () => {
    const result = buildGraphInput(NVDA_PARAMS);
    expect(result.graph.nodes).toHaveLength(4);
    for (const n of result.graph.nodes) {
      expect(n.agentId).toBe("ta-analyst");
      expect(n.typeId).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// O3: isWeakCapabilityClass predicate
// ---------------------------------------------------------------------------

/** Minimal valid graph params for use in buildGraphInput tests. */
const VALID_GRAPH_PARAMS: Record<string, unknown> = {
  nodes: [
    { node_id: "a", task: "Research topic A" },
    { node_id: "b", task: "Research topic B", depends_on: ["a"] },
  ],
};

/** Cyclic graph params — b depends_on a AND a depends_on b → cycle. */
const CYCLIC_GRAPH_PARAMS: Record<string, unknown> = {
  nodes: [
    { node_id: "a", task: "Task A", depends_on: ["b"] },
    { node_id: "b", task: "Task B", depends_on: ["a"] },
  ],
};

describe("isWeakCapabilityClass", () => {
  it('returns true for "small"', () => {
    expect(isWeakCapabilityClass("small")).toBe(true);
  });

  it('returns true for "nano"', () => {
    expect(isWeakCapabilityClass("nano")).toBe(true);
  });

  it('returns false for "frontier"', () => {
    expect(isWeakCapabilityClass("frontier")).toBe(false);
  });

  it('returns false for "mid"', () => {
    expect(isWeakCapabilityClass("mid")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isWeakCapabilityClass(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// O3: buildGraphInput capabilityClass routing
// ---------------------------------------------------------------------------

describe("buildGraphInput — capabilityClass routing (O3)", () => {
  it("capable path: capabilityClass='frontier' returns ValidatedGraph (unchanged direct path)", () => {
    const result = buildGraphInput(VALID_GRAPH_PARAMS, "frontier");
    expect(result).toBeDefined();
    expect(result.graph).toBeDefined();
    expect(result.executionOrder).toBeDefined();
    expect(Array.isArray(result.executionOrder)).toBe(true);
    expect(result.graph.nodes).toHaveLength(2);
  });

  it("capable path: capabilityClass omitted returns the same ValidatedGraph as with 'frontier'", () => {
    const withFrontier = buildGraphInput(VALID_GRAPH_PARAMS, "frontier");
    const withUndefined = buildGraphInput(VALID_GRAPH_PARAMS);
    expect(withUndefined.executionOrder).toEqual(withFrontier.executionOrder);
    expect(withUndefined.graph.nodes.map((n) => n.nodeId)).toEqual(
      withFrontier.graph.nodes.map((n) => n.nodeId),
    );
  });

  it("weak path: capabilityClass='small' with a valid graph returns ValidatedGraph (fast-path)", () => {
    const result = buildGraphInput(VALID_GRAPH_PARAMS, "small");
    expect(result).toBeDefined();
    expect(result.graph).toBeDefined();
    expect(result.executionOrder).toBeDefined();
    expect(Array.isArray(result.executionOrder)).toBe(true);
  });

  it("weak path: capabilityClass='nano' with a valid graph returns ValidatedGraph (fast-path)", () => {
    const result = buildGraphInput(VALID_GRAPH_PARAMS, "nano");
    expect(result).toBeDefined();
    expect(result.graph).toBeDefined();
    expect(result.executionOrder).toBeDefined();
  });

  it("weak path: capabilityClass='small' with a cyclic (invalid) graph throws fail-closed with Phase-157 comment", () => {
    expect(() => buildGraphInput(CYCLIC_GRAPH_PARAMS, "small")).toThrow();
  });

  it("weak path: capabilityClass='small' with a cyclic graph throw message mentions Phase 157", () => {
    let msg = "";
    try {
      buildGraphInput(CYCLIC_GRAPH_PARAMS, "small");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/157/);
  });
});
