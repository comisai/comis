import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

// Side-effect import for sparkline rendering
import "./ic-sparkline.js";

/**
 * Metric display card showing a label, value, optional trend indicator,
 * inline sparkline, delta indicator, and threshold coloring.
 *
 * @example
 * ```html
 * <ic-stat-card
 *   label="Active Agents"
 *   value="3/4"
 *   trend="up"
 *   trendValue="+1"
 *   .sparklineData=${[10, 15, 12, 18, 22]}
 *   delta="+12%"
 *   deltaDirection="up"
 *   threshold="warning"
 * ></ic-stat-card>
 * ```
 */
@customElement("ic-stat-card")
export class IcStatCard extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
        min-width: 8rem;
        flex: 1;
      }

      .card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md) var(--ic-space-lg);
      }

      .value-row {
        display: flex;
        align-items: baseline;
        gap: var(--ic-space-sm);
      }

      .value {
        font-size: var(--ic-text-2xl);
        font-weight: 700;
        color: var(--ic-text);
        line-height: 1.2;
      }

      .trend {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        font-size: var(--ic-text-xs);
      }

      .trend--up {
        color: var(--ic-success);
      }

      .trend--down {
        color: var(--ic-error);
      }

      .trend--flat {
        color: var(--ic-text-dim);
      }

      .label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-top: var(--ic-space-xs);
      }

      .card--warning {
        border-left: 3px solid var(--ic-warning);
      }

      .card--critical {
        border-left: 3px solid var(--ic-error);
      }

      .threshold-icon {
        font-size: var(--ic-text-sm);
        flex-shrink: 0;
      }

      .threshold-icon--warning {
        color: var(--ic-warning);
      }

      .threshold-icon--critical {
        color: var(--ic-error);
      }

      /* Delta indicator */
      .delta {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        font-size: var(--ic-text-xs);
        margin-left: auto;
      }

      .delta--up {
        color: var(--ic-success);
      }

      .delta--down {
        color: var(--ic-error);
      }

      .delta--flat {
        color: var(--ic-text-dim);
      }

      /* Sparkline area */
      .sparkline-area {
        margin-top: var(--ic-space-xs);
        width: 100%;
        height: 24px;
      }
    `,
  ];

  /** Metric name (e.g., "Active Agents") */
  @property() label = "";

  /** Metric value (e.g., "3/4", "1,247") */
  @property() value = "";

  /** Trend direction: "up", "down", "flat", or "" (hidden) */
  @property() trend = "";

  /** Trend amount text (e.g., "+12%", "-3") */
  @property() trendValue = "";

  /** Threshold state for color-independent status: "normal", "warning", "critical" */
  @property() threshold: "normal" | "warning" | "critical" = "normal";

  /** Data points for inline sparkline chart. When non-empty, renders a sparkline below the value. */
  @property({ attribute: false }) sparklineData: number[] = [];

  /** Delta text (e.g., "+12%", "-3"). Displayed alongside value. */
  @property() delta = "";

  /** Delta direction: controls arrow icon and color. */
  @property() deltaDirection: "up" | "down" | "flat" = "flat";

  private _renderTrend() {
    if (!this.trend) return nothing;

    const arrows: Record<string, string> = {
      up: "\u2191",
      down: "\u2193",
      flat: "\u2014",
    };

    const arrow = arrows[this.trend] ?? "";
    const cls = `trend trend--${this.trend}`;

    return html`<span class=${cls}>${arrow}${this.trendValue ? ` ${this.trendValue}` : ""}</span>`;
  }

  private _renderDelta() {
    if (!this.delta) return nothing;

    const arrows: Record<string, string> = {
      up: "\u2191",
      down: "\u2193",
      flat: "\u2014",
    };

    const arrow = arrows[this.deltaDirection] ?? "";
    const cls = `delta delta--${this.deltaDirection}`;

    return html`<span class=${cls}>${arrow} ${this.delta}</span>`;
  }

  private _renderThresholdIcon() {
    if (this.threshold === "warning") {
      return html`<span class="threshold-icon threshold-icon--warning" aria-hidden="true">\u26A0</span>`;
    }
    if (this.threshold === "critical") {
      return html`<span class="threshold-icon threshold-icon--critical" aria-hidden="true">\u26D4</span>`;
    }
    return nothing;
  }

  private _renderSparkline() {
    if (this.sparklineData.length === 0) return nothing;

    return html`
      <div class="sparkline-area">
        <ic-sparkline
          .data=${this.sparklineData}
          height=${24}
          color="var(--ic-accent)"
        ></ic-sparkline>
      </div>
    `;
  }

  override render() {
    const cardClass = this.threshold !== "normal" ? `card card--${this.threshold}` : "card";
    const deltaLabel = this.delta ? `, ${this.deltaDirection} ${this.delta}` : "";
    const ariaLabel = this.threshold !== "normal"
      ? `${this.label}: ${this.value}${deltaLabel} (${this.threshold})`
      : `${this.label}: ${this.value}${deltaLabel}`;

    return html`
      <div class=${cardClass} role="group" aria-label=${ariaLabel}>
        <div class="value-row">
          ${this._renderThresholdIcon()}
          <span class="value">${this.value}</span>
          ${this._renderTrend()}
          ${this._renderDelta()}
        </div>
        ${this._renderSparkline()}
        <div class="label">${this.label}</div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-stat-card": IcStatCard;
  }
}
