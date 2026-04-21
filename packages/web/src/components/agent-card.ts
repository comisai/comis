// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";

/** Status color mapping using design tokens */
const STATUS_COLORS: Record<string, string> = {
  active: "var(--ic-success)",
  idle: "var(--ic-warning)",
  suspended: "var(--ic-text-dim)",
  error: "var(--ic-error)",
  unknown: "var(--ic-text-dim)",
};

/** Currency formatter for USD display */
const currencyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/**
 * Agent status card component.
 *
 * Displays an agent's name, provider, model, status with color coding,
 * message/token counts, cost, budget utilization, and action buttons.
 * Used on the dashboard and agent list to show at-a-glance agent state.
 *
 * @fires navigate - Dispatched when user clicks the card body
 * @fires agent-action - Dispatched when an action button is clicked, with detail { action, agentId }
 */
@customElement("ic-agent-card")
export class IcAgentCard extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: 0.75rem;
        padding: 1.25rem;
        transition: border-color 0.15s;
        cursor: pointer;
        display: flex;
        flex-direction: column;
      }

      .card:hover {
        border-color: var(--ic-border-hover, #374151);
      }

      .card:focus-visible {
        outline: 2px solid var(--ic-accent);
        outline-offset: 2px;
      }

      .card--suspended {
        opacity: 0.65;
      }

      .card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 0.75rem;
      }

      .agent-name {
        font-size: 1rem;
        font-weight: 600;
        color: var(--ic-text);
      }

      .status-badge {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.25rem 0.625rem;
        border-radius: 9999px;
        font-size: 0.75rem;
        font-weight: 500;
        text-transform: capitalize;
      }

      .status-dot {
        width: 0.375rem;
        height: 0.375rem;
        border-radius: 50%;
      }

      .card-details {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
        flex: 1;
      }

      .detail-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 0.8125rem;
      }

      .detail-label {
        color: var(--ic-text-dim);
      }

      .detail-value {
        color: var(--ic-text-muted);
        font-family: ui-monospace, monospace;
        font-size: 0.75rem;
      }

      .budget-bar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }

      .budget-track {
        flex: 1;
        height: 4px;
        background: var(--ic-surface-2, #1f2937);
        border-radius: 2px;
        overflow: hidden;
        min-width: 40px;
      }

      .budget-fill {
        height: 100%;
        border-radius: 2px;
        transition: width 0.3s;
      }

      .budget-pct {
        font-family: ui-monospace, monospace;
        font-size: 0.75rem;
        color: var(--ic-text-muted);
        min-width: 2.5rem;
        text-align: right;
      }

      .card-actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 0.75rem;
        padding-top: 0.75rem;
        border-top: 1px solid var(--ic-border);
      }

      .action-btn {
        flex: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.375rem 0.5rem;
        background: transparent;
        border: 1px solid var(--ic-border);
        border-radius: 0.375rem;
        color: var(--ic-text-dim);
        font-size: 0.75rem;
        font-family: inherit;
        cursor: pointer;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
      }

      .action-btn:hover {
        background: var(--ic-surface-2, #1f2937);
        color: var(--ic-text);
        border-color: var(--ic-text-dim);
      }

      .action-btn--danger:hover {
        color: var(--ic-error, #f87171);
        border-color: var(--ic-error, #f87171);
      }
    `,
  ];

  @property({ type: String }) name = "";
  @property({ type: String }) provider = "";
  @property({ type: String }) model = "";
  @property({ type: String }) status = "unknown";
  @property({ type: String }) agentId = "";
  @property({ type: Number }) messagesToday = 0;
  @property({ type: Number }) tokenUsageToday = 0;
  @property({ type: Number }) costToday = 0;
  @property({ type: Number }) budgetUtilization = 0;
  @property({ type: Boolean }) suspended = false;

  /** Format token count with abbreviation (e.g., 612000 -> "612K", 1200000 -> "1.2M"). */
  private _formatTokens(n: number): string {
    if (n >= 1_000_000) {
      const m = n / 1_000_000;
      return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
    }
    if (n >= 1_000) {
      const k = n / 1_000;
      return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`;
    }
    return String(n);
  }

  /** Get budget bar color based on utilization percentage. */
  private _budgetColor(pct: number): string {
    if (pct >= 90) return "var(--ic-error)";
    if (pct >= 70) return "var(--ic-warning)";
    return "var(--ic-success)";
  }

  /** Dispatch navigate event with agent path. */
  private _handleClick(): void {
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: `agents/${this.agentId || this.name}`,
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Handle keyboard navigation for accessibility. */
  private _handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this._handleClick();
    }
  }

  /** Dispatch agent-action event. Stops propagation to prevent card click. */
  private _handleAction(action: string, e: Event): void {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("agent-action", {
        detail: { action, agentId: this.agentId || this.name },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const displayStatus = this.suspended ? "suspended" : this.status;
    const statusColor = STATUS_COLORS[displayStatus] ?? STATUS_COLORS["unknown"];
    const bgOpacity = displayStatus === "active" ? "1a" : "0d";
    const showMetrics = this.messagesToday > 0 || this.tokenUsageToday > 0;
    const formatter = new Intl.NumberFormat("en-US");
    const showCost = this.costToday > 0;
    const showBudget = this.budgetUtilization > 0;
    const budgetPct = Math.min(100, Math.max(0, this.budgetUtilization));

    return html`
      <div
        class="card ${this.suspended ? "card--suspended" : ""}"
        role="link"
        tabindex="0"
        @click=${this._handleClick}
        @keydown=${this._handleKeydown}
      >
        <div class="card-header">
          <span class="agent-name">${this.name || "Unnamed Agent"}</span>
          <span
            class="status-badge"
            style="background: ${statusColor}${bgOpacity}; color: ${statusColor}"
          >
            <span class="status-dot" style="background: ${statusColor}"></span>
            ${displayStatus}
          </span>
        </div>

        <div class="card-details">
          <div class="detail-row">
            <span class="detail-label">Provider</span>
            <span class="detail-value">${this.provider || "---"}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Model</span>
            <span class="detail-value">${this.model || "---"}</span>
          </div>
          ${showMetrics
            ? html`
                <div class="detail-row">
                  <span class="detail-label">Messages</span>
                  <span class="detail-value">${formatter.format(this.messagesToday)}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Tokens</span>
                  <span class="detail-value">${this._formatTokens(this.tokenUsageToday)}</span>
                </div>
              `
            : ""}
          ${showCost
            ? html`
                <div class="detail-row">
                  <span class="detail-label">Cost Today</span>
                  <span class="detail-value">${currencyFmt.format(this.costToday)}</span>
                </div>
              `
            : nothing}
          ${showBudget
            ? html`
                <div class="detail-row">
                  <span class="detail-label">Budget</span>
                  <div class="budget-bar">
                    <div class="budget-track">
                      <div
                        class="budget-fill"
                        style="width: ${budgetPct}%; background: ${this._budgetColor(budgetPct)}"
                      ></div>
                    </div>
                    <span class="budget-pct">${budgetPct}%</span>
                  </div>
                </div>
              `
            : nothing}
        </div>

        <div class="card-actions">
          <button
            class="action-btn"
            aria-label="Configure ${this.name || 'agent'}"
            @click=${(e: Event) => this._handleAction("configure", e)}
          >Configure</button>
          ${this.suspended
            ? html`<button
                class="action-btn"
                aria-label="Resume ${this.name || 'agent'}"
                @click=${(e: Event) => this._handleAction("resume", e)}
              >Resume</button>`
            : html`<button
                class="action-btn"
                aria-label="Suspend ${this.name || 'agent'}"
                @click=${(e: Event) => this._handleAction("suspend", e)}
              >Suspend</button>`}
          <button
            class="action-btn action-btn--danger"
            aria-label="Delete ${this.name || 'agent'}"
            @click=${(e: Event) => this._handleAction("delete", e)}
          >Delete</button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-agent-card": IcAgentCard;
  }
}
