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

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import type { TemplateMatch } from "@comis/agent";

import { transformNodes, isWeakCapabilityClass, buildGraphInput } from "./graph-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

// v2.19: after a successful graph.execute dispatch, the model-facing hint must be a
// strong STOP signal — a weak model that dispatched a 6-node NVDA pipeline then kept
// researching NVDA itself (130 tool calls) and exhausted its own context. The hint
// lives in graph-mutate.ts; assert its load-bearing directives via source-grep.
describe("graph.execute dispatch hint (caller stop-after-delegate, v2.19)", () => {
  it("tells the model its job is DONE, to STOP, and to NOT research the topic itself", () => {
    const src = readFileSync(resolve(here, "graph-mutate.ts"), "utf-8");
    const hintMatch = src.match(/hint:\s*"([^"]*Pipeline launched[^"]*)"/);
    expect(hintMatch).not.toBeNull();
    const hint = (hintMatch?.[1] ?? "").toLowerCase();
    expect(hint).toContain("done");
    expect(hint).toContain("stop");
    expect(hint).toContain("do not research");
    expect(hint).toContain("exhaust");
  });
});

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

  it("collapses type_config:{agent} with NO type_id to a regular node (the live 8-node NVDA shape)", () => {
    // The live qwen3.6 model emitted every node as { agent, type_config:{agent} }
    // with NO type_id — the MIRROR of the first failure. The both-or-neither rule
    // rejects typeConfig-without-typeId too. Collapse it: drop the redundant
    // type_config, agentId from the node's agent (or the config's agent).
    const result = transformNodes([
      { node_id: "analyst-technical", task: "t", agent: "ta-analyst", type_config: { agent: "ta-analyst" } },
      { node_id: "debate-summary", task: "t", type_config: { agent: "ta-analyst" }, depends_on: ["bull"] }, // agent ONLY in config
    ]);
    const a = result[0] as Record<string, unknown>;
    expect("typeId" in a).toBe(false);
    expect("typeConfig" in a).toBe(false);
    expect(a.agentId).toBe("ta-analyst");
    const b = result[1] as Record<string, unknown>;
    expect("typeConfig" in b).toBe(false);
    expect(b.agentId).toBe("ta-analyst"); // lifted from type_config.agent
    expect(b.dependsOn).toEqual(["bull"]);
  });

  it("collapses type_id:agent WITH a {agent} type_config to a regular node (redundant driver use)", () => {
    const result = transformNodes([
      { node_id: "x", task: "t", type_id: "agent", type_config: { agent: "ta-analyst" } },
    ]);
    const node = result[0] as Record<string, unknown>;
    expect("typeId" in node).toBe(false);
    expect("typeConfig" in node).toBe(false);
    expect(node.agentId).toBe("ta-analyst");
  });

  it("does NOT normalize other typed nodes — a lone type_id:debate keeps its typeId", () => {
    const result = transformNodes([
      { node_id: "x", task: "t", type_id: "debate" },
    ]);
    const node = result[0] as Record<string, unknown>;
    expect(node.typeId).toBe("debate");
  });

  it("does NOT collapse a real typed node config (type_id:debate + {agents:[...]})", () => {
    const result = transformNodes([
      { node_id: "x", task: "t", type_id: "debate", type_config: { agents: ["a", "b"], rounds: 2 } },
    ]);
    const node = result[0] as Record<string, unknown>;
    expect(node.typeId).toBe("debate");
    expect(node.typeConfig).toEqual({ agents: ["a", "b"], rounds: 2 });
  });
});

