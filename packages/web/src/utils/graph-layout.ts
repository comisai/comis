// SPDX-License-Identifier: Apache-2.0
/**
 * Graph layout utilities using dagre for auto-layout and fit-view computation.
 *
 * Wraps the dagre library behind a simple interface for the graph builder.
 * All functions are pure (no DOM access) and independently testable.
 *
 * dagre returns center coordinates for nodes; this module converts them
 * to top-left coordinates to match the graph builder's position convention.
 */

import dagre from "@dagrejs/dagre";
import { NODE_WIDTH, NODE_FIXED_HEIGHT } from "./edge-geometry.js";
import { MIN_SCALE, MAX_SCALE, type ViewportTransform } from "./viewport-transform.js";
import type { PipelineNode, PipelineEdge } from "../api/types/index.js";

/** Result of an auto-layout computation */
export interface LayoutResult {
  /** Map from node ID to top-left position */
  readonly positions: ReadonlyMap<string, { x: number; y: number }>;
}

/**
 * Compute auto-layout positions for all nodes using dagre (top-to-bottom DAG).
 *
 * dagre returns center coordinates; this function converts them to top-left
 * by subtracting NODE_WIDTH/2 and NODE_FIXED_HEIGHT/2.
 *
 * @param nodes - Pipeline nodes to layout
 * @param edges - Pipeline edges defining the DAG structure
 * @returns LayoutResult with top-left positions for each node
 */
export function autoLayout(
  nodes: ReadonlyArray<PipelineNode>,
  edges: ReadonlyArray<PipelineEdge>,
): LayoutResult {
  if (nodes.length === 0) {
    return { positions: new Map() };
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "TB",
    nodesep: 60,
    ranksep: 80,
    marginx: 40,
    marginy: 40,
    ranker: "tight-tree",
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_FIXED_HEIGHT });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();

  for (const node of nodes) {
    const dagreNode = g.node(node.id);
    // dagre returns center coordinates; convert to top-left
    positions.set(node.id, {
      x: dagreNode.x - NODE_WIDTH / 2,
      y: dagreNode.y - NODE_FIXED_HEIGHT / 2,
    });
  }

  return { positions };
}

/**
 * Compute a viewport transform that fits all nodes within the container.
 *
 * Calculates the bounding box of all nodes, determines the scale needed
 * to fit that box within the container (with padding), clamps the scale
 * to [MIN_SCALE, MAX_SCALE], and centers the graph.
 *
 * @param nodes - Pipeline nodes with positions
 * @param containerWidth - Container width in screen pixels
 * @param containerHeight - Container height in screen pixels
 * @param padding - Padding around the graph in screen pixels (default 40)
 * @returns ViewportTransform that fits all nodes in the container
 */
export function computeFitViewport(
  nodes: ReadonlyArray<PipelineNode>,
  containerWidth: number,
  containerHeight: number,
  padding = 40,
): ViewportTransform {
  if (nodes.length === 0) {
    return { x: 0, y: 0, scale: 1.0 };
  }

  // Compute bounding box of all nodes (top-left positions + dimensions)
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    const left = node.position.x;
    const top = node.position.y;
    const right = left + NODE_WIDTH;
    const bottom = top + NODE_FIXED_HEIGHT;

    if (left < minX) minX = left;
    if (top < minY) minY = top;
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
  }

  const contentWidth = maxX - minX;
  const contentHeight = maxY - minY;

  // Available space after padding
  const availableWidth = containerWidth - padding * 2;
  const availableHeight = containerHeight - padding * 2;

  // Scale to fit
  const scaleX = availableWidth / contentWidth;
  const scaleY = availableHeight / contentHeight;
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(scaleX, scaleY)));

  // Center the graph: place the content center at the container center
  const contentCenterX = (minX + maxX) / 2;
  const contentCenterY = (minY + maxY) / 2;
  const containerCenterX = containerWidth / 2;
  const containerCenterY = containerHeight / 2;

  return {
    x: containerCenterX - contentCenterX * scale,
    y: containerCenterY - contentCenterY * scale,
    scale,
  };
}
