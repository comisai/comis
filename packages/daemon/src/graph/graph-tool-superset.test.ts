// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for graph-wide tool superset computation.
 * Verifies that computeGraphToolSuperset correctly computes the
 * intersection-first tool superset with union fallback across graph nodes
 * for Anthropic prompt cache prefix sharing.
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { computeGraphToolSuperset } from "./graph-tool-superset.js";
import type { ValidatedGraph } from "@comis/core";

/** Helper to create a minimal ValidatedGraph with given node definitions. */
function makeGraph(nodes: Array<{ nodeId: string; agentId?: string }>): ValidatedGraph {
  return {
    graph: {
      label: "test-graph",
      nodes: nodes.map((n) => ({
        nodeId: n.nodeId,
        task: "do something",
        dependsOn: [],
        agentId: n.agentId,
      })),
    },
  } as unknown as ValidatedGraph;
}

describe("computeGraphToolSuperset", () => {
  it("falls back to sorted union when intersection has fewer than 2 tools", async () => {
    // agent-a: ["calc", "search"], agent-b: ["search", "write"]
    // Intersection: ["search"] (size 1 < MIN_INTERSECTION_SIZE of 2) => union fallback
    const assembleToolsFn = vi.fn<(agentId: string) => Promise<Array<{ name: string }>>>();
    assembleToolsFn.mockImplementation(async (agentId: string) => {
      if (agentId === "agent-a") return [{ name: "calc" }, { name: "search" }];
      if (agentId === "agent-b") return [{ name: "search" }, { name: "write" }];
      return [];
    });

    const graph = makeGraph([
      { nodeId: "n1", agentId: "agent-a" },
      { nodeId: "n2", agentId: "agent-b" },
    ]);

    const result = await computeGraphToolSuperset(graph, "default", assembleToolsFn);

    expect(result).toEqual(["calc", "search", "write"]);
    expect(assembleToolsFn).toHaveBeenCalledTimes(2);
  });

  it("returns intersection when 2 agents share 2+ tools", async () => {
    // agent-a: ["calc", "read", "search", "write"], agent-b: ["read", "search", "web"]
    // Intersection: ["read", "search"] (size 2, >= MIN_INTERSECTION_SIZE) => intersection
    const assembleToolsFn = vi.fn<(agentId: string) => Promise<Array<{ name: string }>>>();
    assembleToolsFn.mockImplementation(async (agentId: string) => {
      if (agentId === "agent-a") return [{ name: "calc" }, { name: "read" }, { name: "search" }, { name: "write" }];
      if (agentId === "agent-b") return [{ name: "read" }, { name: "search" }, { name: "web" }];
      return [];
    });

    const graph = makeGraph([
      { nodeId: "n1", agentId: "agent-a" },
      { nodeId: "n2", agentId: "agent-b" },
    ]);

    const result = await computeGraphToolSuperset(graph, "default", assembleToolsFn);

    expect(result).toEqual(["read", "search"]);
  });

  it("returns intersection when 3 agents share 2+ common tools", async () => {
    // agent-a: ["calc", "read", "search", "web"]
    // agent-b: ["read", "search", "write"]
    // agent-c: ["read", "search", "deploy"]
    // Intersection: ["read", "search"] (size 2, >= MIN_INTERSECTION_SIZE)
    const assembleToolsFn = vi.fn<(agentId: string) => Promise<Array<{ name: string }>>>();
    assembleToolsFn.mockImplementation(async (agentId: string) => {
      if (agentId === "agent-a") return [{ name: "calc" }, { name: "read" }, { name: "search" }, { name: "web" }];
      if (agentId === "agent-b") return [{ name: "read" }, { name: "search" }, { name: "write" }];
      if (agentId === "agent-c") return [{ name: "read" }, { name: "search" }, { name: "deploy" }];
      return [];
    });

    const graph = makeGraph([
      { nodeId: "n1", agentId: "agent-a" },
      { nodeId: "n2", agentId: "agent-b" },
      { nodeId: "n3", agentId: "agent-c" },
    ]);

    const result = await computeGraphToolSuperset(graph, "default", assembleToolsFn);

    expect(result).toEqual(["read", "search"]);
  });

  it("falls back to union when 2 agents have zero overlapping tools", async () => {
    // agent-a: ["calc", "search"], agent-b: ["write", "deploy"]
    // Intersection: [] (size 0 < MIN_INTERSECTION_SIZE) => union fallback
    const assembleToolsFn = vi.fn<(agentId: string) => Promise<Array<{ name: string }>>>();
    assembleToolsFn.mockImplementation(async (agentId: string) => {
      if (agentId === "agent-a") return [{ name: "calc" }, { name: "search" }];
      if (agentId === "agent-b") return [{ name: "write" }, { name: "deploy" }];
      return [];
    });

    const graph = makeGraph([
      { nodeId: "n1", agentId: "agent-a" },
      { nodeId: "n2", agentId: "agent-b" },
    ]);

    const result = await computeGraphToolSuperset(graph, "default", assembleToolsFn);

    expect(result).toEqual(["calc", "deploy", "search", "write"]);
  });

  it("deduplicates calls when all nodes use same defaultAgentId", async () => {
    const assembleToolsFn = vi.fn<(agentId: string) => Promise<Array<{ name: string }>>>();
    assembleToolsFn.mockResolvedValue([{ name: "exec" }, { name: "read" }]);

    const graph = makeGraph([
      { nodeId: "n1" },  // no agentId -> uses default
      { nodeId: "n2" },  // no agentId -> uses default
      { nodeId: "n3" },  // no agentId -> uses default
    ]);

    const result = await computeGraphToolSuperset(graph, "default-agent", assembleToolsFn);

    expect(assembleToolsFn).toHaveBeenCalledTimes(1);
    expect(assembleToolsFn).toHaveBeenCalledWith("default-agent");
    expect(result).toEqual(["exec", "read"]);
  });

  it("returns deterministically sorted array regardless of input order", async () => {
    const assembleToolsFn = vi.fn<(agentId: string) => Promise<Array<{ name: string }>>>();
    assembleToolsFn.mockResolvedValue([
      { name: "zebra" },
      { name: "alpha" },
      { name: "mango" },
      { name: "delta" },
    ]);

    const graph = makeGraph([{ nodeId: "n1" }]);

    const result = await computeGraphToolSuperset(graph, "default", assembleToolsFn);

    expect(result).toEqual(["alpha", "delta", "mango", "zebra"]);
  });

  it("returns single agent's tools sorted with one node", async () => {
    const assembleToolsFn = vi.fn<(agentId: string) => Promise<Array<{ name: string }>>>();
    assembleToolsFn.mockResolvedValue([{ name: "write" }, { name: "read" }]);

    const graph = makeGraph([{ nodeId: "solo", agentId: "solo-agent" }]);

    const result = await computeGraphToolSuperset(graph, "default", assembleToolsFn);

    expect(result).toEqual(["read", "write"]);
    expect(assembleToolsFn).toHaveBeenCalledWith("solo-agent");
  });

  it("returns empty array when graph has no nodes", async () => {
    const assembleToolsFn = vi.fn<(agentId: string) => Promise<Array<{ name: string }>>>();

    const graph = makeGraph([]);

    const result = await computeGraphToolSuperset(graph, "default", assembleToolsFn);

    expect(result).toEqual([]);
    expect(assembleToolsFn).not.toHaveBeenCalled();
  });

  it("returns empty array on assembleToolsFn error (best-effort)", async () => {
    const assembleToolsFn = vi.fn<(agentId: string) => Promise<Array<{ name: string }>>>();
    assembleToolsFn.mockRejectedValue(new Error("MCP connection failed"));

    const graph = makeGraph([{ nodeId: "n1", agentId: "broken-agent" }]);

    const result = await computeGraphToolSuperset(graph, "default", assembleToolsFn);

    expect(result).toEqual([]);
  });
});
