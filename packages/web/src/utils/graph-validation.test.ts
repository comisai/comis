// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { validateGraph } from "./graph-validation.js";
import type { PipelineNode, PipelineEdge } from "../api/types/index.js";

/** Helper to create a minimal PipelineNode */
function makeNode(
  id: string,
  overrides: Partial<PipelineNode> = {},
): PipelineNode {
  return {
    id,
    task: `Task ${id}`,
    dependsOn: [],
    position: { x: 0, y: 0 },
    ...overrides,
  };
}

/** Helper to create a PipelineEdge */
function makeEdge(source: string, target: string): PipelineEdge {
  return { id: `${source}->${target}`, source, target };
}

describe("validateGraph", () => {
  // ---------------------------------------------------------------------------
  // Error rules
  // ---------------------------------------------------------------------------

  describe("error rules", () => {
    it("returns error for empty graph (no nodes)", () => {
      const result = validateGraph([], []);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.severity).toBe("error");
      expect(result.errors[0]!.message).toMatch(/at least 1 node/i);
    });

    it("returns error when more than 20 nodes", () => {
      const nodes: PipelineNode[] = [];
      for (let i = 0; i < 21; i++) {
        nodes.push(makeNode(`n${i}`));
      }

      const result = validateGraph(nodes, []);

      expect(result.valid).toBe(false);
      const err = result.errors.find((e) => e.message.match(/20/));
      expect(err).toBeDefined();
      expect(err!.severity).toBe("error");
      expect(err!.message).toMatch(/21/); // includes current count
    });

    it("returns error for duplicate node ID", () => {
      const nodes = [makeNode("dup"), makeNode("dup")];

      const result = validateGraph(nodes, []);

      expect(result.valid).toBe(false);
      const err = result.errors.find((e) => e.message.match(/duplicate/i));
      expect(err).toBeDefined();
      expect(err!.nodeIds).toContain("dup");
    });

    it("returns error for node without task (empty string)", () => {
      const nodes = [makeNode("n1", { task: "" })];

      const result = validateGraph(nodes, []);

      expect(result.valid).toBe(false);
      const err = result.errors.find((e) => e.message.match(/task/i));
      expect(err).toBeDefined();
      expect(err!.nodeIds).toContain("n1");
    });

    it("returns error for node without task (whitespace only)", () => {
      const nodes = [makeNode("n1", { task: "   " })];

      const result = validateGraph(nodes, []);

      expect(result.valid).toBe(false);
      const err = result.errors.find((e) => e.message.match(/task/i));
      expect(err).toBeDefined();
      expect(err!.nodeIds).toContain("n1");
    });

    it("returns error for self-dependency", () => {
      const nodes = [makeNode("n1", { dependsOn: ["n1"] })];

      const result = validateGraph(nodes, []);

      expect(result.valid).toBe(false);
      const err = result.errors.find((e) => e.message.match(/self/i));
      expect(err).toBeDefined();
      expect(err!.nodeIds).toContain("n1");
    });

    it("returns error for missing dependency ref", () => {
      const nodes = [makeNode("n1", { dependsOn: ["ghost"] })];

      const result = validateGraph(nodes, []);

      expect(result.valid).toBe(false);
      const err = result.errors.find((e) => e.message.match(/missing/i));
      expect(err).toBeDefined();
      expect(err!.nodeIds).toContain("n1");
    });

    it("returns error for cycle (A->B->C->A)", () => {
      const nodes = [
        makeNode("A", { dependsOn: ["C"] }),
        makeNode("B", { dependsOn: ["A"] }),
        makeNode("C", { dependsOn: ["B"] }),
      ];
      const edges = [
        makeEdge("C", "A"),
        makeEdge("A", "B"),
        makeEdge("B", "C"),
      ];

      const result = validateGraph(nodes, edges);

      expect(result.valid).toBe(false);
      const err = result.errors.find((e) => e.message.match(/cycle/i));
      expect(err).toBeDefined();
      expect(err!.nodeIds).toBeDefined();
      expect(err!.nodeIds!.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Warning rules
  // ---------------------------------------------------------------------------

  describe("warning rules", () => {
    it("returns warning for node without agentId and no typeConfig agent", () => {
      const nodes = [makeNode("n1")]; // no agentId, no typeConfig

      const result = validateGraph(nodes, []);

      expect(result.valid).toBe(true); // warnings don't invalidate
      const warn = result.warnings.find((w) => w.message.match(/agent/i));
      expect(warn).toBeDefined();
      expect(warn!.severity).toBe("warning");
      expect(warn!.nodeIds).toContain("n1");
    });

    it("no warning when typeConfig.agent is set (agent-type node)", () => {
      const nodes = [makeNode("n1", { typeId: "agent", typeConfig: { agent: "ta-fundamentals" } })];

      const result = validateGraph(nodes, []);

      const warn = result.warnings.find((w) => w.message.match(/no agent assigned/i));
      expect(warn).toBeUndefined();
    });

    it("no warning when typeConfig.agents is set (debate-type node)", () => {
      const nodes = [makeNode("n1", { typeId: "debate", typeConfig: { agents: ["ta-bull", "ta-bear"], rounds: 2 } })];

      const result = validateGraph(nodes, []);

      const warn = result.warnings.find((w) => w.message.match(/no agent assigned/i));
      expect(warn).toBeUndefined();
    });

    it("no warning when typeConfig.voters is set (vote-type node)", () => {
      const nodes = [makeNode("n1", { typeId: "vote", typeConfig: { voters: ["a", "b"] } })];

      const result = validateGraph(nodes, []);

      const warn = result.warnings.find((w) => w.message.match(/no agent assigned/i));
      expect(warn).toBeUndefined();
    });

    it("returns warning for barrier mode with 0 or 1 dependency", () => {
      const nodes = [
        makeNode("n1", { barrierMode: "all", dependsOn: [] }),
      ];

      const result = validateGraph(nodes, []);

      expect(result.valid).toBe(true);
      const warn = result.warnings.find((w) => w.message.match(/barrier/i));
      expect(warn).toBeDefined();
      expect(warn!.nodeIds).toContain("n1");
    });

    it("returns warning for barrier mode with exactly 1 dependency", () => {
      const nodes = [
        makeNode("n1"),
        makeNode("n2", { barrierMode: "majority", dependsOn: ["n1"] }),
      ];

      const result = validateGraph(nodes, []);

      expect(result.valid).toBe(true);
      const warn = result.warnings.find((w) => w.message.match(/barrier/i));
      expect(warn).toBeDefined();
      expect(warn!.nodeIds).toContain("n2");
    });

    it("returns warning for disconnected node (no edges, graph >1 node)", () => {
      const nodes = [makeNode("n1"), makeNode("n2")];
      const edges = []; // no edges, both nodes disconnected

      const result = validateGraph(nodes, edges);

      expect(result.valid).toBe(true);
      const warns = result.warnings.filter((w) =>
        w.message.match(/disconnected/i),
      );
      expect(warns.length).toBeGreaterThanOrEqual(1);
    });

  });

  // ---------------------------------------------------------------------------
  // Type validation rules
  // ---------------------------------------------------------------------------

  describe("type validation rules", () => {
    it("returns error when node has typeId but no typeConfig", () => {
      const nodes = [makeNode("n1", { typeId: "debate", agentId: "x" })];

      const result = validateGraph(nodes, []);

      expect(result.valid).toBe(false);
      const err = result.errors.find((e) => e.message.match(/typeConfig/));
      expect(err).toBeDefined();
      expect(err!.nodeIds).toContain("n1");
    });

    it("returns error when node has typeConfig but no typeId", () => {
      const nodes = [makeNode("n1", { typeConfig: { agents: [] }, agentId: "x" })];

      const result = validateGraph(nodes, []);

      expect(result.valid).toBe(false);
      const err = result.errors.find((e) => e.message.match(/typeId/));
      expect(err).toBeDefined();
      expect(err!.nodeIds).toContain("n1");
    });

    it("returns warning for retries on multi-agent typed node (debate)", () => {
      const nodes = [makeNode("n1", {
        typeId: "debate",
        typeConfig: { agents: ["a", "b"], rounds: 2 },
        retries: 1,
        agentId: "x",
      })];

      const result = validateGraph(nodes, []);

      expect(result.valid).toBe(true);
      const warn = result.warnings.find((w) => w.message.match(/expensive/i));
      expect(warn).toBeDefined();
      expect(warn!.nodeIds).toContain("n1");
    });

    it("returns warning for retries on approval-gate node", () => {
      const nodes = [makeNode("n1", {
        typeId: "approval-gate",
        typeConfig: { timeout_minutes: 60 },
        retries: 1,
        agentId: "x",
      })];

      const result = validateGraph(nodes, []);

      expect(result.valid).toBe(true);
      const warn = result.warnings.find((w) => w.message.match(/re-prompt/i));
      expect(warn).toBeDefined();
      expect(warn!.nodeIds).toContain("n1");
    });

    it("no warning for retries on agent typed node", () => {
      const nodes = [makeNode("n1", {
        typeId: "agent",
        typeConfig: { agent: "a" },
        retries: 2,
        agentId: "x",
      })];

      const result = validateGraph(nodes, []);

      expect(result.valid).toBe(true);
      const retryWarnings = result.warnings.filter((w) =>
        w.message.match(/retries/i) || w.message.match(/expensive/i) || w.message.match(/re-prompt/i),
      );
      expect(retryWarnings).toHaveLength(0);
    });

    it("valid node with typeId and typeConfig passes", () => {
      const nodes = [makeNode("n1", {
        typeId: "vote",
        typeConfig: { voters: ["a", "b"] },
        agentId: "x",
      })];

      const result = validateGraph(nodes, []);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("valid graph with 2 connected nodes returns valid result", () => {
      const nodes = [
        makeNode("n1"),
        makeNode("n2", { dependsOn: ["n1"], agentId: "agent-1" }),
      ];
      // Give n1 an agent too to avoid no-agent warnings
      nodes[0] = makeNode("n1", { agentId: "agent-1" });
      const edges = [makeEdge("n1", "n2")];

      const result = validateGraph(nodes, edges);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("single node with task returns valid (no disconnected warning)", () => {
      const nodes = [makeNode("n1", { agentId: "agent-1" })];

      const result = validateGraph(nodes, []);

      expect(result.valid).toBe(true);
      expect(result.warnings.filter((w) => w.message.match(/disconnected/i)))
        .toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // nodeIds presence
  // ---------------------------------------------------------------------------

  describe("nodeIds in messages", () => {
    it("every error/warning message with a relevant node includes nodeIds", () => {
      const nodes = [
        makeNode("n1", { task: "", dependsOn: ["n1"] }),
        makeNode("n1"), // duplicate
      ];

      const result = validateGraph(nodes, []);

      for (const msg of [...result.errors, ...result.warnings]) {
        // Messages about specific nodes should have nodeIds
        if (msg.nodeIds) {
          expect(msg.nodeIds.length).toBeGreaterThan(0);
        }
      }
    });
  });
});
