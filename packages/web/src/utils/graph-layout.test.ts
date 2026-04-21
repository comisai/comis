// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { autoLayout, computeFitViewport } from "./graph-layout.js";
import { NODE_WIDTH, NODE_FIXED_HEIGHT } from "./edge-geometry.js";
import { MIN_SCALE, MAX_SCALE } from "./viewport-transform.js";
import type { PipelineNode, PipelineEdge } from "../api/types/index.js";

/** Helper to create a minimal PipelineNode */
function makeNode(id: string, x = 0, y = 0): PipelineNode {
  return {
    id,
    task: `Task ${id}`,
    dependsOn: [],
    position: { x, y },
  };
}

describe("autoLayout", () => {
  it("returns position map with 1 entry for single node", () => {
    const nodes = [makeNode("n1")];
    const result = autoLayout(nodes, []);

    expect(result.positions.size).toBe(1);
    expect(result.positions.has("n1")).toBe(true);
    const pos = result.positions.get("n1")!;
    expect(typeof pos.x).toBe("number");
    expect(typeof pos.y).toBe("number");
  });

  it("positions source above target in TB layout (two connected nodes)", () => {
    const nodes = [makeNode("n1"), makeNode("n2")];
    const edges: PipelineEdge[] = [
      { id: "n1->n2", source: "n1", target: "n2" },
    ];
    const result = autoLayout(nodes, edges);

    const p1 = result.positions.get("n1")!;
    const p2 = result.positions.get("n2")!;
    expect(p1.y).toBeLessThan(p2.y);
  });

  it("returns center-to-topleft corrected positions", () => {
    const nodes = [makeNode("n1")];
    const result = autoLayout(nodes, []);

    // dagre returns center coords; autoLayout subtracts NODE_WIDTH/2 and NODE_FIXED_HEIGHT/2
    // The position should be the top-left corner, not the center
    const pos = result.positions.get("n1")!;
    // For a single node with dagre margins, the center would be at
    // (marginx + NODE_WIDTH/2, marginy + NODE_FIXED_HEIGHT/2)
    // After correction: (marginx, marginy) -- which is the top-left
    // We check that the position is >= 0 (margins applied) and reasonable
    expect(pos.x).toBeGreaterThanOrEqual(0);
    expect(pos.y).toBeGreaterThanOrEqual(0);
  });

  it("returns empty positions map for empty nodes array", () => {
    const result = autoLayout([], []);
    expect(result.positions.size).toBe(0);
  });
});

describe("computeFitViewport", () => {
  it("returns identity viewport for empty nodes", () => {
    const vp = computeFitViewport([], 800, 600);
    expect(vp.x).toBe(0);
    expect(vp.y).toBe(0);
    expect(vp.scale).toBe(1.0);
  });

  it("centers single node at (0,0) in 800x600 container", () => {
    const nodes = [makeNode("n1", 0, 0)];
    const vp = computeFitViewport(nodes, 800, 600);

    // Scale should be clamped to MAX_SCALE at most
    expect(vp.scale).toBeLessThanOrEqual(MAX_SCALE);
    expect(vp.scale).toBeGreaterThanOrEqual(MIN_SCALE);

    // Node should be centered: transform places the node bounding box center
    // at the container center
    // graph center = (NODE_WIDTH/2, NODE_FIXED_HEIGHT/2) = (100, 40)
    // screen center = (400, 300)
    // With scale s: vp.x + graphCenterX * s = 400 and vp.y + graphCenterY * s = 300
    const graphCenterX = NODE_WIDTH / 2;
    const graphCenterY = NODE_FIXED_HEIGHT / 2;
    const screenCenterX = vp.x + graphCenterX * vp.scale;
    const screenCenterY = vp.y + graphCenterY * vp.scale;

    expect(screenCenterX).toBeCloseTo(400, 0);
    expect(screenCenterY).toBeCloseTo(300, 0);
  });

  it("fits multiple nodes within container bounds", () => {
    // Place nodes far apart to test scaling down
    const nodes = [
      makeNode("n1", 0, 0),
      makeNode("n2", 2000, 0),
      makeNode("n3", 0, 2000),
      makeNode("n4", 2000, 2000),
    ];
    const containerW = 800;
    const containerH = 600;
    const padding = 40;

    const vp = computeFitViewport(nodes, containerW, containerH, padding);

    // All nodes should be visible -- check scale is reasonable
    expect(vp.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(vp.scale).toBeLessThanOrEqual(MAX_SCALE);

    // The content width is 2000 + NODE_WIDTH, content height is 2000 + NODE_FIXED_HEIGHT
    // Available space: (800 - 80) x (600 - 80) = 720 x 520
    // Scale should be min(720 / 2200, 520 / 2080) ~ min(0.327, 0.25) = 0.25
    expect(vp.scale).toBeLessThan(1.0); // Must have scaled down
  });

  it("clamps scale to [MIN_SCALE, MAX_SCALE] range", () => {
    // Tiny content in huge container -> would compute huge scale
    const nodes = [makeNode("n1", 0, 0)];
    const vp = computeFitViewport(nodes, 10000, 10000);
    expect(vp.scale).toBeLessThanOrEqual(MAX_SCALE);

    // Huge content in tiny container -> would compute tiny scale
    const farNodes = [
      makeNode("n1", 0, 0),
      makeNode("n2", 100000, 100000),
    ];
    const vp2 = computeFitViewport(farNodes, 100, 100);
    expect(vp2.scale).toBeGreaterThanOrEqual(MIN_SCALE);
  });
});
