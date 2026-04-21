// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

/** A single segment in the budget breakdown bar. */
export interface BudgetSegment {
  label: string;
  tokens: number;
  color: string;
}

/**
 * Horizontal stacked bar showing token budget allocation by segment.
 *
 * Each segment is proportionally sized by its token count relative to
 * the total. Includes a legend row with colored dots and labels below
 * the bar.
 *
 * @example
 * ```html
 * <ic-budget-segment-bar
 *   .segments=${[
 *     { label: "System", tokens: 2000, color: "var(--ic-accent)" },
 *     { label: "Memory", tokens: 1500, color: "var(--ic-success)" },
 *     { label: "Tools",  tokens: 500,  color: "var(--ic-warning)" },
 *   ]}
 * ></ic-budget-segment-bar>
 * ```
 */
@customElement("ic-budget-segment-bar")
export class IcBudgetSegmentBar extends LitElement {
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
        transition: width var(--ic-transition, 150ms ease);
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

  /** Array of budget segments to display. */
  @property({ attribute: false }) segments: BudgetSegment[] = [];

  /** Explicit total token count. If 0, computed from segments sum. */
  @property({ type: Number }) total = 0;

  private _getTotal(): number {
    if (this.total > 0) return this.total;
    return this.segments.reduce((sum, s) => sum + s.tokens, 0);
  }

  override render() {
    const computedTotal = this._getTotal();

    if (computedTotal === 0 || this.segments.length === 0) {
      return html`<div class="empty">No budget data</div>`;
    }

    return html`
      <div class="bar" role="img" aria-label="Token budget breakdown">
        ${this.segments.map((seg) => {
          const pct = (seg.tokens / computedTotal) * 100;
          return html`
            <div
              class="segment"
              style="width: ${pct}%; background: ${seg.color};"
              title="${seg.label}: ${seg.tokens.toLocaleString()} tokens (${pct.toFixed(1)}%)"
            ></div>
          `;
        })}
      </div>
      <div class="legend">
        ${this.segments.map(
          (seg) => html`
            <span class="legend-item">
              <span class="legend-dot" style="background: ${seg.color};"></span>
              ${seg.label}
            </span>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-budget-segment-bar": IcBudgetSegmentBar;
  }
}
