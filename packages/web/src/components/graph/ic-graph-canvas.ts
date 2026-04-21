// SPDX-License-Identifier: Apache-2.0
/**
 * Dual-layer SVG+HTML canvas for the graph builder.
 *
 * Architecture:
 * - SVG layer: dot-grid background, Bezier edges with arrowheads and labels
 * - HTML layer: node cards with ports, status, agent tag, task preview
 * - Both layers share the same CSS transform (pan + zoom)
 *
 * Interaction state machine: idle | panning | dragging-node | connecting-edge
 * All four modes are fully active. Node drag and edge connection use direct
 * DOM manipulation at 60fps, committing final state on pointerup.
 *
 * Performance: pointer move and wheel handlers use direct DOM manipulation
 * (bypass Lit reactivity) at 60fps, committing final state on pointerup/wheel.
 */

import { LitElement, html, svg, css, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { sharedStyles } from "../../styles/shared.js";
import {
  type ViewportTransform,
  MIN_SCALE,
  MAX_SCALE,
  zoomAtPoint,
  screenToGraph,
} from "../../utils/viewport-transform.js";
import type { PipelineNode, PipelineEdge } from "../../api/types/index.js";
import {
  getOutputPortPosition,
  getInputPortPosition,
  computeBezierPath,
  computeArrowhead,
  NODE_WIDTH,
  NODE_FIXED_HEIGHT,
} from "../../utils/edge-geometry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Canvas interaction modes -- all four active. */
export type InteractionMode =
  | "idle"
  | "panning"
  | "dragging-node"
  | "connecting-edge";

const NODE_TYPE_COLORS: Record<string, { label: string; color: string }> = {
  agent:           { label: "Agent",         color: "var(--ic-accent)" },
  debate:          { label: "Debate",        color: "var(--ic-warning)" },
  vote:            { label: "Vote",          color: "var(--ic-success)" },
  refine:          { label: "Refine",        color: "var(--ic-info)" },
  collaborate:     { label: "Collaborate",   color: "#a855f7" },
  "approval-gate": { label: "Approval Gate", color: "var(--ic-error)" },
  "map-reduce":    { label: "Map-Reduce",    color: "#f97316" },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("ic-graph-canvas")
export class IcGraphCanvas extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        width: 100%;
        height: 100%;
      }

      .canvas-container {
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
        cursor: grab;
        user-select: none;
        touch-action: none;
        background: var(--ic-bg);
      }

      .canvas-container[data-mode="panning"] {
        cursor: grabbing;
      }
      .canvas-container[data-mode="dragging-node"] {
        cursor: grabbing;
      }
      .canvas-container[data-mode="connecting-edge"] {
        cursor: crosshair;
      }

      .svg-layer {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }

      .html-layer {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }

      .grid-dot {
        fill: var(--ic-surface-2, #1f2937);
      }

      .zoom-indicator {
        position: absolute;
        bottom: 12px;
        right: 12px;
        padding: 4px 8px;
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-sm);
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
        pointer-events: none;
        font-variant-numeric: tabular-nums;
      }

      /* Node card styles */
      .node-card {
        position: absolute;
        width: ${NODE_WIDTH}px;
        height: ${NODE_FIXED_HEIGHT}px;
        overflow: hidden;
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm);
        pointer-events: auto;
        cursor: default;
        transition: border-color var(--ic-transition), box-shadow var(--ic-transition);
      }
      .node-card:hover {
        background: var(--ic-surface-2);
        box-shadow: var(--ic-shadow-md);
      }
      .node-card--selected {
        border: 2px solid var(--ic-accent);
      }

      .node-header {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
        margin-bottom: 4px;
      }
      .node-id {
        font-family: var(--ic-font-mono);
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text);
      }
      .node-status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--ic-text-dim);
        margin-right: var(--ic-space-xs);
        flex-shrink: 0;
      }
      .node-agent-tag {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 9999px;
        font-size: var(--ic-text-xs);
        background: color-mix(in srgb, var(--ic-accent) 10%, transparent);
        color: var(--ic-accent);
      }
      .node-type-tag {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 9999px;
        font-size: var(--ic-text-xs);
        white-space: nowrap;
        margin-left: 4px;
      }
      .node-task-preview {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .node-constraints {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      /* Port styles */
      .port {
        position: absolute;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        border: 1.5px solid var(--ic-text-dim);
        background: var(--ic-surface);
        left: 50%;
        transform: translateX(-50%);
        pointer-events: auto;
        cursor: crosshair;
      }
      .port:hover {
        width: 12px;
        height: 12px;
        border-color: var(--ic-accent);
        background: var(--ic-accent);
      }
      .port-in {
        top: -4px;
      }
      .port-out {
        bottom: -4px;
      }

      /* Edge styles (SVG) */
      .edge-hit-area {
        fill: none;
        stroke: transparent;
        stroke-width: 12;
        pointer-events: stroke;
        cursor: pointer;
      }
      .edge-path {
        fill: none;
        stroke: var(--ic-text-dim);
        stroke-width: 1.5;
        pointer-events: none;
      }
      .edge-path--selected {
        stroke: var(--ic-accent);
        stroke-width: 2;
      }
      .edge-arrow {
        fill: var(--ic-text-dim);
        stroke: none;
        pointer-events: none;
      }
      .edge-arrow--selected {
        fill: var(--ic-accent);
      }
      /* Edge preview line for connecting-edge mode */
      .edge-preview {
        fill: none;
        stroke: var(--ic-accent);
        stroke-width: 2;
        stroke-dasharray: 6 4;
        pointer-events: none;
        opacity: 0.7;
      }

      /* Validation highlight pulse for click-to-highlight */
      .node-card.highlight {
        box-shadow: 0 0 0 3px var(--ic-error);
        animation: highlight-pulse 0.6s ease-in-out 3;
      }
      @keyframes highlight-pulse {
        0%, 100% { box-shadow: 0 0 0 3px var(--ic-error); }
        50% { box-shadow: 0 0 0 6px rgba(239, 68, 68, 0.3); }
      }

      /* Focus-visible outlines for keyboard navigation */
      .node-card:focus-visible {
        outline: 2px solid var(--ic-accent);
        outline-offset: 2px;
      }

      /* A11Y-05: Disable animations for users who prefer reduced motion */
      @media (prefers-reduced-motion: reduce) {
        .node-card {
          transition: none;
        }
        .node-card.highlight {
          animation: none;
        }
        .edge-preview {
          stroke-dasharray: none;
        }
      }

      /* ---------------------------------------------------------------
       * Monitor mode: read-only canvas styling
       * --------------------------------------------------------------- */

      /* Hide ports and change cursor in read-only mode */
      :host([read-only]) .port { display: none; }
      :host([read-only]) .node-card { cursor: default; }
      :host([read-only]) .canvas-container { cursor: default; }
      :host([read-only]) .canvas-container[data-mode="panning"] { cursor: grabbing; }

      /* Status-colored node borders */
      .node-card[data-status="running"] {
        border: 2px solid var(--ic-info, #06b6d4);
        box-shadow: 0 0 8px rgba(6, 182, 212, 0.3);
      }
      .node-card[data-status="completed"] {
        border: 2px solid var(--ic-success, #22c55e);
      }
      .node-card[data-status="failed"] {
        border: 2px solid var(--ic-error, #ef4444);
      }
      .node-card[data-status="skipped"] {
        border: 2px dashed var(--ic-text-dim, #6b7280);
        opacity: 0.6;
      }
      .node-card[data-status="pending"],
      .node-card[data-status="ready"] {
        border: 1px solid var(--ic-border);
      }

      /* Status dot coloring in node cards */
      .node-card[data-status="running"] .node-status-dot { background: var(--ic-info, #06b6d4); }
      .node-card[data-status="completed"] .node-status-dot { background: var(--ic-success, #22c55e); }
      .node-card[data-status="failed"] .node-status-dot { background: var(--ic-error, #ef4444); }
      .node-card[data-status="skipped"] .node-status-dot { background: var(--ic-text-dim, #6b7280); }

      /* Status-colored edge strokes */
      .edge-path--running {
        stroke: var(--ic-info, #06b6d4);
        stroke-width: 2;
        stroke-dasharray: 8 4;
        animation: edge-flow 1s linear infinite;
      }
      @keyframes edge-flow {
        to { stroke-dashoffset: -12; }
      }
      .edge-path--completed {
        stroke: var(--ic-success, #22c55e);
        stroke-width: 1.5;
      }
      .edge-path--failed {
        stroke: var(--ic-error, #ef4444);
        stroke-width: 1.5;
      }
      .edge-path--skipped {
        stroke: var(--ic-text-dim, #6b7280);
        stroke-dasharray: 4 4;
        opacity: 0.5;
      }

      /* Arrow colors for status */
      .edge-arrow--running { fill: var(--ic-info, #06b6d4); }
      .edge-arrow--completed { fill: var(--ic-success, #22c55e); }
      .edge-arrow--failed { fill: var(--ic-error, #ef4444); }
      .edge-arrow--skipped { fill: var(--ic-text-dim, #6b7280); opacity: 0.5; }

      /* Respect prefers-reduced-motion for edge flow animation */
      @media (prefers-reduced-motion: reduce) {
        .edge-path--running { animation: none; }
      }
    `,
  ];

  // -- Properties -----------------------------------------------------------

  /** Current viewport transform (set by parent via state). */
  @property({ attribute: false })
  viewport: ViewportTransform = { x: 0, y: 0, scale: 1.0 };

  /** Current interaction mode -- reflects as attribute for CSS. */
  @property({ reflect: true })
  interactionMode: InteractionMode = "idle";

  /** Pipeline nodes to render on the HTML layer. */
  @property({ attribute: false })
  nodes: ReadonlyArray<PipelineNode> = [];

  /** Pipeline edges to render on the SVG layer. */
  @property({ attribute: false })
  edges: ReadonlyArray<PipelineEdge> = [];

  /** Currently selected node IDs. */
  @property({ attribute: false })
  selectedNodeIds: ReadonlySet<string> = new Set();

  /** Currently selected edge ID. */
  @property({ attribute: false })
  selectedEdgeId: string | null = null;

  /** Snap node positions to 24px grid during drag. */
  @property({ type: Boolean, attribute: "snap-to-grid" })
  snapToGrid = false;

  /** Node IDs to highlight with a pulse animation (from validation click-to-highlight). */
  @property({ type: Array })
  highlightNodeIds: string[] = [];

  /** When true, disables editing (drag, connect, edit) while preserving pan/zoom. */
  @property({ type: Boolean, reflect: true, attribute: "read-only" })
  readOnly = false;

  /** Map of nodeId -> status for monitor-mode status coloring. */
  @property({ attribute: false })
  nodeStatuses: ReadonlyMap<string, string> = new Map();

  /** Map of edgeId -> status for monitor-mode edge coloring. */
  @property({ attribute: false })
  edgeStatuses: ReadonlyMap<string, string> = new Map();

  // -- Non-reactive fields --------------------------------------------------

  private _mode: InteractionMode = "idle";

  // Pan state
  private _dragStartX = 0;
  private _dragStartY = 0;
  private _startPanX = 0;
  private _startPanY = 0;
  private _livePanX = 0;
  private _livePanY = 0;
  private _currentScale = 1.0;

  // Node drag state
  private _dragNodeId: string | null = null;
  private _dragStartGraphX = 0;
  private _dragStartGraphY = 0;
  private _dragNodeStartX = 0;
  private _dragNodeStartY = 0;
  private _dragLiveX = 0;
  private _dragLiveY = 0;
  private _dragSelectedStarts: Map<string, { x: number; y: number }> = new Map();

  // Edge connection state
  private _connectSourceNodeId: string | null = null;
  private _previewLine: SVGPathElement | null = null;

  // Cached DOM references (set in firstUpdated)
  private _svgTransformGroup: SVGGElement | null = null;
  private _htmlTransformGroup: HTMLDivElement | null = null;
  private _zoomIndicator: HTMLElement | null = null;
  private _container: HTMLDivElement | null = null;

  // Wheel handler reference for cleanup
  private _wheelHandler: ((e: WheelEvent) => void) | null = null;

  // -- Lifecycle ------------------------------------------------------------

  override connectedCallback(): void {
    super.connectedCallback();

    // Register wheel with { passive: false } so preventDefault() works
    this.updateComplete.then(() => {
      const container = this.renderRoot.querySelector(".canvas-container");
      this._wheelHandler = this._onWheel.bind(this);
      container?.addEventListener("wheel", this._wheelHandler, {
        passive: false,
      });
    });
  }

  override disconnectedCallback(): void {
    if (this._wheelHandler && this._container) {
      this._container.removeEventListener("wheel", this._wheelHandler);
      this._wheelHandler = null;
    }
    super.disconnectedCallback();
  }

  protected override firstUpdated(): void {
    const root = this.renderRoot;
    this._svgTransformGroup = root.querySelector(
      "g.transform-group",
    ) as SVGGElement | null;
    this._htmlTransformGroup = root.querySelector(
      "div.transform-group",
    ) as HTMLDivElement | null;
    this._zoomIndicator = root.querySelector(
      ".zoom-indicator",
    ) as HTMLElement | null;
    this._container = root.querySelector(
      ".canvas-container",
    ) as HTMLDivElement | null;

    // Apply initial viewport (transform groups only -- Lit template handles indicator)
    this._applyTransformGroups(this.viewport);
    this._currentScale = this.viewport.scale;
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has("viewport")) {
      // Always keep _currentScale in sync for imperative transform updates
      this._currentScale = this.viewport.scale;
      if (this._svgTransformGroup) {
        // Only update transform groups after firstUpdated -- Lit template handles initial
        this._applyTransformGroups(this.viewport);
      }
    }
  }

  // -- Render ---------------------------------------------------------------

  override render() {
    const { x, y, scale } = this.viewport;
    const pct = `${Math.round(scale * 100)}%`;

    const nodeCount = this.nodes.length;
    const ariaLabel = `Graph canvas with ${nodeCount} node${nodeCount !== 1 ? "s" : ""}`;

    return html`
      <div
        class="canvas-container"
        role="application"
        aria-label=${ariaLabel}
        @pointerdown=${this._onPointerDown}
        @pointermove=${this._onPointerMove}
        @pointerup=${this._onPointerUp}
      >
        <svg class="svg-layer">
          ${svg`
            <defs>
              <pattern id="dot-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <circle cx="12" cy="12" r="1" class="grid-dot" />
              </pattern>
            </defs>
            <g class="transform-group" style="transform: translate(${x}px, ${y}px) scale(${scale})">
              <rect x="-5000" y="-5000" width="10000" height="10000" fill="url(#dot-grid)" />
              ${this._renderEdges(this.edges, this.nodes, this.selectedEdgeId)}
            </g>
          `}
        </svg>
        <div class="html-layer">
          <div
            class="transform-group"
            style="transform-origin: 0 0; transform: translate(${x}px, ${y}px) scale(${scale})"
          >
            ${this._renderNodes(this.nodes, this.selectedNodeIds, this.highlightNodeIds)}
          </div>
        </div>
        <div class="zoom-indicator">${pct}</div>
      </div>
    `;
  }

  // -- Node rendering -------------------------------------------------------

  /** Render node cards on the HTML layer. */
  private _renderNodes(
    nodes: ReadonlyArray<PipelineNode>,
    selectedIds: ReadonlySet<string>,
    highlightIds: string[] = [],
  ) {
    return repeat(
      nodes,
      (n) => n.id,
      (n) => {
        const isSelected = selectedIds.has(n.id);
        const isHighlighted = highlightIds.includes(n.id);
        const statusAttr = this.nodeStatuses.get(n.id) ?? "";
        const typeLabel = n.typeId && NODE_TYPE_COLORS[n.typeId] ? `, type ${NODE_TYPE_COLORS[n.typeId]!.label}` : "";
        const tc = n.typeConfig as Record<string, unknown> | undefined;
        const resolvedAgent = n.agentId
          || (typeof tc?.agent === "string" && tc.agent !== "" ? tc.agent : "")
          || (Array.isArray(tc?.agents) && (tc!.agents as string[]).length > 0
            ? (tc!.agents as string[]).join(", ") : "");
        const nodeAriaLabel = `Node ${n.id}${resolvedAgent ? ", agent " + resolvedAgent : ""}${typeLabel}, ${n.task.substring(0, 50)}`;
        return html`
          <div
            class="node-card ${isSelected ? "node-card--selected" : ""} ${isHighlighted ? "highlight" : ""}"
            data-node-id=${n.id}
            data-status=${statusAttr}
            tabindex="0"
            role="button"
            aria-label=${nodeAriaLabel}
            aria-selected=${isSelected ? "true" : "false"}
            style="transform: translate(${n.position.x}px, ${n.position.y}px)"
          >
            <div class="port port-in" data-node-id=${n.id} data-port="in"></div>
            <div class="node-header">
              <span class="node-status-dot"></span>
              <span class="node-id">${n.id}</span>
            </div>
            ${resolvedAgent
              ? html`<span class="node-agent-tag">${resolvedAgent}</span>`
              : nothing}
            ${n.typeId && NODE_TYPE_COLORS[n.typeId]
              ? html`<span class="node-type-tag" style="
                  background: color-mix(in srgb, ${NODE_TYPE_COLORS[n.typeId]!.color} 15%, transparent);
                  color: ${NODE_TYPE_COLORS[n.typeId]!.color};
                ">${NODE_TYPE_COLORS[n.typeId]!.label}</span>`
              : nothing}
            <div class="node-task-preview">
              ${this._truncateTask(n.task)}
            </div>
            ${this._renderConstraints(n)}
            <div class="port port-out" data-node-id=${n.id} data-port="out"></div>
          </div>
        `;
      },
    );
  }

  /** Render constraint indicators (timeout, maxSteps) for a node. */
  private _renderConstraints(node: PipelineNode) {
    const parts: string[] = [];
    if (node.timeoutMs != null) {
      parts.push(`${Math.round(node.timeoutMs / 1000)}s`);
    }
    if (node.maxSteps != null) {
      parts.push(`${node.maxSteps} steps`);
    }
    if (parts.length === 0) return nothing;
    return html`<div class="node-constraints">${parts.join(" | ")}</div>`;
  }

  /** Truncate task text with ellipsis. */
  private _truncateTask(task: string, maxLen = 40): string {
    if (task.length > maxLen) {
      return task.slice(0, maxLen - 1) + "\u2026";
    }
    return task;
  }

  // -- Edge rendering -------------------------------------------------------

  /** Render edges as SVG Bezier paths with arrowheads, hit areas, and labels. */
  private _renderEdges(
    edges: ReadonlyArray<PipelineEdge>,
    nodes: ReadonlyArray<PipelineNode>,
    selectedEdgeId: string | null,
  ) {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    return repeat(
      edges,
      (e) => e.id,
      (e) => {
        const sourceNode = nodeMap.get(e.source);
        const targetNode = nodeMap.get(e.target);
        if (!sourceNode || !targetNode) return nothing;

        const sourcePort = getOutputPortPosition(sourceNode);
        const targetPort = getInputPortPosition(targetNode);
        const pathD = computeBezierPath(sourcePort, targetPort);
        const arrowD = computeArrowhead(targetPort, sourcePort);
        const isSelected = selectedEdgeId === e.id;
        const edgeStatus = this.edgeStatuses.get(e.id) ?? "";
        const edgePathStatusClass = edgeStatus ? `edge-path--${edgeStatus}` : "";
        const arrowStatusClass = edgeStatus ? `edge-arrow--${edgeStatus}` : "";

        return svg`
          <g class="edge-group" data-edge-id=${e.id}>
            <path class="edge-hit-area" d=${pathD} @click=${() => this._onEdgeClick(e.id)} />
            <path class="edge-path ${isSelected ? "edge-path--selected" : ""} ${edgePathStatusClass}" d=${pathD} />
            <path class="edge-arrow ${isSelected ? "edge-arrow--selected" : ""} ${arrowStatusClass}" d=${arrowD} />
          </g>
        `;
      },
    );
  }

  /** Dispatch edge-select event when an edge hit area is clicked. */
  private _onEdgeClick(edgeId: string): void {
    this.dispatchEvent(
      new CustomEvent<string>("edge-select", {
        detail: edgeId,
        bubbles: true,
        composed: true,
      }),
    );
  }

  // -- Helpers --------------------------------------------------------------

  /** Apply transform to SVG and HTML layers only (safe during Lit lifecycle). */
  private _applyTransformGroups(vt: ViewportTransform): void {
    const t = `translate(${vt.x}px, ${vt.y}px) scale(${vt.scale})`;
    if (this._svgTransformGroup) {
      this._svgTransformGroup.style.transform = t;
    }
    if (this._htmlTransformGroup) {
      this._htmlTransformGroup.style.transform = t;
    }
  }

  /**
   * Apply viewport transform to both layers AND zoom indicator via direct DOM.
   * Used by imperative handlers (wheel, pan) that bypass Lit reactivity for 60fps.
   * Do NOT call during Lit lifecycle (willUpdate/updated) -- it would clobber Lit parts.
   */
  private _syncTransformImperative(vt: ViewportTransform): void {
    this._applyTransformGroups(vt);
    if (this._zoomIndicator) {
      this._zoomIndicator.textContent = `${Math.round(vt.scale * 100)}%`;
    }
    this._currentScale = vt.scale;
  }

  /** Dispatch a viewport-change CustomEvent. */
  private _dispatchViewportChange(vt: ViewportTransform): void {
    this.dispatchEvent(
      new CustomEvent<ViewportTransform>("viewport-change", {
        detail: vt,
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Get the current viewport (uses live pan if available). */
  private _getCurrentViewport(): ViewportTransform {
    return {
      x: this._livePanX || this.viewport.x,
      y: this._livePanY || this.viewport.y,
      scale: this._currentScale,
    };
  }

  // -- Pointer event handlers -----------------------------------------------

  private _onPointerDown(e: PointerEvent): void {
    if (this._mode !== "idle") return;

    // Priority: port > node > canvas
    const path = e.composedPath();
    for (const el of path) {
      if (!(el instanceof Element)) continue;

      // Check for output port -- initiates edge connection
      if (el.classList.contains("port") && el.classList.contains("port-out")) {
        if (this.readOnly) return; // No edge connection in monitor mode
        const nodeId = el.getAttribute("data-node-id");
        if (nodeId) {
          this._startEdgeConnection(e, nodeId);
          return;
        }
      }

      // Check for input port -- do not initiate from input ports
      if (el.classList.contains("port") && el.classList.contains("port-in")) {
        return;
      }

      // Check for node card -- initiates node drag (or inspect in readOnly)
      if (el.hasAttribute("data-node-id") && el.classList.contains("node-card")) {
        const nodeId = el.getAttribute("data-node-id")!;

        if (this.readOnly) {
          // In monitor mode: dispatch node-inspect instead of node-select, no drag
          this.dispatchEvent(
            new CustomEvent("node-inspect", {
              detail: { nodeId },
              bubbles: true,
              composed: true,
            }),
          );
          return;
        }

        // Dispatch node-select event
        this.dispatchEvent(
          new CustomEvent("node-select", {
            detail: { nodeId, multi: e.shiftKey },
            bubbles: true,
            composed: true,
          }),
        );
        this._startNodeDrag(e, nodeId);
        return;
      }
    }

    // Canvas click -- deselect all
    this.dispatchEvent(
      new CustomEvent("canvas-click", {
        bubbles: true,
        composed: true,
      }),
    );

    // Panning on empty canvas
    this._mode = "panning";
    this._dragStartX = e.clientX;
    this._dragStartY = e.clientY;
    this._startPanX = this.viewport.x;
    this._startPanY = this.viewport.y;
    this._livePanX = this.viewport.x;
    this._livePanY = this.viewport.y;

    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    e.preventDefault();

    if (this._container) {
      this._container.setAttribute("data-mode", "panning");
    }
    this.interactionMode = "panning";
  }

  private _onPointerMove(e: PointerEvent): void {
    switch (this._mode) {
      case "panning":
        this._onPointerMovePanning(e);
        break;
      case "dragging-node":
        this._onPointerMoveDragNode(e);
        break;
      case "connecting-edge":
        this._onPointerMoveConnecting(e);
        break;
    }
  }

  private _onPointerUp(e: PointerEvent): void {
    switch (this._mode) {
      case "panning": {
        const vt: ViewportTransform = {
          x: this._livePanX,
          y: this._livePanY,
          scale: this._currentScale,
        };
        this._dispatchViewportChange(vt);
        break;
      }
      case "dragging-node":
        this._finishNodeDrag();
        break;
      case "connecting-edge":
        this._finishEdgeConnection(e);
        break;
    }

    this._mode = "idle";
    this.interactionMode = "idle";
    if (this._container) {
      this._container.removeAttribute("data-mode");
    }
  }

  // -- Panning handlers -----------------------------------------------------

  private _onPointerMovePanning(e: PointerEvent): void {
    const dx = e.clientX - this._dragStartX;
    const dy = e.clientY - this._dragStartY;
    const newX = this._startPanX + dx;
    const newY = this._startPanY + dy;

    // Direct DOM manipulation for 60fps
    const t = `translate(${newX}px, ${newY}px) scale(${this._currentScale})`;
    if (this._svgTransformGroup) {
      this._svgTransformGroup.style.transform = t;
    }
    if (this._htmlTransformGroup) {
      this._htmlTransformGroup.style.transform = t;
    }

    this._livePanX = newX;
    this._livePanY = newY;
  }

  // -- Node drag handlers ---------------------------------------------------

  /** Begin dragging a node (and all selected nodes if multi-selected). */
  private _startNodeDrag(e: PointerEvent, nodeId: string): void {
    this._mode = "dragging-node";
    this._dragNodeId = nodeId;

    // Convert pointer to graph space
    const rect = this._container?.getBoundingClientRect();
    if (!rect) return;
    const vt = this._getCurrentViewport();
    const graphPt = screenToGraph(e.clientX, e.clientY, rect, vt);
    this._dragStartGraphX = graphPt.x;
    this._dragStartGraphY = graphPt.y;

    // Find primary node's start position
    const primaryNode = this.nodes.find((n) => n.id === nodeId);
    if (primaryNode) {
      this._dragNodeStartX = primaryNode.position.x;
      this._dragNodeStartY = primaryNode.position.y;
      this._dragLiveX = primaryNode.position.x;
      this._dragLiveY = primaryNode.position.y;
    }

    // Store start positions for all selected nodes (for multi-drag)
    this._dragSelectedStarts.clear();
    // Always include the primary drag node
    if (primaryNode) {
      this._dragSelectedStarts.set(nodeId, { ...primaryNode.position });
    }
    // Include other selected nodes
    for (const selId of this.selectedNodeIds) {
      if (selId === nodeId) continue;
      const selNode = this.nodes.find((n) => n.id === selId);
      if (selNode) {
        this._dragSelectedStarts.set(selId, { ...selNode.position });
      }
    }

    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();

    if (this._container) {
      this._container.setAttribute("data-mode", "dragging-node");
    }
    this.interactionMode = "dragging-node";
  }

  /** Update node positions via direct DOM during drag (60fps). */
  private _onPointerMoveDragNode(e: PointerEvent): void {
    const rect = this._container?.getBoundingClientRect();
    if (!rect) return;

    const vt = this._getCurrentViewport();
    const graphPt = screenToGraph(e.clientX, e.clientY, rect, vt);
    const dx = graphPt.x - this._dragStartGraphX;
    const dy = graphPt.y - this._dragStartGraphY;

    for (const [nId, startPos] of this._dragSelectedStarts) {
      let newX = startPos.x + dx;
      let newY = startPos.y + dy;

      if (this.snapToGrid) {
        newX = Math.round(newX / 24) * 24;
        newY = Math.round(newY / 24) * 24;
      }

      // Direct DOM: update node card position
      const nodeEl = this.renderRoot.querySelector(
        `.node-card[data-node-id="${nId}"]`,
      ) as HTMLElement | null;
      if (nodeEl) {
        nodeEl.style.transform = `translate(${newX}px, ${newY}px)`;
      }

      // Direct DOM: update connected edges
      this._updateConnectedEdges(nId, newX, newY, dx, dy);

      // Track primary node's live position
      if (nId === this._dragNodeId) {
        this._dragLiveX = newX;
        this._dragLiveY = newY;
      }
    }
  }

  /** Update SVG edge paths for a node being dragged. */
  private _updateConnectedEdges(
    nodeId: string,
    newX: number,
    newY: number,
    dx: number,
    dy: number,
  ): void {
    for (const edge of this.edges) {
      if (edge.source !== nodeId && edge.target !== nodeId) continue;

      // Determine source port position
      let srcPos: { x: number; y: number };
      if (edge.source === nodeId) {
        srcPos = { x: newX, y: newY };
      } else {
        // Check if source is also being dragged
        const srcStart = this._dragSelectedStarts.get(edge.source);
        if (srcStart) {
          let sx = srcStart.x + dx;
          let sy = srcStart.y + dy;
          if (this.snapToGrid) {
            sx = Math.round(sx / 24) * 24;
            sy = Math.round(sy / 24) * 24;
          }
          srcPos = { x: sx, y: sy };
        } else {
          const srcNode = this.nodes.find((n) => n.id === edge.source);
          if (!srcNode) continue;
          srcPos = srcNode.position;
        }
      }

      // Determine target port position
      let tgtPos: { x: number; y: number };
      if (edge.target === nodeId) {
        tgtPos = { x: newX, y: newY };
      } else {
        const tgtStart = this._dragSelectedStarts.get(edge.target);
        if (tgtStart) {
          let tx = tgtStart.x + dx;
          let ty = tgtStart.y + dy;
          if (this.snapToGrid) {
            tx = Math.round(tx / 24) * 24;
            ty = Math.round(ty / 24) * 24;
          }
          tgtPos = { x: tx, y: ty };
        } else {
          const tgtNode = this.nodes.find((n) => n.id === edge.target);
          if (!tgtNode) continue;
          tgtPos = tgtNode.position;
        }
      }

      // Compute port positions from node positions
      const sourcePort = getOutputPortPosition({ position: srcPos });
      const targetPort = getInputPortPosition({ position: tgtPos });
      const pathD = computeBezierPath(sourcePort, targetPort);
      const arrowD = computeArrowhead(targetPort, sourcePort);

      // Direct DOM: update edge SVG paths
      const edgeGroup = this.renderRoot.querySelector(
        `.edge-group[data-edge-id="${edge.id}"]`,
      );
      if (!edgeGroup) continue;

      const hitArea = edgeGroup.querySelector(".edge-hit-area");
      if (hitArea) hitArea.setAttribute("d", pathD);

      const edgePath = edgeGroup.querySelector(".edge-path");
      if (edgePath) edgePath.setAttribute("d", pathD);

      const edgeArrow = edgeGroup.querySelector(".edge-arrow");
      if (edgeArrow) edgeArrow.setAttribute("d", arrowD);
    }
  }

  /** Commit final node positions on pointerup. */
  private _finishNodeDrag(): void {
    const moves: Array<{ nodeId: string; position: { x: number; y: number } }> = [];

    // Compute final positions for all dragged nodes
    const dx = this._dragLiveX - this._dragNodeStartX;
    const dy = this._dragLiveY - this._dragNodeStartY;

    for (const [nId, startPos] of this._dragSelectedStarts) {
      let finalX = startPos.x + dx;
      let finalY = startPos.y + dy;

      if (this.snapToGrid) {
        finalX = Math.round(finalX / 24) * 24;
        finalY = Math.round(finalY / 24) * 24;
      }

      moves.push({ nodeId: nId, position: { x: finalX, y: finalY } });
    }

    if (moves.length > 0) {
      this.dispatchEvent(
        new CustomEvent("node-drag-end", {
          detail: { moves },
          bubbles: true,
          composed: true,
        }),
      );
    }

    // Reset drag state
    this._dragNodeId = null;
    this._dragSelectedStarts.clear();
  }

  // -- Edge connection handlers ---------------------------------------------

  /** Begin edge connection from an output port. */
  private _startEdgeConnection(e: PointerEvent, sourceNodeId: string): void {
    this._mode = "connecting-edge";
    this._connectSourceNodeId = sourceNodeId;

    // Create SVG preview line
    this._previewLine = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    );
    this._previewLine.classList.add("edge-preview");
    this._svgTransformGroup?.appendChild(this._previewLine);

    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();

    if (this._container) {
      this._container.setAttribute("data-mode", "connecting-edge");
    }
    this.interactionMode = "connecting-edge";
  }

  /** Update the preview Bezier line from source port to cursor. */
  private _onPointerMoveConnecting(e: PointerEvent): void {
    if (!this._connectSourceNodeId || !this._previewLine) return;

    const sourceNode = this.nodes.find((n) => n.id === this._connectSourceNodeId);
    if (!sourceNode) return;

    const sourcePort = getOutputPortPosition(sourceNode);

    // Convert cursor to graph space
    const rect = this._container?.getBoundingClientRect();
    if (!rect) return;
    const vt = this._getCurrentViewport();
    const cursorGraph = screenToGraph(e.clientX, e.clientY, rect, vt);

    // Compute Bezier path from source port to cursor
    const pathD = computeBezierPath(sourcePort, cursorGraph);
    this._previewLine.setAttribute("d", pathD);
  }

  /** Complete or cancel edge connection on pointerup. */
  private _finishEdgeConnection(e: PointerEvent): void {
    // Remove preview line
    if (this._previewLine && this._previewLine.parentNode) {
      this._previewLine.parentNode.removeChild(this._previewLine);
    }
    this._previewLine = null;

    // Walk composed path for an input port
    const path = e.composedPath();
    let targetNodeId: string | null = null;

    for (const el of path) {
      if (!(el instanceof Element)) continue;
      if (el.classList.contains("port-in") && el.hasAttribute("data-node-id")) {
        targetNodeId = el.getAttribute("data-node-id");
        break;
      }
    }

    // Dispatch edge-create if valid (target found and not self-loop)
    if (
      targetNodeId &&
      this._connectSourceNodeId &&
      targetNodeId !== this._connectSourceNodeId
    ) {
      this.dispatchEvent(
        new CustomEvent("edge-create", {
          detail: {
            source: this._connectSourceNodeId,
            target: targetNodeId,
          },
          bubbles: true,
          composed: true,
        }),
      );
    }

    // Reset connection state
    this._connectSourceNodeId = null;
  }

  /** Cancel any in-progress interaction (e.g. Escape key). */
  cancelInteraction(): void {
    if (this._mode === "connecting-edge") {
      if (this._previewLine && this._previewLine.parentNode) {
        this._previewLine.parentNode.removeChild(this._previewLine);
      }
      this._previewLine = null;
      this._connectSourceNodeId = null;
    }

    this._mode = "idle";
    this.interactionMode = "idle";
    if (this._container) {
      this._container.removeAttribute("data-mode");
    }
  }

  // -- Wheel handler (zoom) -------------------------------------------------

  private _onWheel(e: WheelEvent): void {
    e.preventDefault();

    const rect = this._container?.getBoundingClientRect();
    if (!rect) return;

    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;

    const currentVT = this._getCurrentViewport();

    const newVT = zoomAtPoint(
      currentVT,
      cursorX,
      cursorY,
      e.deltaY,
      MIN_SCALE,
      MAX_SCALE,
    );

    // Direct DOM manipulation (imperative -- bypasses Lit for 60fps)
    this._syncTransformImperative(newVT);
    this._livePanX = newVT.x;
    this._livePanY = newVT.y;

    this._dispatchViewportChange(newVT);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-graph-canvas": IcGraphCanvas;
  }
}
