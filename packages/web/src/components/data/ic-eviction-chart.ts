// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

/** Eviction category name to eviction count mapping. */
export type EvictionCategories = Record<string, number>;

/** Default color mapping for known eviction categories. */
const CATEGORY_COLORS: Record<string, string> = {
  file_read: "var(--ic-accent)",
  exec: "var(--ic-success)",
  web: "var(--ic-info, #3b82f6)",
  image: "var(--ic-warning)",
  error: "var(--ic-error)",
};

const UNKNOWN_COLOR = "var(--ic-text-dim)";

/**
 * Horizontal stacked bar showing eviction breakdown by category.
 *
 * Each category segment is proportionally sized by its eviction count.
 * Known categories are color-coded; unknown categories use a neutral
 * color. Includes an optional legend and a total count label.
 *
 * @example
 * ```html
 * <ic-eviction-chart
 *   .categories=${{ file_read: 12, exec: 5, web: 3, image: 2 }}
 * ></ic-eviction-chart>
 * ```
 */
@customElement("ic-eviction-chart")
export class IcEvictionChart extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .total-label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        margin-bottom: var(--ic-space-xs);
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

  /** Category name to eviction count mapping. */
  @property({ attribute: false }) categories: Record<string, number> = {};

  /** Whether to show the legend below the bar. */
  @property({ type: Boolean, attribute: "show-legend" }) showLegend = true;

  private _getColor(category: string): string {
    return CATEGORY_COLORS[category] ?? UNKNOWN_COLOR;
  }

  private _getEntries(): Array<{ name: string; count: number; color: string }> {
    return Object.entries(this.categories)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => ({
        name,
        count,
        color: this._getColor(name),
      }));
  }

  override render() {
    const entries = this._getEntries();
    const total = entries.reduce((sum, e) => sum + e.count, 0);

    if (total === 0 || entries.length === 0) {
      return html`<div class="empty">No evictions</div>`;
    }

    return html`
      <div class="total-label">${total} eviction${total === 1 ? "" : "s"}</div>
      <div class="bar" role="img" aria-label="Eviction breakdown">
        ${entries.map((entry) => {
          const pct = (entry.count / total) * 100;
          return html`
            <div
              class="segment"
              style="width: ${pct}%; background: ${entry.color};"
              title="${entry.name}: ${entry.count} evictions (${pct.toFixed(1)}%)"
            ></div>
          `;
        })}
      </div>
      ${this.showLegend
        ? html`
            <div class="legend">
              ${entries.map(
                (entry) => html`
                  <span class="legend-item">
                    <span
                      class="legend-dot"
                      style="background: ${entry.color};"
                    ></span>
                    ${entry.name}
                  </span>
                `,
              )}
            </div>
          `
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-eviction-chart": IcEvictionChart;
  }
}
