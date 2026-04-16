import { LitElement, html, svg, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

/**
 * Circular SVG gauge showing a percentage value with color-coded arc.
 *
 * The arc color changes based on the value: green below 60%, yellow
 * between 60-80%, and red above 80%. Includes an optional trend
 * indicator and label.
 *
 * @example
 * ```html
 * <ic-metric-gauge value=${72} label="Cache Hit" trend=${1}></ic-metric-gauge>
 * <ic-metric-gauge value=${95} label="CPU" size="lg"></ic-metric-gauge>
 * ```
 */
@customElement("ic-metric-gauge")
export class IcMetricGauge extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: inline-block;
        text-align: center;
      }

      :host([size="sm"]) {
        --gauge-size: 60px;
      }

      :host,
      :host([size="md"]) {
        --gauge-size: 100px;
      }

      :host([size="lg"]) {
        --gauge-size: 140px;
      }

      .gauge-svg {
        width: var(--gauge-size);
        height: var(--gauge-size);
      }

      .value-text {
        font-weight: 700;
        fill: var(--ic-text, #f9fafb);
      }

      .trend-up {
        fill: var(--ic-success);
      }

      .trend-down {
        fill: var(--ic-error);
      }

      .trend-flat {
        fill: var(--ic-text-dim);
      }

      .label {
        display: block;
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        margin-top: var(--ic-space-xs);
      }
    `,
  ];

  /** Percentage value from 0 to 100. Clamped internally. */
  @property({ type: Number }) value = 0;

  /** Label text displayed below the gauge. */
  @property() label = "";

  /** Rolling trend: -1 = down, 0 = flat, 1 = up. */
  @property({ type: Number }) trend = 0;

  /** Gauge size variant. */
  @property({ reflect: true }) size: "sm" | "md" | "lg" = "md";

  private _getClampedValue(): number {
    return Math.max(0, Math.min(100, this.value));
  }

  private _getArcColor(): string {
    const v = this._getClampedValue();
    if (v < 60) return "var(--ic-success)";
    if (v <= 80) return "var(--ic-warning)";
    return "var(--ic-error)";
  }

  private _getTrendChar(): string {
    if (this.trend > 0) return "\u2191"; // up arrow
    if (this.trend < 0) return "\u2193"; // down arrow
    return "\u2014"; // em dash (flat)
  }

  private _getTrendClass(): string {
    if (this.trend > 0) return "trend-up";
    if (this.trend < 0) return "trend-down";
    return "trend-flat";
  }

  override render() {
    const clamped = this._getClampedValue();

    // SVG circle parameters
    const cx = 50;
    const cy = 50;
    const r = 42;
    const circumference = 2 * Math.PI * r;
    const arcLength = (clamped / 100) * circumference;
    const dashoffset = circumference - arcLength;

    return html`
      <svg
        class="gauge-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid meet"
      >
        <!-- Background circle -->
        ${svg`
          <circle
            cx=${cx}
            cy=${cy}
            r=${r}
            fill="none"
            stroke="var(--ic-surface-2, #1f2937)"
            stroke-width="8"
          />
        `}
        <!-- Value arc -->
        ${svg`
          <circle
            cx=${cx}
            cy=${cy}
            r=${r}
            fill="none"
            stroke=${this._getArcColor()}
            stroke-width="8"
            stroke-linecap="round"
            stroke-dasharray=${circumference}
            stroke-dashoffset=${dashoffset}
            transform="rotate(-90 ${cx} ${cy})"
            class="value-arc"
          />
        `}
        <!-- Percentage text -->
        ${svg`
          <text
            x=${cx}
            y=${cy - 2}
            text-anchor="middle"
            dominant-baseline="central"
            font-size="18"
            class="value-text"
          >${clamped}%</text>
        `}
        <!-- Trend indicator -->
        ${svg`
          <text
            x=${cx}
            y=${cy + 16}
            text-anchor="middle"
            dominant-baseline="central"
            font-size="12"
            class=${this._getTrendClass()}
          >${this._getTrendChar()}</text>
        `}
      </svg>
      ${this.label ? html`<span class="label">${this.label}</span>` : ""}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-metric-gauge": IcMetricGauge;
  }
}
