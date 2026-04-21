// SPDX-License-Identifier: Apache-2.0
/**
 * Viewport coordinate conversion utilities for the graph builder canvas.
 *
 * Provides pure functions to convert between screen space (browser pointer events)
 * and graph space (logical node positions), plus zoom-at-cursor computation.
 *
 * These are the foundational math primitives for all canvas interaction:
 * pan, zoom, node placement, drag, and edge connections.
 */

/** Immutable viewport transform state: pan offset + zoom scale */
export interface ViewportTransform {
  readonly x: number;     // pan offset X (screen pixels)
  readonly y: number;     // pan offset Y (screen pixels)
  readonly scale: number; // zoom factor
}

/** Minimum zoom scale (25%) */
export const MIN_SCALE = 0.25;

/** Maximum zoom scale (200%) */
export const MAX_SCALE = 2.0;

/** Default viewport: no pan, no zoom */
export const DEFAULT_VIEWPORT: ViewportTransform = { x: 0, y: 0, scale: 1.0 };

/**
 * Convert screen coordinates (e.g. from pointer events) to graph space.
 *
 * @param screenX - clientX from pointer event
 * @param screenY - clientY from pointer event
 * @param canvasRect - getBoundingClientRect() of the canvas container
 * @param vt - current viewport transform
 * @returns Point in graph coordinate space
 */
export function screenToGraph(
  screenX: number,
  screenY: number,
  canvasRect: DOMRect,
  vt: ViewportTransform,
): { x: number; y: number } {
  return {
    x: (screenX - canvasRect.left - vt.x) / vt.scale,
    y: (screenY - canvasRect.top - vt.y) / vt.scale,
  };
}

/**
 * Convert graph coordinates to screen coordinates.
 *
 * Inverse of screenToGraph: graphToScreen(screenToGraph(sx, sy, r, vt), r, vt) === (sx, sy).
 *
 * @param graphX - X position in graph space
 * @param graphY - Y position in graph space
 * @param canvasRect - getBoundingClientRect() of the canvas container
 * @param vt - current viewport transform
 * @returns Point in screen coordinate space
 */
export function graphToScreen(
  graphX: number,
  graphY: number,
  canvasRect: DOMRect,
  vt: ViewportTransform,
): { x: number; y: number } {
  return {
    x: graphX * vt.scale + vt.x + canvasRect.left,
    y: graphY * vt.scale + vt.y + canvasRect.top,
  };
}

/**
 * Compute a new viewport transform that zooms toward (or away from) a cursor point.
 *
 * The cursor point remains fixed in graph space after the zoom, preventing
 * the "drift away from cursor" problem common in naive zoom implementations.
 *
 * @param vt - current viewport transform
 * @param cursorX - cursor X in screen pixels (relative to canvas container, NOT clientX)
 * @param cursorY - cursor Y in screen pixels (relative to canvas container, NOT clientX)
 * @param delta - wheel delta: positive = zoom out, negative = zoom in
 * @param minScale - minimum allowed scale
 * @param maxScale - maximum allowed scale
 * @returns New viewport transform with adjusted scale and pan
 */
export function zoomAtPoint(
  vt: ViewportTransform,
  cursorX: number,
  cursorY: number,
  delta: number,
  minScale: number,
  maxScale: number,
): ViewportTransform {
  const factor = delta > 0 ? 0.9 : 1.1;
  const newScale = Math.max(minScale, Math.min(maxScale, vt.scale * factor));

  return {
    x: cursorX - (cursorX - vt.x) * (newScale / vt.scale),
    y: cursorY - (cursorY - vt.y) * (newScale / vt.scale),
    scale: newScale,
  };
}
