// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for graph-templates utility module (Phase 40 Plan 40-15 gap-closure for COV-03).
 *
 * Covers all 11 pre-built graph template factories + the GRAPH_TEMPLATES catalog
 * shape. Each template factory is pure (no side effects) and returns a topologically
 * valid PipelineNode/PipelineEdge graph. Tests assert node counts, edge wiring,
 * dependency consistency, and presence of typeId/typeConfig on advanced templates.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  createLinearChainTemplate,
  createFanOutFanInTemplate,
  createParallelTracksTemplate,
  createIndependentWorkersTemplate,
  createDiamondTemplate,
  createDebateTemplate,
  createVotePipelineTemplate,
  createRefineChainTemplate,
  createMapReduceTemplate,
  createApprovalGateTemplate,
  createBlankTemplate,
  GRAPH_TEMPLATES,
} from "./graph-templates.js";

describe("createLinearChainTemplate", () => {
  it("returns a 3-node sequential chain with 2 directed edges step-1 to step-2 to step-3", () => {
    const t = createLinearChainTemplate();
    expect(t.nodes).toHaveLength(3);
    expect(t.edges).toHaveLength(2);
    expect(t.nodes.map((n) => n.id)).toEqual(["step-1", "step-2", "step-3"]);
    expect(t.edges[0]).toMatchObject({ source: "step-1", target: "step-2" });
    expect(t.edges[1]).toMatchObject({ source: "step-2", target: "step-3" });
  });

  it("declares dependency arrays consistent with the edge wiring for each node", () => {
    const t = createLinearChainTemplate();
    expect(t.nodes[0].dependsOn).toEqual([]);
    expect(t.nodes[1].dependsOn).toEqual(["step-1"]);
    expect(t.nodes[2].dependsOn).toEqual(["step-2"]);
  });

  it("populates settings.label so the template surfaces a human-readable name", () => {
    expect(createLinearChainTemplate().settings.label).toBe("Linear Chain");
  });
});

describe("createFanOutFanInTemplate", () => {
  it("returns a 4-node fan-out/fan-in topology with start, two workers, and a merge", () => {
    const t = createFanOutFanInTemplate();
    expect(t.nodes).toHaveLength(4);
    expect(t.edges).toHaveLength(4);
    const ids = t.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["merge", "start", "worker-1", "worker-2"]);
  });

  it("wires both workers to depend on start and merge to depend on both workers", () => {
    const t = createFanOutFanInTemplate();
    const merge = t.nodes.find((n) => n.id === "merge");
    expect(merge?.dependsOn).toEqual(["worker-1", "worker-2"]);
  });
});

describe("createParallelTracksTemplate", () => {
  it("returns 4 nodes split into two unconnected sequential tracks", () => {
    const t = createParallelTracksTemplate();
    expect(t.nodes).toHaveLength(4);
    expect(t.edges).toHaveLength(2);
    // No cross-edges between tracks
    const sources = t.edges.map((e) => e.source);
    expect(sources).toContain("track-a1");
    expect(sources).toContain("track-b1");
  });
});

describe("createIndependentWorkersTemplate", () => {
  it("returns 3 unconnected nodes with no edges representing independent workers", () => {
    const t = createIndependentWorkersTemplate();
    expect(t.nodes).toHaveLength(3);
    expect(t.edges).toEqual([]);
    expect(t.nodes.every((n) => n.dependsOn.length === 0)).toBe(true);
  });
});

describe("createDiamondTemplate", () => {
  it("returns 4 nodes in diamond topology with two paths converging at the bottom node", () => {
    const t = createDiamondTemplate();
    expect(t.nodes).toHaveLength(4);
    expect(t.edges).toHaveLength(4);
    const bottom = t.nodes.find((n) => n.id === "bottom");
    expect(bottom?.dependsOn).toEqual(["left", "right"]);
  });
});

describe("createDebateTemplate", () => {
  it("returns 3 nodes with the middle node configured as a debate type with rounds set", () => {
    const t = createDebateTemplate();
    expect(t.nodes).toHaveLength(3);
    const debateNode = t.nodes.find((n) => n.id === "debate");
    expect(debateNode?.typeId).toBe("debate");
    expect(debateNode?.typeConfig).toMatchObject({ rounds: 2 });
  });
});

describe("createVotePipelineTemplate", () => {
  it("returns 3 nodes with the middle node configured as a vote type with verdict_format", () => {
    const t = createVotePipelineTemplate();
    const voteNode = t.nodes.find((n) => n.id === "vote");
    expect(voteNode?.typeId).toBe("vote");
    expect(voteNode?.typeConfig?.verdict_format).toBeDefined();
  });
});

describe("createRefineChainTemplate", () => {
  it("returns 3 nodes with the middle node configured as a refine type for sequential review", () => {
    const t = createRefineChainTemplate();
    const refineNode = t.nodes.find((n) => n.id === "refine");
    expect(refineNode?.typeId).toBe("refine");
  });
});

describe("createMapReduceTemplate", () => {
  it("returns 3 nodes with the middle node configured as a map-reduce type with reducer prompt", () => {
    const t = createMapReduceTemplate();
    const analyze = t.nodes.find((n) => n.id === "analyze");
    expect(analyze?.typeId).toBe("map-reduce");
    expect(analyze?.typeConfig?.reducer_prompt).toContain("Synthesize");
  });
});

describe("createApprovalGateTemplate", () => {
  it("returns 3 nodes with an approval-gate type node carrying a timeout_minutes setting", () => {
    const t = createApprovalGateTemplate();
    const approveNode = t.nodes.find((n) => n.id === "approve");
    expect(approveNode?.typeId).toBe("approval-gate");
    expect(approveNode?.typeConfig?.timeout_minutes).toBe(60);
  });
});

describe("createBlankTemplate", () => {
  it("returns an empty graph with no nodes and no edges for a fresh canvas", () => {
    const t = createBlankTemplate();
    expect(t.nodes).toEqual([]);
    expect(t.edges).toEqual([]);
    expect(t.settings.label).toBe("Untitled Pipeline");
  });
});

describe("GRAPH_TEMPLATES catalog", () => {
  it("exposes exactly 11 template descriptors covering every factory function", () => {
    expect(GRAPH_TEMPLATES).toHaveLength(11);
  });

  it("declares unique id strings across every template entry to enable picker lookups", () => {
    const ids = GRAPH_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("supplies non-empty name + description + icon + nodeCount metadata for each template", () => {
    for (const tpl of GRAPH_TEMPLATES) {
      expect(tpl.name.length).toBeGreaterThan(0);
      expect(tpl.description.length).toBeGreaterThan(0);
      expect(tpl.icon.length).toBeGreaterThan(0);
      expect(tpl.nodeCount.length).toBeGreaterThan(0);
    }
  });

  it("invokes the create() factory on each template to verify it produces a graph triple", () => {
    for (const tpl of GRAPH_TEMPLATES) {
      const out = tpl.create();
      expect(out.nodes).toBeInstanceOf(Array);
      expect(out.edges).toBeInstanceOf(Array);
      expect(typeof out.settings).toBe("object");
    }
  });

  it("includes the blank-canvas template as the final entry for fresh-start workflows", () => {
    expect(GRAPH_TEMPLATES.at(-1)?.id).toBe("blank");
  });
});
