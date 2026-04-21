// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

/**
 * Horizontal progress bar with percentage text and color thresholds.
 *
 * Changes fill color based on configurable thresholds:
 * - Below green: green (success)
 * - Between green and yellow: yellow (warning)
 * - Above yellow: red (error)
 *
 * @example
 * ```html
 * <ic-progress-bar value=${75} label="Memory"></ic-progress-bar>
 * <ic-progress-bar value=${92} .thresholds=${{ green: 80, yellow: 90 }}></ic-progress-bar>
 * ```
 */
@customElement("ic-progress-bar")
export class IcProgressBar extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        margin-bottom: var(--ic-space-xs);
      }

      .bar-container {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
      }

      .track {
        flex: 1;
        height: 6px;
        background: var(--ic-surface-alt, #1f2937);
        border-radius: 3px;
        overflow: hidden;
      }

      .fill {
        height: 100%;
        border-radius: 3px;
        transition: width 0.3s ease;
      }

      .percent {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        min-width: 2.5em;
        text-align: right;
      }
    `,
  ];

  /** Progress value from 0 to 100. */
  @property({ type: Number }) value = 0;

  /** Optional text label displayed above the bar. */
  @property() label = "";

  /** Whether to show the percentage text to the right. */
  @property({ type: Boolean }) showPercent = true;

  /** Color thresholds: below green = green, green-yellow = yellow, above yellow = red. */
  @property({ attribute: false }) thresholds: { green: number; yellow: number } = {
    green: 80,
    yellow: 90,
  };

  private _getColor(): string {
    const { value, thresholds } = this;
    if (value < thresholds.green) return "var(--ic-success)";
    if (value < thresholds.yellow) return "var(--ic-warning)";
    return "var(--ic-error)";
  }

  override render() {
    const clampedValue = Math.min(this.value, 100);
    const color = this._getColor();

    return html`
      ${this.label ? html`<div class="label">${this.label}</div>` : nothing}
      <div
        class="bar-container"
        role="progressbar"
        aria-valuenow=${this.value}
        aria-valuemin=${0}
        aria-valuemax=${100}
      >
        <div class="track">
          <div
            class="fill"
            style="width: ${clampedValue}%; background-color: ${color};"
          ></div>
        </div>
        ${this.showPercent ? html`<span class="percent">${Math.round(this.value)}%</span>` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-progress-bar": IcProgressBar;
  }
}
