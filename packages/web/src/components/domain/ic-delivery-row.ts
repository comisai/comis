// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing, svg } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { DeliveryTrace } from "../../api/types/index.js";

// Side-effect imports to register child elements
import "../data/ic-tag.js";
import "../data/ic-relative-time.js";

/** Inline SVG path for success checkmark. */
const SUCCESS_ICON = svg`<path d="M20 6L9 17l-5-5" stroke="var(--ic-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;

/** Inline SVG path for an execution or delivery error. */
const ERROR_ICON = svg`<path d="M18 6L6 18M6 6l12 12" stroke="var(--ic-error)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;

/** Inline SVG path for timeout clock. */
const TIMEOUT_ICON = svg`<circle cx="12" cy="12" r="10" stroke="var(--ic-warning)" stroke-width="2" fill="none"/><path d="M12 6v6l4 2" stroke="var(--ic-warning)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;

/** Inline SVG path for policy-filtered responses. */
const FILTERED_ICON = svg`<path d="M4 5h16l-6 7v5l-4 2v-7L4 5z" stroke="var(--ic-text-dim)" stroke-width="2" stroke-linejoin="round" fill="none"/>`;

/** Inline SVG path for user-aborted responses. */
const ABORTED_ICON = svg`<circle cx="12" cy="12" r="10" stroke="var(--ic-warning)" stroke-width="2" fill="none"/><path d="M8 8l8 8" stroke="var(--ic-warning)" stroke-width="2" stroke-linecap="round"/>`;

/**
 * Renders a single delivery trace row in a CSS Grid table.
 *
 * 6 columns: Time, Destination, Trace, Status, Latency, Steps.
 * Uses `display: contents` for grid row with ARIA role="row".
 * Dispatches `trace-click` CustomEvent on click or Enter/Space keydown.
 */
@customElement("ic-delivery-row")
export class IcDeliveryRow extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: contents;
      }

      .row {
        display: contents;
        cursor: pointer;
      }

      .row:hover .cell {
        background: var(--ic-surface-2, #1f2937);
      }

      .cell {
        padding: var(--ic-space-xs) var(--ic-space-sm);
        display: flex;
        align-items: center;
        font-size: var(--ic-text-sm);
        border-bottom: 1px solid var(--ic-border);
        transition: background var(--ic-transition);
      }

      .cell-trace {
        color: var(--ic-text-dim);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 20rem;
      }

      .cell-latency {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
      }

      .status-icon {
        width: 20px;
        height: 20px;
        flex-shrink: 0;
      }
    `,
  ];

  /** The delivery trace data to render. */
  @property({ attribute: false }) trace: DeliveryTrace | null = null;

  private _handleClick(): void {
    if (!this.trace) return;
    this.dispatchEvent(
      new CustomEvent("trace-click", {
        detail: this.trace.traceId,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _handleKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this._handleClick();
    }
  }

  private _renderStatusIcon() {
    if (!this.trace) return nothing;

    const statusMap: Record<DeliveryTrace["status"], { icon: unknown; label: string }> = {
      success: { icon: SUCCESS_ICON, label: "Success" },
      error: { icon: ERROR_ICON, label: "Error" },
      timeout: { icon: TIMEOUT_ICON, label: "Timeout" },
      filtered: { icon: FILTERED_ICON, label: "Filtered" },
      aborted: { icon: ABORTED_ICON, label: "Aborted" },
    };

    const entry = statusMap[this.trace.status];

    return html`
      <svg
        class="status-icon"
        viewBox="0 0 24 24"
        aria-label=${entry.label}
        role="img"
      >${entry.icon}</svg>
    `;
  }

  override render() {
    if (!this.trace) return nothing;

    const t = this.trace;
    const traceId = t.traceId.length > 40
      ? t.traceId.slice(0, 40) + "..."
      : t.traceId;
    const latency = t.latencyMs != null ? `${t.latencyMs}ms` : "--";

    return html`
      <div
        class="row"
        role="row"
        tabindex="0"
        @click=${this._handleClick}
        @keydown=${this._handleKeyDown}
      >
        <div class="cell" role="cell">
          <ic-relative-time .timestamp=${t.timestamp}></ic-relative-time>
        </div>
        <div class="cell" role="cell">
          <ic-tag variant=${t.targetChannelType}>${t.targetChannelType}</ic-tag>
        </div>
        <div class="cell cell-trace" role="cell">${traceId}</div>
        <div class="cell" role="cell">${this._renderStatusIcon()}</div>
        <div class="cell cell-latency" role="cell">${latency}</div>
        <div class="cell" role="cell">${t.stepCount}</div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-delivery-row": IcDeliveryRow;
  }
}
