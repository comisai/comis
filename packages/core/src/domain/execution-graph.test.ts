// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  GraphNodeSchema,
  ExecutionGraphSchema,
  parseExecutionGraph,
  topologicalSort,
  validateAndSortGraph,
  GraphValidationError,
  NodeTypeIdSchema,
} from "./execution-graph.js";
import type { GraphNode } from "./execution-graph.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function node(nodeId: string, dependsOn: string[] = []): GraphNode {
  return GraphNodeSchema.parse({ nodeId, task: `Do ${nodeId}`, dependsOn });
}

// ---------------------------------------------------------------------------
// GraphNodeSchema
// ---------------------------------------------------------------------------

describe("GraphNodeSchema", () => {
  const validNode = {
    nodeId: "research",
    task: "Research the topic",
    agentId: "agent-1",
    model: "claude-sonnet-4-20250514",
    dependsOn: ["setup"],
    timeoutMs: 30000,
    maxSteps: 5,
  };

  it("accepts a valid node with all fields", () => {
    const result = GraphNodeSchema.safeParse(validNode);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nodeId).toBe("research");
      expect(result.data.task).toBe("Research the topic");
      expect(result.data.agentId).toBe("agent-1");
      expect(result.data.dependsOn).toEqual(["setup"]);
      expect(result.data.maxSteps).toBe(5);
    }
  });

  it("accepts a minimal node (only nodeId + task), defaults dependsOn to []", () => {
    const result = GraphNodeSchema.safeParse({ nodeId: "a", task: "Do A" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dependsOn).toEqual([]);
      expect(result.data.agentId).toBeUndefined();
      expect(result.data.model).toBeUndefined();
      expect(result.data.timeoutMs).toBeUndefined();
      expect(result.data.maxSteps).toBeUndefined();
    }
  });

  it("rejects empty nodeId", () => {
    const result = GraphNodeSchema.safeParse({ nodeId: "", task: "Do it" });
    expect(result.success).toBe(false);
  });

  it("rejects empty task", () => {
    const result = GraphNodeSchema.safeParse({ nodeId: "a", task: "" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra fields (strictObject enforcement)", () => {
    const result = GraphNodeSchema.safeParse({
      ...validNode,
      extra: "not-allowed",
    });
    expect(result.success).toBe(false);
  });

  it("rejects inputFrom as unknown field (strictObject enforcement)", () => {
    const result = GraphNodeSchema.safeParse({
      ...validNode,
      inputFrom: { setup: "setupResult" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative timeoutMs", () => {
    const result = GraphNodeSchema.safeParse({
      nodeId: "a",
      task: "Do A",
      timeoutMs: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero timeoutMs", () => {
    const result = GraphNodeSchema.safeParse({
      nodeId: "a",
      task: "Do A",
      timeoutMs: 0,
    });
    expect(result.success).toBe(false);
  });

  it("defaults contextMode to full when not provided", () => {
    const result = GraphNodeSchema.safeParse({ nodeId: "a", task: "Do A" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contextMode).toBe("full");
    }
  });

  it("accepts contextMode refs", () => {
    const result = GraphNodeSchema.safeParse({
      nodeId: "a",
      task: "Do A",
      contextMode: "refs",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contextMode).toBe("refs");
    }
  });

  it("accepts contextMode summary and none", () => {
    const summaryResult = GraphNodeSchema.safeParse({
      nodeId: "a",
      task: "Do A",
      contextMode: "summary",
    });
    expect(summaryResult.success).toBe(true);
    if (summaryResult.success) {
      expect(summaryResult.data.contextMode).toBe("summary");
    }

    const noneResult = GraphNodeSchema.safeParse({
      nodeId: "b",
      task: "Do B",
      contextMode: "none",
    });
    expect(noneResult.success).toBe(true);
    if (noneResult.success) {
      expect(noneResult.data.contextMode).toBe("none");
    }
  });

  it("rejects debate field as unknown (field removed)", () => {
    const result = GraphNodeSchema.safeParse({
      nodeId: "a",
      task: "Do A",
      debate: { agents: ["a1"] },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NodeTypeIdSchema
// ---------------------------------------------------------------------------

describe("NodeTypeIdSchema", () => {
  const validValues = [
    "agent",
    "debate",
    "vote",
    "refine",
    "collaborate",
    "approval-gate",
    "map-reduce",
  ];

  it("accepts all 7 valid node type IDs", () => {
    for (const value of validValues) {
      const result = NodeTypeIdSchema.safeParse(value);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(value);
      }
    }
  });

  it("rejects unknown values", () => {
    expect(NodeTypeIdSchema.safeParse("custom").success).toBe(false);
    expect(NodeTypeIdSchema.safeParse("unknown").success).toBe(false);
    expect(NodeTypeIdSchema.safeParse("").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GraphNodeSchema typeId/typeConfig
// ---------------------------------------------------------------------------

describe("GraphNodeSchema typeId/typeConfig", () => {
  it("accepts both typeId and typeConfig present", () => {
    const result = GraphNodeSchema.safeParse({
      nodeId: "a",
      task: "Do A",
      typeId: "debate",
      typeConfig: { agents: ["a1", "a2"], rounds: 2 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.typeId).toBe("debate");
      expect(result.data.typeConfig).toEqual({ agents: ["a1", "a2"], rounds: 2 });
    }
  });

  it("accepts neither typeId nor typeConfig (regular node)", () => {
    const result = GraphNodeSchema.safeParse({
      nodeId: "a",
      task: "Do A",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.typeId).toBeUndefined();
      expect(result.data.typeConfig).toBeUndefined();
    }
  });

  it("rejects only typeId without typeConfig", () => {
    const result = GraphNodeSchema.safeParse({
      nodeId: "a",
      task: "Do A",
      typeId: "debate",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join(" ");
      expect(message).toContain("typeId and typeConfig must both be present or both absent");
    }
  });

  it("rejects only typeConfig without typeId", () => {
    const result = GraphNodeSchema.safeParse({
      nodeId: "a",
      task: "Do A",
      typeConfig: { rounds: 2 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join(" ");
      expect(message).toContain("typeId and typeConfig must both be present or both absent");
    }
  });
});

// ---------------------------------------------------------------------------
// ExecutionGraphSchema
// ---------------------------------------------------------------------------

describe("ExecutionGraphSchema", () => {
  const validGraph = {
    nodes: [
      { nodeId: "a", task: "Do A" },
      { nodeId: "b", task: "Do B", dependsOn: ["a"] },
    ],
    label: "Test graph",
  };

  it("accepts a valid graph with multiple nodes", () => {
    const result = ExecutionGraphSchema.safeParse(validGraph);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nodes).toHaveLength(2);
      expect(result.data.label).toBe("Test graph");
    }
  });

  it("rejects empty nodes array", () => {
    const result = ExecutionGraphSchema.safeParse({ nodes: [] });
    expect(result.success).toBe(false);
  });

  it("rejects more than 20 nodes", () => {
    const nodes = Array.from({ length: 21 }, (_, i) => ({
      nodeId: `n${i}`,
      task: `Task ${i}`,
    }));
    const result = ExecutionGraphSchema.safeParse({ nodes });
    expect(result.success).toBe(false);
  });

  it("defaults onFailure to 'fail-fast'", () => {
    const result = ExecutionGraphSchema.safeParse(validGraph);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.onFailure).toBe("fail-fast");
    }
  });

  it("defaults timeoutMs to 1_500_000 (25 minutes)", () => {
    const result = ExecutionGraphSchema.safeParse(validGraph);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeoutMs).toBe(1_500_000);
    }
  });

  it("accepts onFailure 'continue'", () => {
    const result = ExecutionGraphSchema.safeParse({
      ...validGraph,
      onFailure: "continue",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.onFailure).toBe("continue");
    }
  });

  it("rejects unknown extra fields (strictObject enforcement)", () => {
    const result = ExecutionGraphSchema.safeParse({
      ...validGraph,
      extra: "not-allowed",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseExecutionGraph
// ---------------------------------------------------------------------------

describe("parseExecutionGraph", () => {
  it("returns ok for a valid graph", () => {
    const result = parseExecutionGraph({
      nodes: [{ nodeId: "a", task: "Do A" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodes).toHaveLength(1);
      expect(result.value.onFailure).toBe("fail-fast");
    }
  });

  it("returns err for invalid input (not a thrown ZodError)", () => {
    const result = parseExecutionGraph({ nodes: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeDefined();
      expect(result.error.issues).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// topologicalSort
// ---------------------------------------------------------------------------

describe("topologicalSort", () => {
  it("sorts a linear chain A -> B -> C", () => {
    const nodes = [node("A"), node("B", ["A"]), node("C", ["B"])];
    const result = topologicalSort(nodes);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(["A", "B", "C"]);
    }
  });

  it("sorts a diamond DAG (A first, D last)", () => {
    const nodes = [
      node("A"),
      node("B", ["A"]),
      node("C", ["A"]),
      node("D", ["B", "C"]),
    ];
    const result = topologicalSort(nodes);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]).toBe("A");
      expect(result.value[result.value.length - 1]).toBe("D");
      expect(result.value).toHaveLength(4);
      // B and C can be in any order, but both must come after A and before D
      expect(result.value.indexOf("B")).toBeGreaterThan(result.value.indexOf("A"));
      expect(result.value.indexOf("C")).toBeGreaterThan(result.value.indexOf("A"));
      expect(result.value.indexOf("B")).toBeLessThan(result.value.indexOf("D"));
      expect(result.value.indexOf("C")).toBeLessThan(result.value.indexOf("D"));
    }
  });

  it("returns all independent nodes (any order)", () => {
    const nodes = [node("X"), node("Y"), node("Z")];
    const result = topologicalSort(nodes);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
      expect(new Set(result.value)).toEqual(new Set(["X", "Y", "Z"]));
    }
  });

  it("handles single node with no dependencies", () => {
    const nodes = [node("solo")];
    const result = topologicalSort(nodes);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(["solo"]);
    }
  });

  it("detects a cycle: A -> B -> C -> A", () => {
    const nodes = [
      node("A", ["C"]),
      node("B", ["A"]),
      node("C", ["B"]),
    ];
    const result = topologicalSort(nodes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GraphValidationError);
      expect(result.error.kind).toBe("cycle");
      expect(result.error.message).toContain("Cycle detected");
      // Error message should include cycle path with arrows
      expect(result.error.message).toContain("->");
    }
  });

  it("detects self-dependency", () => {
    const nodes = [
      GraphNodeSchema.parse({ nodeId: "A", task: "Do A", dependsOn: ["A"] }),
    ];
    const result = topologicalSort(nodes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GraphValidationError);
      expect(result.error.kind).toBe("self_dependency");
      expect(result.error.nodes).toEqual(["A"]);
      expect(result.error.message).toContain("depends on itself");
    }
  });

  it("detects missing dependency", () => {
    const nodes = [
      GraphNodeSchema.parse({ nodeId: "A", task: "Do A", dependsOn: ["Z"] }),
    ];
    const result = topologicalSort(nodes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GraphValidationError);
      expect(result.error.kind).toBe("missing_dependency");
      expect(result.error.nodes).toContain("A");
      expect(result.error.nodes).toContain("Z");
      expect(result.error.message).toContain("non-existent");
    }
  });

  it("detects duplicate node IDs", () => {
    const nodes = [
      node("A"),
      GraphNodeSchema.parse({ nodeId: "A", task: "Another A" }),
    ];
    const result = topologicalSort(nodes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GraphValidationError);
      expect(result.error.kind).toBe("duplicate_node_id");
      expect(result.error.nodes).toEqual(["A"]);
    }
  });

  it("handles complex graph (5+ nodes) with correct dependency ordering", () => {
    // Graph: A -> B -> D -> E, A -> C -> D, C -> E
    const nodes = [
      node("A"),
      node("B", ["A"]),
      node("C", ["A"]),
      node("D", ["B", "C"]),
      node("E", ["D", "C"]),
    ];
    const result = topologicalSort(nodes);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const order = result.value;
      expect(order).toHaveLength(5);

      // Verify all dependencies are satisfied: for each node, all its
      // dependsOn appear earlier in the sorted output
      for (const n of nodes) {
        const nodeIdx = order.indexOf(n.nodeId);
        for (const dep of n.dependsOn) {
          const depIdx = order.indexOf(dep);
          expect(depIdx).toBeLessThan(nodeIdx);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// validateAndSortGraph
// ---------------------------------------------------------------------------

describe("validateAndSortGraph", () => {
  it("returns ValidatedGraph with graph and executionOrder for valid DAG", () => {
    const graph = ExecutionGraphSchema.parse({
      nodes: [
        { nodeId: "a", task: "Do A" },
        { nodeId: "b", task: "Do B", dependsOn: ["a"] },
      ],
    });
    const result = validateAndSortGraph(graph);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.graph).toBe(graph);
      expect(result.value.executionOrder).toEqual(["a", "b"]);
    }
  });

  it("returns GraphValidationError for cyclic graph", () => {
    const graph = ExecutionGraphSchema.parse({
      nodes: [
        { nodeId: "a", task: "Do A", dependsOn: ["b"] },
        { nodeId: "b", task: "Do B", dependsOn: ["a"] },
      ],
    });
    const result = validateAndSortGraph(graph);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GraphValidationError);
      expect(result.error.kind).toBe("cycle");
    }
  });
});
