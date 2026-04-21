// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";
import type { CostSegment } from "../../api/types/index.js";

export type { CostSegment };

/**
 * Multi-level cost attribution chart with clickable drill-down segments.
 *
 * Renders a stacked horizontal bar with proportionally-sized, clickable
 * segments. Each segment dispatches a `segment-click` CustomEvent on
 * click. Includes a legend row with colored dots, labels, and formatted
 * currency values.
 *
 * @fires segment-click - Dispatched when a segment is clicked. `detail` contains `{ label, value }`.
 *
 * @example
 * ```html
 * <ic-cost-breakdown
 *   .segments=${[
 *     { label: "Anthropic", value: 12.34, color: "var(--ic-accent)" },
 *     { label: "OpenAI", value: 8.56, color: "var(--ic-success)" },
 *   ]}
 *   .total=${20.9}
 *   @segment-click=${(e) => console.log(e.detail)}
 * ></ic-cost-breakdown>
 * ```
 */
@customElement("ic-cost-breakdown")
export class IcCostBreakdown extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .bar {
        display: flex;
        height: 20px;
        border-radius: var(--ic-radius-sm, 4px);
        overflow: hidden;
      }

      .segment {
        min-width: 2px;
        height: 100%;
        cursor: pointer;
        transition: filter 0.15s;
      }

      .segment:hover {
        filter: brightness(1.2);
      }

      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: var(--ic-space-sm);
        margin-top: var(--ic-space-sm);
      }

      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      .legend-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .empty {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-dim);
        font-style: italic;
      }
    `,
  ];

  /** Array of cost segments to display. */
  @property({ attribute: false }) segments: CostSegment[] = [];

  /** Total cost used for percentage calculation. If 0, computed from segments sum. */
  @property({ type: Number }) total = 0;

  /** Currency symbol for formatting. */
  @property({ type: String }) currency = "$";

  private _getTotal(): number {
    if (this.total > 0) return this.total;
    return this.segments.reduce((sum, s) => sum + s.value, 0);
  }

  private _formatValue(value: number): string {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: this.currency === "$" ? "USD" : this.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  private _onSegmentClick(segment: CostSegment): void {
    this.dispatchEvent(
      new CustomEvent("segment-click", {
        detail: { label: segment.label, value: segment.value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const computedTotal = this._getTotal();

    if (computedTotal === 0 || this.segments.length === 0) {
      return html`<div class="empty">No cost data available</div>`;
    }

    return html`
      <div class="bar" role="img" aria-label="Cost breakdown">
        ${this.segments.map((seg) => {
          const pct = (seg.value / computedTotal) * 100;
          return html`
            <div
              class="segment"
              style="width: ${pct}%; background: ${seg.color};"
              title="${seg.label}: ${this._formatValue(seg.value)} (${pct.toFixed(1)}%)"
              @click=${() => this._onSegmentClick(seg)}
            ></div>
          `;
        })}
      </div>
      <div class="legend">
        ${this.segments.map(
          (seg) => html`
            <span class="legend-item">
              <span class="legend-dot" style="background: ${seg.color};"></span>
              ${seg.label}: ${this._formatValue(seg.value)}
            </span>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-cost-breakdown": IcCostBreakdown;
  }
}
