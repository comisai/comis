// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

/**
 * Format a number with comma separators.
 * Example: 612000 -> "612,000"
 */
function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Horizontal token budget usage bar with color thresholds.
 *
 * Displays a label, formatted "used / total (XX%)" values, and a horizontal
 * progress bar that changes color based on configurable warning and danger
 * thresholds.
 *
 * @example
 * ```html
 * <ic-budget-bar label="Per Day" used="612000" total="1000000"></ic-budget-bar>
 * <ic-budget-bar label="Per Hour" used="0" total="0"></ic-budget-bar>
 * ```
 */
@customElement("ic-budget-bar")
export class IcBudgetBar extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 4px;
      }

      .label {
        font-size: var(--ic-text-sm, 0.875rem);
        color: var(--ic-text, #f3f4f6);
        font-weight: 500;
      }

      .values {
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-dim, #6b7280);
      }

      .track {
        width: 100%;
        height: 8px;
        background: var(--ic-surface-2, #1f2937);
        border-radius: var(--ic-radius-sm, 0.25rem);
        overflow: hidden;
      }

      .bar-fill {
        height: 100%;
        border-radius: var(--ic-radius-sm, 0.25rem);
        transition: width var(--ic-transition, 150ms ease);
        min-width: 0;
      }

      .bar-fill--success {
        background: var(--ic-success);
      }

      .bar-fill--warning {
        background: var(--ic-warning);
      }

      .bar-fill--danger {
        background: var(--ic-error);
      }

      .unlimited {
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-dim, #6b7280);
        font-style: italic;
      }
    `,
  ];

  /** Budget name (e.g., "Per Day"). */
  @property() label = "";

  /** Tokens used. */
  @property({ type: Number }) used = 0;

  /** Token budget limit (0 means unlimited). */
  @property({ type: Number }) total = 0;

  /** Percentage at which bar turns yellow. */
  @property({ type: Number }) warnThreshold = 70;

  /** Percentage at which bar turns red. */
  @property({ type: Number }) dangerThreshold = 90;

  override render() {
    if (this.total === 0) {
      return html`
        <div class="header">
          <span class="label">${this.label}</span>
          <span class="unlimited">unlimited</span>
        </div>
      `;
    }

    const pct = Math.min(100, Math.round((this.used / this.total) * 100));
    const colorClass =
      pct >= this.dangerThreshold
        ? "bar-fill--danger"
        : pct >= this.warnThreshold
          ? "bar-fill--warning"
          : "bar-fill--success";

    return html`
      <div class="header">
        <span class="label">${this.label}</span>
        <span class="values">${formatNumber(this.used)} / ${formatNumber(this.total)} (${pct}%)</span>
      </div>
      <div class="track">
        <div
          class="bar-fill ${colorClass}"
          style="width: ${pct}%"
        ></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-budget-bar": IcBudgetBar;
  }
}
