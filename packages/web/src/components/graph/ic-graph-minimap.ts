/**
 * Scaled minimap with draggable viewport rectangle for the graph canvas.
 *
 * Renders a small 160x120 overview of the graph showing colored node
 * rectangles and a viewport indicator that can be dragged to pan the
 * main canvas.
 *
 * Provides minimap with draggable viewport drag support.
 *
 * Events dispatched (all CustomEvent, bubbles: true, composed: true):
 * - viewport-change: ViewportTransform -- when viewport rectangle is dragged
 */

import { LitElement, html, css, svg, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";
import { NODE_WIDTH, NODE_FIXED_HEIGHT } from "../../utils/edge-geometry.js";
import type { ViewportTransform } from "../../utils/viewport-transform.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MINIMAP_WIDTH = 160;
const MINIMAP_HEIGHT = 120;
const PADDING = 8;
const MIN_NODE_W = 4;
const MIN_NODE_H = 3;

// ---------------------------------------------------------------------------
// Status colors (matches canvas)
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  pending: "#6b7280",
  ready: "#a78bfa",
  running: "#06b6d4",
  completed: "#22c55e",
  failed: "#ef4444",
  skipped: "#9ca3af",
};

// ---------------------------------------------------------------------------
// Node shape for minimap (minimal interface)
// ---------------------------------------------------------------------------

interface MinimapNode {
  readonly id: string;
  readonly position: { x: number; y: number };
  readonly status?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("ic-graph-minimap")
export class IcGraphMinimap extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        width: ${MINIMAP_WIDTH}px;
        height: ${MINIMAP_HEIGHT}px;
        background: var(--ic-surface, #181825);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md, 8px);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        overflow: hidden;
        user-select: none;
        touch-action: none;
      }

      svg {
        display: block;
        width: 100%;
        height: 100%;
      }

      .viewport-rect {
        fill: none;
        stroke: var(--ic-accent, #3b82f6);
        stroke-opacity: 0.4;
        stroke-width: 1.5;
        cursor: grab;
      }

      .viewport-rect.dragging {
        cursor: grabbing;
        stroke-opacity: 0.7;
      }

      .viewport-fill {
        fill: var(--ic-accent, #3b82f6);
        fill-opacity: 0.05;
      }
    `,
  ];

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  @property({ attribute: false }) nodes: ReadonlyArray<MinimapNode> = [];
  @property({ attribute: false }) viewport: ViewportTransform = { x: 0, y: 0, scale: 1 };
  @property({ type: Number }) containerWidth = 800;
  @property({ type: Number }) containerHeight = 600;

  @state() private _dragging = false;
  private _dragStartMinimapX = 0;
  private _dragStartMinimapY = 0;
  private _dragStartVpX = 0;
  private _dragStartVpY = 0;

  // ---------------------------------------------------------------------------
  // Bounding box + scale computation
  // ---------------------------------------------------------------------------

  private _computeBounds(): { minX: number; minY: number; maxX: number; maxY: number; graphW: number; graphH: number } {
    if (!this.nodes.length) {
      return { minX: 0, minY: 0, maxX: 400, maxY: 300, graphW: 400, graphH: 300 };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + NODE_WIDTH);
      maxY = Math.max(maxY, n.position.y + NODE_FIXED_HEIGHT);
    }
    // Add padding in graph space
    const padGraph = 40;
    minX -= padGraph;
    minY -= padGraph;
    maxX += padGraph;
    maxY += padGraph;
    return { minX, minY, maxX, maxY, graphW: maxX - minX, graphH: maxY - minY };
  }

  private _computeScale(graphW: number, graphH: number): number {
    const availW = MINIMAP_WIDTH - PADDING * 2;
    const availH = MINIMAP_HEIGHT - PADDING * 2;
    return Math.min(availW / graphW, availH / graphH, 1);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  override render() {
    const bounds = this._computeBounds();
    const mmScale = this._computeScale(bounds.graphW, bounds.graphH);

    // Center offset
    const drawW = bounds.graphW * mmScale;
    const drawH = bounds.graphH * mmScale;
    const offsetX = (MINIMAP_WIDTH - drawW) / 2;
    const offsetY = (MINIMAP_HEIGHT - drawH) / 2;

    // Node rectangles
    const nodeRects = this.nodes.map((n) => {
      const x = offsetX + (n.position.x - bounds.minX) * mmScale;
      const y = offsetY + (n.position.y - bounds.minY) * mmScale;
      const w = Math.max(NODE_WIDTH * mmScale, MIN_NODE_W);
      const h = Math.max(NODE_FIXED_HEIGHT * mmScale, MIN_NODE_H);
      const color = STATUS_COLORS[n.status ?? "pending"] ?? STATUS_COLORS.pending;
      return svg`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" rx="1" />`;
    });