describe("buildGraphInput — full 8-node NVDA DAG (type_config:{agent} no type_id, live payload)", () => {
  // The exact 8-node graph the live qwen3.6 model emitted (analysts → bull/bear →
  // debate-summary → head-trader), every node with type_config:{agent} and NO
  // type_id — rejected with "typeId and typeConfig must both be present or both absent".
  const PARAMS: Record<string, unknown> = {
    nodes: [
      { node_id: "analyst-technical", task: "tech", agent: "ta-analyst", type_config: { agent: "ta-analyst" } },
      { node_id: "analyst-fundamental", task: "fund", agent: "ta-analyst", type_config: { agent: "ta-analyst" } },
      { node_id: "analyst-sector", task: "sector", agent: "ta-analyst", type_config: { agent: "ta-analyst" } },
      { node_id: "analyst-catalyst", task: "catalyst", agent: "ta-analyst", type_config: { agent: "ta-analyst" } },
      { node_id: "bull-debater", task: "bull", agent: "ta-analyst", type_config: { agent: "ta-analyst" }, depends_on: ["analyst-technical", "analyst-fundamental", "analyst-sector", "analyst-catalyst"] },
      { node_id: "bear-debater", task: "bear", agent: "ta-analyst", type_config: { agent: "ta-analyst" }, depends_on: ["analyst-technical", "analyst-fundamental", "analyst-sector", "analyst-catalyst"] },
      { node_id: "debate-summary", task: "summary", type_config: { agent: "ta-analyst" }, depends_on: ["bull-debater", "bear-debater"] },
      { node_id: "head-trader", task: "call", agent: "ta-trader", type_config: { agent: "ta-trader" }, depends_on: ["debate-summary"] },
    ],
  };

  it("does NOT throw on the full 8-node config-only DAG (was: Graph validation failed nodes.0..7)", async () => {
    await expect(buildGraphInput(PARAMS)).resolves.toBeDefined();
  });

  it("collapses all 8 nodes to regular single-agent nodes with the right agentIds + edges", async () => {
    const result = await buildGraphInput(PARAMS);
    expect(result.graph.nodes).toHaveLength(8);
    for (const n of result.graph.nodes) {
      expect(n.typeId).toBeUndefined();
      expect(n.agentId === "ta-analyst" || n.agentId === "ta-trader").toBe(true);
    }
    expect(result.graph.nodes.find((n) => n.nodeId === "head-trader")?.agentId).toBe("ta-trader");
    // depends_on edges preserved → a valid execution order exists.
    expect(result.executionOrder.length).toBe(8);
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

  it("does NOT throw on the lone-typeId:agent NVDA payload (was: Graph validation failed)", async () => {
    await expect(buildGraphInput(NVDA_PARAMS)).resolves.toBeDefined();
  });

  it("normalizes each node to a regular single-agent node (agentId set, typeId undefined)", async () => {
    const result = await buildGraphInput(NVDA_PARAMS);
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
  // M-2 (Phase 174-03): buildGraphInput is now ASYNC (the weak-invalid branch may
  // run the repair). ALL FIVE call sites below are AWAITED — the values/assertions
  // are UNCHANGED, only the calls become `await` and the throw-assertions become
  // `await expect(...).rejects.toThrow(...)`. No behavior change, just the Promise
  // plumbing (the byte-identical seam: with no repair context the Phase-157 throw
  // is exactly as before).
  it("capable path: capabilityClass='frontier' returns ValidatedGraph (unchanged direct path)", async () => {
    const result = await buildGraphInput(VALID_GRAPH_PARAMS, "frontier");
    expect(result).toBeDefined();
    expect(result.graph).toBeDefined();
    expect(result.executionOrder).toBeDefined();
    expect(Array.isArray(result.executionOrder)).toBe(true);
    expect(result.graph.nodes).toHaveLength(2);
  });

  it("capable path: capabilityClass omitted returns the same ValidatedGraph as with 'frontier'", async () => {
    const withFrontier = await buildGraphInput(VALID_GRAPH_PARAMS, "frontier");
    const withUndefined = await buildGraphInput(VALID_GRAPH_PARAMS);
    expect(withUndefined.executionOrder).toEqual(withFrontier.executionOrder);
    expect(withUndefined.graph.nodes.map((n) => n.nodeId)).toEqual(
      withFrontier.graph.nodes.map((n) => n.nodeId),
    );
  });

  it("weak path: capabilityClass='small' with a valid graph returns ValidatedGraph (fast-path)", async () => {
    const result = await buildGraphInput(VALID_GRAPH_PARAMS, "small");
    expect(result).toBeDefined();
    expect(result.graph).toBeDefined();
    expect(result.executionOrder).toBeDefined();
    expect(Array.isArray(result.executionOrder)).toBe(true);
  });

  it("weak path: capabilityClass='nano' with a valid graph returns ValidatedGraph (fast-path)", async () => {
    const result = await buildGraphInput(VALID_GRAPH_PARAMS, "nano");
    expect(result).toBeDefined();
    expect(result.graph).toBeDefined();
    expect(result.executionOrder).toBeDefined();
  });

  it("weak path: capabilityClass='small' with a cyclic (invalid) graph throws fail-closed with Phase-157 comment", async () => {
    await expect(buildGraphInput(CYCLIC_GRAPH_PARAMS, "small")).rejects.toThrow();
  });

  it("weak path: capabilityClass='small' with a cyclic graph throw message mentions Phase 157 (FLAGS-OFF, no repair context)", async () => {
    let msg = "";
    try {
      await buildGraphInput(CYCLIC_GRAPH_PARAMS, "small");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/157/);
  });
});

// ---------------------------------------------------------------------------
// AUTHOR-01 (Phase 174-03): the gated weak-model repair branch in buildGraphInput.
// The capable + weak-valid paths are unchanged (tested above); these pin the
// un-commented weak-INVALID branch: gated repair to a canonical template, the
// structured did-you-mean on ambiguity, governance re-run on the repaired graph,
// best-effort emit, and FLAGS-OFF byte-identical (Phase-157 throw unchanged).
// ---------------------------------------------------------------------------

const FLAGS_ON_AUTHORING = { repairProducer: true, intentAction: false, gbnfConstrain: false };

/** A repairMatch stub returning a valid filled `debate` (2 leaves + 1 fan-in). */
const matchToDebate: (rawGraph: unknown) => TemplateMatch = () => ({
  kind: "matched",
  pattern: "debate",
  filledNodes: [
    { nodeId: "pro", task: "Argue FOR", dependsOn: [] },
    { nodeId: "con", task: "Argue AGAINST", dependsOn: [] },
    { nodeId: "judge", task: "Verdict", dependsOn: ["pro", "con"] },
  ],
});

describe("buildGraphInput — weak-model repair branch (AUTHOR-01)", () => {
  it("Test 1 (FLAGS-OFF byte-identical seam): repairProducer:false + weak + invalid → still rejects with the Phase-157 message", async () => {
    const emit = vi.fn();
    await expect(
      buildGraphInput(CYCLIC_GRAPH_PARAMS, "small", {
        authoringConfig: { repairProducer: false, intentAction: false, gbnfConstrain: false },
        repairMatch: matchToDebate, // present, but gate is OFF → never consulted
        eventBus: { emit, on: vi.fn() } as never,
      }),
    ).rejects.toThrow(/157/);
    // The matcher and emit were never reached (the gate short-circuits).
    expect(emit).not.toHaveBeenCalled();
  });

  it("Test 2 (repair): repairProducer:true + weak + invalid graph that unambiguously matches debate → resolves to the repaired ValidatedGraph + emits graph:repaired once", async () => {
    const emit = vi.fn();
    const result = await buildGraphInput(CYCLIC_GRAPH_PARAMS, "small", {
      authoringConfig: FLAGS_ON_AUTHORING,
      repairMatch: matchToDebate,
      eventBus: { emit, on: vi.fn() } as never,
      agentId: "weakbot",
    });
    // The repaired graph is the debate template (3 nodes), governance-clean.
    expect(result.graph.nodes).toHaveLength(3);
    expect(result.executionOrder.length).toBe(3);
    // graph:repaired emitted exactly once, counts/ids/enums only.
    const repaired = emit.mock.calls.filter((c) => c[0] === "graph:repaired");
    expect(repaired).toHaveLength(1);
    expect(repaired[0]![1]).toMatchObject({
      pattern: "debate",
      nodeCount: 3,
      capabilityClass: "small",
      agentId: "weakbot",
    });
  });

  it("Test 3 (did-you-mean): repairProducer:true + weak + ambiguous match → rejects with a structured did-you-mean (no synthesis)", async () => {
    const ambiguous: (rawGraph: unknown) => TemplateMatch = () => ({
      kind: "ambiguous",
      candidates: ["research-fanout", "vote", "map-reduce"],
    });
    await expect(
      buildGraphInput(CYCLIC_GRAPH_PARAMS, "small", {
        authoringConfig: FLAGS_ON_AUTHORING,
        repairMatch: ambiguous,
      }),
    ).rejects.toThrow(/Did you mean one of these templates:.*from_intent/);
  });

  it("Test 3b (no-match): repairProducer:true + weak + no-match → falls through to the Phase-157 throw", async () => {
    const noMatch: (rawGraph: unknown) => TemplateMatch = () => ({ kind: "no-match" });
    await expect(
      buildGraphInput(CYCLIC_GRAPH_PARAMS, "small", {
        authoringConfig: FLAGS_ON_AUTHORING,
        repairMatch: noMatch,
      }),
    ).rejects.toThrow(/157/);
  });

  it("Test 4 (governance preserved): a repaired graph that would itself fail validation is NOT returned — falls through to the Phase-157 throw", async () => {
    // The matcher returns a "matched" whose filledNodes are themselves cyclic →
    // the re-run parse+sort governance rejects them, so buildGraphInput must NOT
    // return an unvalidated graph (D-SAME-VALIDATION §9).
    const matchCyclic: (rawGraph: unknown) => TemplateMatch = () => ({
      kind: "matched",
      pattern: "debate",
      filledNodes: [
        { nodeId: "x", task: "X", dependsOn: ["y"] },
        { nodeId: "y", task: "Y", dependsOn: ["x"] },
      ],
    });
    await expect(
      buildGraphInput(CYCLIC_GRAPH_PARAMS, "small", {
        authoringConfig: FLAGS_ON_AUTHORING,
        repairMatch: matchCyclic,
      }),
    ).rejects.toThrow(/157/);
  });

  it("Test 5 (emit best-effort): a throwing graph:repaired emit does NOT break the valid repaired graph", async () => {
    const throwingEmit = vi.fn(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    const warn = vi.fn();
    const result = await buildGraphInput(CYCLIC_GRAPH_PARAMS, "small", {
      authoringConfig: FLAGS_ON_AUTHORING,
      repairMatch: matchToDebate,
      eventBus: { emit: throwingEmit, on: vi.fn() } as never,
      logger: { info: vi.fn(), warn, debug: vi.fn(), error: vi.fn() } as never,
    });
    // The repaired graph is returned despite the telemetry throw…
    expect(result.graph.nodes).toHaveLength(3);
    // …and the throw was logged at WARN (errorKind), never surfaced.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ errorKind: expect.any(String) });
  });
});
