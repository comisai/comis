// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import { getHealthVisual, normalizeChannelStatus, showUptime } from "../utils/health-status.js";
import "./display/ic-platform-icon.js";

/**
 * Channel connection card component.
 *
 * Displays a channel's platform icon, connection status, metrics
 * (messages, uptime), stale warning, and action buttons.
 *
 * @fires channel-action - Dispatched when an action button is clicked, with detail { action, channelType }
 */
@customElement("ic-channel-card")
export class IcChannelCard extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
        min-width: 280px;
      }

      .card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: 0.75rem;
        padding: 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        transition: border-color 0.15s;
      }

      .card:hover {
        border-color: var(--ic-border-hover, #374151);
      }

      .card-header {
        display: flex;
        align-items: center;
        gap: 0.625rem;
      }

      .channel-name {
        font-size: 1rem;
        font-weight: 600;
        color: var(--ic-text);
        flex: 1;
        text-transform: capitalize;
      }

      .status-dot {
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .status-dot.pulse {
        animation: pulse 2s ease-in-out infinite;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }

      @media (prefers-reduced-motion: reduce) {
        .status-dot.pulse { animation: none; }
      }

      .metrics {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
      }

      .metric-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 0.8125rem;
      }

      .metric-label {
        color: var(--ic-text-dim);
      }

      .metric-value {
        color: var(--ic-text-muted);
        font-family: ui-monospace, monospace;
        font-size: 0.75rem;
      }

      .stale-warning {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.375rem 0.625rem;
        background: var(--ic-warning)0d;
        border: 1px solid var(--ic-warning)33;
        border-radius: 0.375rem;
        font-size: 0.75rem;
        color: var(--ic-warning);
      }

      .card-actions {
        display: flex;
        gap: 0.5rem;
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
    `,
  ];

  @property({ type: String }) channelType = "";
  @property({ type: String }) name = "";
  @property({ type: String }) status = "disconnected";
  @property({ type: Boolean }) enabled = false;
  @property({ type: Boolean }) isStale = false;
  @property({ type: Number }) messageCount = 0;
  @property({ type: Number }) uptime = 0;
  @property({ type: Number }) lastActivity = 0;

  /** Format uptime in seconds to human-readable: "14d 3h", "5h", "23m". */
  private _formatUptime(seconds: number): string {
    if (seconds < 60) return "0m";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h`;
    return `${minutes}m`;
  }

  /** Format relative time for stale warning. */
  private _formatTimeAgo(epochMs: number): string {
    if (epochMs <= 0) return "unknown";
    const diffMs = Date.now() - epochMs;
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    return `${diffDays}d ago`;
  }

  /** Get health visual based on status and stale flag. */
  private _getHealthVisual() {
    if (this.isStale) return getHealthVisual("stale");
    return getHealthVisual(this.status);
  }

  /** Dispatch channel-action event. */
  private _handleAction(action: string, e: Event): void {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("channel-action", {
        detail: { action, channelType: this.channelType },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const displayName = this.name || this.channelType || "Unknown";
    const visual = this._getHealthVisual();
    const shouldShowUptime = this.uptime > 0 && showUptime(normalizeChannelStatus(this.status));
    const formatter = new Intl.NumberFormat("en-US");

    return html`
      <div class="card" role="group" aria-label="${displayName} channel - ${visual.label}">
        <div class="card-header">
          <ic-platform-icon .platform=${this.channelType} size="20px"></ic-platform-icon>
          <span class="channel-name">${displayName}</span>
          <span
            class="status-dot ${visual.pulse ? "pulse" : ""}"
            style="background: ${visual.color}"
            role="status"
            aria-label="Status: ${visual.label}"
          ></span>
          <span class="status-text" style="font-size: 0.75rem; color: ${visual.color};">${visual.label}</span>
        </div>

        <div class="metrics">
          <div class="metric-row">
            <span class="metric-label">Messages</span>
            <span class="metric-value">${formatter.format(this.messageCount)}</span>
          </div>
          ${shouldShowUptime
            ? html`
                <div class="metric-row">
                  <span class="metric-label">Uptime</span>
                  <span class="metric-value">${this._formatUptime(this.uptime)}</span>
                </div>
              `
            : nothing}
        </div>

        ${this.isStale && this.lastActivity > 0
          ? html`
              <div class="stale-warning">
                Last seen ${this._formatTimeAgo(this.lastActivity)}
              </div>
            `
          : nothing}

        <div class="card-actions">
          ${this.enabled
            ? html`
                <button
                  class="action-btn"
                  aria-label="Configure ${displayName}"
                  @click=${(e: Event) => this._handleAction("configure", e)}
                >Configure</button>
                <button
                  class="action-btn"
                  aria-label="Restart ${displayName}"
                  @click=${(e: Event) => this._handleAction("restart", e)}
                >Restart</button>
              `
            : html`
                <button
                  class="action-btn"
                  aria-label="Enable ${displayName}"
                  @click=${(e: Event) => this._handleAction("enable", e)}
                >Enable</button>
              `}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-channel-card": IcChannelCard;
  }
}