    // Viewport rectangle
    // The viewport transform maps graph coords to screen: screenX = graphX * scale + vt.x
    // So the visible graph area is:
    // graphX_left = (0 - vt.x) / vt.scale = -vt.x / vt.scale
    // graphY_top = -vt.y / vt.scale
    // graphX_right = (containerWidth - vt.x) / vt.scale
    // graphY_bottom = (containerHeight - vt.y) / vt.scale
    const vt = this.viewport;
    const vpGraphLeft = -vt.x / vt.scale;
    const vpGraphTop = -vt.y / vt.scale;
    const vpGraphW = this.containerWidth / vt.scale;
    const vpGraphH = this.containerHeight / vt.scale;

    const vpX = offsetX + (vpGraphLeft - bounds.minX) * mmScale;
    const vpY = offsetY + (vpGraphTop - bounds.minY) * mmScale;
    const vpW = vpGraphW * mmScale;
    const vpH = vpGraphH * mmScale;

    // Hide viewport rect if it covers nearly everything (>95%)
    const showVp = vpW < MINIMAP_WIDTH * 0.95 || vpH < MINIMAP_HEIGHT * 0.95;

    return html`
      <svg
        viewBox="0 0 ${MINIMAP_WIDTH} ${MINIMAP_HEIGHT}"
        @pointerdown=${this._onPointerDown}
        @pointermove=${this._onPointerMove}
        @pointerup=${this._onPointerUp}
        @pointercancel=${this._onPointerUp}
      >
        <!-- Node dots -->
        ${nodeRects}

        <!-- Viewport rectangle -->
        ${showVp
          ? svg`
            <rect class="viewport-fill" x="${vpX}" y="${vpY}" width="${vpW}" height="${vpH}" />
            <rect
              class="viewport-rect ${this._dragging ? "dragging" : ""}"
              x="${vpX}" y="${vpY}" width="${vpW}" height="${vpH}"
            />
          `
          : nothing}
      </svg>
    `;
  }

  // ---------------------------------------------------------------------------
  // Pointer drag handling
  // ---------------------------------------------------------------------------

  private _onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);

    this._dragging = true;

    // Get minimap coordinates from pointer
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    this._dragStartMinimapX = ((e.clientX - rect.left) / rect.width) * MINIMAP_WIDTH;
    this._dragStartMinimapY = ((e.clientY - rect.top) / rect.height) * MINIMAP_HEIGHT;
    this._dragStartVpX = this.viewport.x;
    this._dragStartVpY = this.viewport.y;
  };

  private _onPointerMove = (e: PointerEvent): void => {
    if (!this._dragging) return;
    e.preventDefault();

    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const currentMinimapX = ((e.clientX - rect.left) / rect.width) * MINIMAP_WIDTH;
    const currentMinimapY = ((e.clientY - rect.top) / rect.height) * MINIMAP_HEIGHT;

    // Delta in minimap space
    const deltaMinimapX = currentMinimapX - this._dragStartMinimapX;
    const deltaMinimapY = currentMinimapY - this._dragStartMinimapY;

    // Convert minimap delta to graph delta
    const bounds = this._computeBounds();
    const mmScale = this._computeScale(bounds.graphW, bounds.graphH);
    const deltaGraphX = deltaMinimapX / mmScale;
    const deltaGraphY = deltaMinimapY / mmScale;

    // Moving the viewport rect right means panning the canvas left (vt.x decreases)
    const newVpX = this._dragStartVpX - deltaGraphX * this.viewport.scale;
    const newVpY = this._dragStartVpY - deltaGraphY * this.viewport.scale;

    this.dispatchEvent(
      new CustomEvent("viewport-change", {
        bubbles: true,
        composed: true,
        detail: { x: newVpX, y: newVpY, scale: this.viewport.scale },
      }),
    );
  };

  private _onPointerUp = (e: PointerEvent): void => {
    if (!this._dragging) return;
    this._dragging = false;
    (e.currentTarget as SVGSVGElement).releasePointerCapture(e.pointerId);
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-graph-minimap": IcGraphMinimap;
  }
}
