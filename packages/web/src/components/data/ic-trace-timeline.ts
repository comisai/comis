import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";
import type { DeliveryStep } from "../../api/types/index.js";

export type { DeliveryStep };

/**
 * Format a duration in ms for display: values >= 1000ms show as seconds.
 * Examples: 45 -> "45ms", 1200 -> "1.2s"
 */
function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${ms}ms`;
}

/**
 * Execution trace timeline with waterfall-style duration bars.
 *
 * Each delivery step is rendered as a row with name, a timed bar showing
 * cumulative offset and duration, and a formatted duration label. Creates
 * a waterfall cascade effect where each subsequent bar starts after the
 * previous. Error steps are highlighted and show error text below.
 *
 * @example
 * ```html
 * <ic-trace-timeline
 *   .steps=${[
 *     { name: "receive", durationMs: 12, status: "ok", timestamp: 1000 },
 *     { name: "route", durationMs: 45, status: "ok", timestamp: 1012 },
 *     { name: "execute", durationMs: 500, status: "error", timestamp: 1057, error: "Timeout" },
 *   ]}
 * ></ic-trace-timeline>
 * ```
 */
@customElement("ic-trace-timeline")
export class IcTraceTimeline extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .step-row {
        display: grid;
        grid-template-columns: 140px 1fr 60px;
        align-items: center;
        gap: var(--ic-space-sm);
        padding: 2px 0;
      }

      .step-name {
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
        border-radius: var(--ic-radius-sm, 4px);
        min-width: 2px;
        transition: width var(--ic-transition, 150ms ease),
          left var(--ic-transition, 150ms ease);
      }

      .fill--ok {
        background: var(--ic-success);
      }

      .fill--error {
        background: var(--ic-error);
      }

      .duration {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        text-align: right;
      }

      .error-text {
        grid-column: 1 / -1;
        font-size: var(--ic-text-xs);
        color: var(--ic-error);
        padding-left: 140px;
        padding-bottom: 2px;
      }

      .empty {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-dim);
        font-style: italic;
      }
    `,
  ];

  /** Array of delivery steps to display. */
  @property({ attribute: false }) steps: DeliveryStep[] = [];

  /** Explicit total duration in ms. If 0, computed from sum of step durations. */
  @property({ type: Number }) totalDurationMs = 0;

  private _getTotalDuration(): number {
    if (this.totalDurationMs > 0) return this.totalDurationMs;
    return this.steps.reduce((sum, s) => sum + s.durationMs, 0);
  }

  override render() {
    if (this.steps.length === 0) {
      return html`<div class="empty">No trace steps available</div>`;
    }

    const total = this._getTotalDuration();
    let cumulativeMs = 0;

    return html`
      ${this.steps.map((step) => {
        const offsetPct = total > 0 ? (cumulativeMs / total) * 100 : 0;
        const widthPct = total > 0 ? (step.durationMs / total) * 100 : 0;
        cumulativeMs += step.durationMs;

        return html`
          <div class="step-row">
            <span class="step-name" title="${step.name}">${step.name}</span>
            <div class="track">
              <div
                class="fill fill--${step.status}"
                style="left: ${offsetPct}%; width: ${widthPct}%;"
                title="${step.name}: ${formatDuration(step.durationMs)}"
              ></div>
            </div>
            <span class="duration">${formatDuration(step.durationMs)}</span>
          </div>
          ${step.error
            ? html`<div class="error-text">${step.error}</div>`
            : ""}
        `;
      })}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-trace-timeline": IcTraceTimeline;
  }
}
