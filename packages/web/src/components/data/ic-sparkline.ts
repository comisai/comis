// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, svg, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

/**
 * Inline mini sparkline chart component.
 *
 * Renders a small SVG polyline from a numeric data array.
 * Useful for showing trends inline alongside stat values.
 *
 * @example
 * ```html
 * <ic-sparkline .data=${[10, 25, 18, 30, 22]} width=${100} height=${30}></ic-sparkline>
 * ```
 */
@customElement("ic-sparkline")
export class IcSparkline extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: inline-block;
      }

      svg {
        display: block;
        width: 100%;
        height: 100%;
      }
    `,
  ];

  /** Numeric data points to plot. */
  @property({ attribute: false }) data: number[] = [];

  /** SVG viewBox width. */
  @property({ type: Number }) width = 80;

  /** SVG viewBox height. */
  @property({ type: Number }) height = 24;

  /** Stroke color for the polyline. */
  @property() color = "var(--ic-accent)";

  private _buildPoints(): string {
    const { data, width, height } = this;
    if (data.length === 0) return "";

    if (data.length === 1) {
      // Single point: render at center height
      return `${width / 2},${height / 2}`;
    }

    const max = Math.max(...data);
    const min = Math.min(...data);
    const range = max - min;

    const stepX = width / (data.length - 1);
    const padding = 1; // Small padding so line doesn't touch edges

    return data
      .map((value, index) => {
        const x = index * stepX;
        const normalizedY =
          range === 0
            ? height / 2 // All same values: flat line at center
            : padding + ((max - value) / range) * (height - padding * 2);
        return `${x},${normalizedY}`;
      })
      .join(" ");
  }

  override render() {
    if (this.data.length === 0) {
      return html``;
    }

    const points = this._buildPoints();

    if (this.data.length === 1) {
      // Single data point: render as a small circle
      const [cx, cy] = points.split(",").map(Number);
      return html`
        <svg
          viewBox="0 0 ${this.width} ${this.height}"
          preserveAspectRatio="none"
        >
          ${svg`<circle cx=${cx} cy=${cy} r="2" fill=${this.color} />`}
        </svg>
      `;
    }

    return html`
      <svg
        viewBox="0 0 ${this.width} ${this.height}"
        preserveAspectRatio="none"
      >
        ${svg`<polyline
          points=${points}
          fill="none"
          stroke=${this.color}
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />`}
      </svg>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-sparkline": IcSparkline;
  }
}
