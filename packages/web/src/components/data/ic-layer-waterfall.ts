import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

/** A single layer in the context pipeline waterfall. */
export interface WaterfallLayer {
  name: string;
  durationMs: number;
  messagesIn: number;
  messagesOut: number;
}

/**
 * Format a layer name for display: replace hyphens with spaces, capitalize first letter.
 * Example: "thinking-cleaner" -> "Thinking cleaner"
 */
function formatLayerName(name: string): string {
  const spaced = name.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Vertical waterfall chart showing per-layer pipeline timing.
 *
 * Each layer is rendered as a row with a name, a timed bar showing
 * cumulative offset and duration, and a millisecond label. Creates a
 * waterfall effect where each subsequent bar starts after the previous.
 *
 * @example
 * ```html
 * <ic-layer-waterfall
 *   .layers=${[
 *     { name: "system-prompt", durationMs: 12, messagesIn: 0, messagesOut: 3 },
 *     { name: "memory-inject", durationMs: 45, messagesIn: 3, messagesOut: 8 },
 *     { name: "thinking-cleaner", durationMs: 5, messagesIn: 8, messagesOut: 7 },
 *   ]}
 * ></ic-layer-waterfall>
 * ```
 */
@customElement("ic-layer-waterfall")
export class IcLayerWaterfall extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .row {
        display: grid;
        grid-template-columns: 140px 1fr 60px;
        align-items: center;
        gap: var(--ic-space-sm);
        padding: 2px 0;
      }

      .layer-name {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .track {
        height: 16px;
        background: var(--ic-surface-2, #1f2937);
        border-radius: var(--ic-radius-sm, 4px);
        position: relative;
        overflow: hidden;
      }

      .fill {
        position: absolute;
        top: 0;
        height: 100%;
        background: var(--ic-accent);
        border-radius: var(--ic-radius-sm, 4px);
        min-width: 2px;
        transition: width var(--ic-transition, 150ms ease),
          left var(--ic-transition, 150ms ease);
      }

      .duration {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        text-align: right;
      }

      .empty {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-dim);
        font-style: italic;
      }
    `,
  ];

  /** Array of pipeline layers to display. */
  @property({ attribute: false }) layers: WaterfallLayer[] = [];

  /** Explicit total duration in ms. If 0, computed from sum of layer durations. */
  @property({ type: Number }) totalDurationMs = 0;

  private _getTotalDuration(): number {
    if (this.totalDurationMs > 0) return this.totalDurationMs;
    return this.layers.reduce((sum, l) => sum + l.durationMs, 0);
  }

  override render() {
    if (this.layers.length === 0) {
      return html`<div class="empty">No layer data</div>`;
    }

    const total = this._getTotalDuration();
    let cumulativeMs = 0;

    return html`
      ${this.layers.map((layer) => {
        const offsetPct = total > 0 ? (cumulativeMs / total) * 100 : 0;
        const widthPct = total > 0 ? (layer.durationMs / total) * 100 : 0;
        cumulativeMs += layer.durationMs;

        return html`
          <div class="row">
            <span class="layer-name" title="${formatLayerName(layer.name)}"
              >${formatLayerName(layer.name)}</span
            >
            <div class="track">
              <div
                class="fill"
                style="left: ${offsetPct}%; width: ${widthPct}%;"
                title="${layer.name}: ${layer.durationMs}ms (${layer.messagesIn} -> ${layer.messagesOut} messages)"
              ></div>
            </div>
            <span class="duration">${layer.durationMs}ms</span>
          </div>
        `;
      })}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-layer-waterfall": IcLayerWaterfall;
  }
}
