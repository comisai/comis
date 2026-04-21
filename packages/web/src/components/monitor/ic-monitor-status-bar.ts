// SPDX-License-Identifier: Apache-2.0
/**
 * Status bar for the execution monitor view.
 *
 * Displays aggregate execution information at the top of the monitor:
 * status badge (color-coded), elapsed time, node progress, tokens/cost,
 * and a cancel button. The cancel button is hidden when the graph reaches
 * a terminal state.
 *
 * Events dispatched:
 *   - `cancel` (CustomEvent, bubbles: true, composed: true) -- user requests
 *     pipeline cancellation.
 *   - `view-outputs` (CustomEvent, bubbles: true, composed: true) -- user requests
 *     graph outputs display (only dispatched when terminal).
 */

import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("ic-monitor-status-bar")
export class IcMonitorStatusBar extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .bar {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: var(--ic-surface);
        border-bottom: 1px solid var(--ic-border);
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        flex-wrap: wrap;
      }

      /* Status badge pills */
      .status-badge {
        display: inline-flex;
        align-items: center;
        padding: 2px 10px;
        border-radius: 9999px;
        font-weight: 600;
        font-size: var(--ic-text-xs);
        text-transform: capitalize;
        line-height: 1.4;
      }
      .status-badge--running {
        background: color-mix(in srgb, var(--ic-info, #06b6d4) 20%, transparent);
        color: var(--ic-info, #06b6d4);
      }
      .status-badge--completed {
        background: color-mix(in srgb, var(--ic-success, #22c55e) 20%, transparent);
        color: var(--ic-success, #22c55e);
      }
      .status-badge--failed {
        background: color-mix(in srgb, var(--ic-error, #ef4444) 20%, transparent);
        color: var(--ic-error, #ef4444);
      }
      .status-badge--cancelled {
        background: color-mix(in srgb, var(--ic-warning, #eab308) 20%, transparent);
        color: var(--ic-warning, #eab308);
      }

      .elapsed,
      .progress,
      .tokens {
        font-variant-numeric: tabular-nums;
        color: var(--ic-text-muted);
      }

      .cancel-btn {
        margin-left: auto;
        padding: 4px 12px;
        border-radius: var(--ic-radius-sm);
        border: 1px solid var(--ic-error, #ef4444);
        background: color-mix(in srgb, var(--ic-error) 15%, transparent);
        color: var(--ic-error, #ef4444);
        font-size: var(--ic-text-xs);
        font-weight: 600;
        cursor: pointer;
        transition: background var(--ic-transition);
      }
      .cancel-btn:hover {
        background: color-mix(in srgb, var(--ic-error) 25%, transparent);
      }
      .cancel-btn:focus-visible {
        outline: 2px solid var(--ic-accent);
        outline-offset: 2px;
      }

      .outputs-btn {
        margin-left: auto;
        padding: 4px 12px;
        border: 1px solid color-mix(in srgb, var(--ic-accent, #3b82f6) 30%, transparent);
        border-radius: var(--ic-radius-sm);
        background: color-mix(in srgb, var(--ic-accent, #3b82f6) 10%, transparent);
        color: var(--ic-accent, #3b82f6);
        font-size: var(--ic-text-xs);
        font-weight: 600;
        cursor: pointer;
        transition: background var(--ic-transition);
      }
      .outputs-btn:hover {
        background: color-mix(in srgb, var(--ic-accent, #3b82f6) 20%, transparent);
      }
      .outputs-btn:focus-visible {
        outline: 2px solid var(--ic-accent);
        outline-offset: 2px;
      }
    `,
  ];

  // -- Properties -----------------------------------------------------------

  /** Current graph execution status. */
  @property()
  graphStatus: string = "running";

  /** Whether the graph has reached a terminal state. */
  @property({ type: Boolean })
  isTerminal = false;

  /** Elapsed execution time in milliseconds. */
  @property({ type: Number })
  elapsedMs = 0;

  /** Node execution stats. */
  @property({ attribute: false })
  stats: {
    total: number;
    completed: number;
    failed: number;
    skipped: number;
    running: number;
    pending: number;
  } = { total: 0, completed: 0, failed: 0, skipped: 0, running: 0, pending: 0 };

  // -- Render ---------------------------------------------------------------

  override render() {
    const badgeClass = `status-badge status-badge--${this.graphStatus}`;

    return html`
      <div class="bar">
        <span class=${badgeClass} role="status">${this.graphStatus}</span>
        <span class="elapsed">${this._formatElapsed(this.elapsedMs)}</span>
        <span class="progress">${this.stats.completed}/${this.stats.total} nodes complete</span>
        <span class="tokens">N/A</span>
        ${this.isTerminal
          ? html`
              <button
                class="outputs-btn"
                aria-label="View graph outputs"
                @click=${this._onViewOutputs}
              >View Outputs</button>
            `
          : html`
              <button
                class="cancel-btn"
                aria-label="Cancel pipeline execution"
                @click=${this._onCancel}
              >Cancel</button>
            `}
      </div>
    `;
  }

  // -- Helpers --------------------------------------------------------------

  /** Format elapsed milliseconds into human-readable "Xm YYs" or "Xs". */
  private _formatElapsed(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes > 0) {
      return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    }
    return `${seconds}s`;
  }

  /** Dispatch cancel event. */
  private _onCancel(): void {
    this.dispatchEvent(
      new CustomEvent("cancel", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Dispatch view-outputs event. */
  private _onViewOutputs(): void {
    this.dispatchEvent(
      new CustomEvent("view-outputs", {
        bubbles: true,
        composed: true,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-monitor-status-bar": IcMonitorStatusBar;
  }
}
