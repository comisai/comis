/**
 * Gantt-style execution timeline for the monitor view.
 *
 * Renders horizontal bars per node color-coded by execution status.
 * Running bars extend in real-time via the elapsedMs property.
 * Clicking a bar dispatches a node-inspect event.
 *
 * Supports timeline display and click-to-inspect for nodes.
 *
 * Events dispatched (all CustomEvent, bubbles: true, composed: true):
 * - node-inspect: { nodeId: string } -- when a timeline bar is clicked
 */

import { LitElement, html, css, svg, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";
import type { MonitorNodeState } from "../../api/types/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 28;
const ROW_GAP = 4;
const LABEL_WIDTH = 80;
const TOP_AXIS_HEIGHT = 20;
const BAR_RADIUS = 2;
const MIN_TIMELINE_WIDTH = 200;

// ---------------------------------------------------------------------------
// Status colors
// ---------------------------------------------------------------------------

const STATUS_BAR_COLORS: Record<string, string> = {
  running: "#06b6d4",
  completed: "#22c55e",
  failed: "#ef4444",
  skipped: "#9ca3af",
  pending: "#4b5563",
  ready: "#a78bfa",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("ic-execution-timeline")
export class IcExecutionTimeline extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        height: 200px;
        background: var(--ic-surface);
        border-top: 1px solid var(--ic-border);
        overflow-x: auto;
        overflow-y: auto;
      }

      svg {
        display: block;
      }

      .bar {
        cursor: pointer;
      }

      .bar:hover {
        filter: brightness(1.2);
      }

      .label-text {
        font-family: var(--ic-font-mono, monospace);
        font-size: 10px;
        fill: var(--ic-text-muted, #9ca3af);
        dominant-baseline: central;
      }

      .time-marker {
        font-size: 9px;
        fill: var(--ic-text-dim, #6b7280);
        text-anchor: middle;
        dominant-baseline: hanging;
      }

      .time-line {
        stroke: var(--ic-border, #374151);
        stroke-width: 0.5;
        stroke-dasharray: 2 2;
      }

      .row-bg {
        fill: var(--ic-surface-2, #1e1e2e);
        opacity: 0.3;
      }

      .selected-highlight {
        stroke: var(--ic-accent, #3b82f6);
        stroke-width: 2;
        fill: none;
      }
    `,
  ];

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  @property({ attribute: false }) nodes: ReadonlyArray<MonitorNodeState> = [];
  @property({ attribute: false }) executionOrder: string[] = [];
  @property({ type: Number }) elapsedMs = 0;
  @property() selectedNodeId: string | null = null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  override render() {
    if (!this.executionOrder.length) {
      return html`<svg width="100%" height="100%"></svg>`;
    }

    const nodeMap = new Map(this.nodes.map((n) => [n.id, n]));
    const orderedNodes = this.executionOrder
      .map((id) => nodeMap.get(id))
      .filter((n): n is MonitorNodeState => n != null);

    if (!orderedNodes.length) {
      return html`<svg width="100%" height="100%"></svg>`;
    }

    // Find time origin (earliest startedAt)
    const startedTimes = orderedNodes
      .filter((n) => n.startedAt != null)
      .map((n) => n.startedAt!);
    const t0 = startedTimes.length > 0 ? Math.min(...startedTimes) : 0;
    const totalMs = Math.max(this.elapsedMs, 1000);

    // SVG dimensions
    const rowCount = orderedNodes.length;
    const svgHeight = TOP_AXIS_HEIGHT + rowCount * (ROW_HEIGHT + ROW_GAP) + ROW_GAP;
    const chartWidth = Math.max(MIN_TIMELINE_WIDTH, 600);
    const svgWidth = LABEL_WIDTH + chartWidth + 16;
    const pxPerMs = chartWidth / totalMs;

    // Time markers
    const totalSec = totalMs / 1000;
    let markerIntervalSec: number;
    if (totalSec < 5) markerIntervalSec = 1;
    else if (totalSec < 60) markerIntervalSec = 5;
    else markerIntervalSec = 10;

    const markers: number[] = [];
    for (let s = markerIntervalSec; s * 1000 <= totalMs; s += markerIntervalSec) {
      markers.push(s);
    }

    return html`
      <svg width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
        <!-- Time markers -->
        ${markers.map((sec) => {
          const x = LABEL_WIDTH + sec * 1000 * pxPerMs;
          return svg`
            <line class="time-line" x1="${x}" y1="${TOP_AXIS_HEIGHT}" x2="${x}" y2="${svgHeight}" />
            <text class="time-marker" x="${x}" y="2">${sec}s</text>
          `;
        })}

        <!-- Rows -->
        ${orderedNodes.map((node, i) => {
          const rowY = TOP_AXIS_HEIGHT + i * (ROW_HEIGHT + ROW_GAP) + ROW_GAP;
          const isSelected = node.id === this.selectedNodeId;

          // Retry state
          const isRetrying = node.retryAttempt != null && node.retryAttempt > 0;

          // Label (truncated) with retry marker
          const baseLabel = node.id.length > 10 ? node.id.slice(0, 9) + "\u2026" : node.id;
          const labelText = isRetrying ? `${baseLabel} (R${node.retryAttempt})` : baseLabel;

          // Bar geometry
          let barX = 0;
          let barW = 0;
          let barColor = STATUS_BAR_COLORS[node.status] ?? "#4b5563";
          let barOpacity = 1;
          let showBar = false;

          if (node.status === "running" && node.startedAt != null) {
            barX = (node.startedAt - t0) * pxPerMs;
            barW = Math.max((totalMs - (node.startedAt - t0)) * pxPerMs, 4);
            barOpacity = 0.8;
            showBar = true;
          } else if (
            (node.status === "completed" || node.status === "failed") &&
            node.startedAt != null
          ) {
            barX = (node.startedAt - t0) * pxPerMs;
            const endTime = node.completedAt ?? (t0 + totalMs);
            barW = Math.max((endTime - node.startedAt) * pxPerMs, 4);
            showBar = true;
          } else if (node.status === "skipped") {
            barX = 0;
            barW = 8;
            barColor = STATUS_BAR_COLORS.skipped;
            barOpacity = 0.5;
            showBar = true;
          }
          // pending/ready: no bar

          return svg`
            <!-- Alternating row background -->
            ${i % 2 === 1
              ? svg`<rect class="row-bg" x="0" y="${rowY}" width="${svgWidth}" height="${ROW_HEIGHT}" />`
              : nothing}

            <!-- Node label -->
            <text class="label-text" x="4" y="${rowY + ROW_HEIGHT / 2}">
              ${labelText}
            </text>

            <!-- Bar -->
            ${showBar
              ? svg`
                <rect
                  class="bar"
                  x="${LABEL_WIDTH + barX}"
                  y="${rowY + 4}"
                  width="${barW}"
                  height="${ROW_HEIGHT - 8}"
                  rx="${BAR_RADIUS}"
                  ry="${BAR_RADIUS}"
                  fill="${barColor}"
                  opacity="${barOpacity}"
                  stroke="${isRetrying ? "#f97316" : "none"}"
                  stroke-width="${isRetrying ? "1.5" : "0"}"
                  data-node-id="${node.id}"
                  @click=${() => this._onBarClick(node.id)}
                />
                ${isSelected
                  ? svg`<rect
                      class="selected-highlight"
                      x="${LABEL_WIDTH + barX - 1}"
                      y="${rowY + 3}"
                      width="${barW + 2}"
                      height="${ROW_HEIGHT - 6}"
                      rx="${BAR_RADIUS + 1}"
                      ry="${BAR_RADIUS + 1}"
                    />`
                  : nothing}
              `
              : nothing}
          `;
        })}
      </svg>
    `;
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private _onBarClick(nodeId: string): void {
    this.dispatchEvent(
      new CustomEvent("node-inspect", {
        bubbles: true,
        composed: true,
        detail: { nodeId },
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-execution-timeline": IcExecutionTimeline;
  }
}
