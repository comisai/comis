// SPDX-License-Identifier: Apache-2.0
/**
 * Edge geometry pure functions for the graph builder canvas.
 *
 * Provides Bezier path computation, arrowhead triangles, midpoint calculation,
 * and port position derivation from node positions. All functions are pure
 * (no DOM access) and independently testable.
 *
 * Used by ic-graph-canvas to render SVG edge paths between node cards.
 */

/** 2D point in graph coordinate space */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Node card width in graph-space pixels */
export const NODE_WIDTH = 200;

/**
 * Fixed node card height.
 *
 * Ensures port positions (derived mathematically) match the visual port
 * positions on the rendered card. Variable height can be added in a polish
 * phase by reading actual DOM heights.
 */
export const NODE_FIXED_HEIGHT = 80;

/**
 * Get the output port position (bottom-center of node card).
 *
 * @param node - Object with position {x, y} representing the top-left of the card
 * @returns Point at bottom-center of the node card
 */
export function getOutputPortPosition(node: { position: { x: number; y: number } }): Point {
  return {
    x: node.position.x + NODE_WIDTH / 2,
    y: node.position.y + NODE_FIXED_HEIGHT,
  };
}

/**
 * Get the input port position (top-center of node card).
 *
 * @param node - Object with position {x, y} representing the top-left of the card
 * @returns Point at top-center of the node card
 */
export function getInputPortPosition(node: { position: { x: number; y: number } }): Point {
  return {
    x: node.position.x + NODE_WIDTH / 2,
    y: node.position.y,
  };
}

/**
 * Compute SVG cubic Bezier path from source output port to target input port.
 *
 * Control points create a smooth vertical S-curve. The offset scales with
 * vertical distance to avoid loops on short edges and flat curves on long ones.
 *
 * @param source - Source output port position
 * @param target - Target input port position
 * @returns SVG path string (M ... C ...)
 */
export function computeBezierPath(source: Point, target: Point): string {
  const dy = Math.abs(target.y - source.y);
  const cpOffset = Math.max(30, Math.min(dy * 0.5, 150));

  return [
    `M ${source.x} ${source.y}`,
    `C ${source.x} ${source.y + cpOffset},`,
    `${target.x} ${target.y - cpOffset},`,
    `${target.x} ${target.y}`,
  ].join(" ");
}

/**
 * Compute arrowhead triangle path at the target port.
 *
 * Uses the tangent angle of the Bezier curve at its endpoint (from the
 * second control point to the target) to align the arrowhead with the curve.
 *
 * CRITICAL: Uses the same cpOffset formula as computeBezierPath to derive
 * the second control point position. This ensures arrowhead alignment.
 *
 * @param target - Target port position (arrowhead tip)
 * @param source - Source port position (used to compute Bezier control points)
 * @param size - Arrowhead triangle size in pixels (default 8)
 * @returns SVG path string for a closed triangle (M ... L ... L ... Z)
 */
export function computeArrowhead(
  target: Point,
  source: Point,
  size = 8,
): string {
  // Derive the second control point using the same formula as computeBezierPath
  const dy = Math.abs(target.y - source.y);
  const cpOffset = Math.max(30, Math.min(dy * 0.5, 150));
  const cpX = target.x;
  const cpY = target.y - cpOffset;

  // Angle from second control point to target (tangent at t=1)
  const angle = Math.atan2(target.y - cpY, target.x - cpX);

  const x1 = target.x - size * Math.cos(angle - Math.PI / 6);
  const y1 = target.y - size * Math.sin(angle - Math.PI / 6);
  const x2 = target.x - size * Math.cos(angle + Math.PI / 6);
  const y2 = target.y - size * Math.sin(angle + Math.PI / 6);

  return `M ${x1} ${y1} L ${target.x} ${target.y} L ${x2} ${y2} Z`;
}

/**
 * Compute the midpoint of a cubic Bezier curve at t=0.5.
 *
 * Uses the same control points as computeBezierPath. The midpoint is
 * used for positioning edge labels.
 *
 * @param source - Source port position
 * @param target - Target port position
 * @returns Point at the Bezier midpoint
 */
export function computeBezierMidpoint(source: Point, target: Point): Point {
  const dy = Math.abs(target.y - source.y);
  const cpOffset = Math.max(30, Math.min(dy * 0.5, 150));

  const cp1 = { x: source.x, y: source.y + cpOffset };
  const cp2 = { x: target.x, y: target.y - cpOffset };

  // Cubic Bezier at t=0.5:
  // B(t) = (1-t)^3 * P0 + 3*(1-t)^2*t * P1 + 3*(1-t)*t^2 * P2 + t^3 * P3
  const t = 0.5;
  const mt = 1 - t;

  return {
    x: mt * mt * mt * source.x + 3 * mt * mt * t * cp1.x + 3 * mt * t * t * cp2.x + t * t * t * target.x,
    y: mt * mt * mt * source.y + 3 * mt * mt * t * cp1.y + 3 * mt * t * t * cp2.y + t * t * t * target.y,
  };
}
