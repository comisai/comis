import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import { getHealthVisual, normalizeChannelStatus, showUptime } from "../utils/health-status.js";
import "./display/ic-platform-icon.js";

/**
 * Channel connection badge component.
 *
 * Compact badge showing platform icon, channel name, status dot,
 * uptime display, and click-to-navigate behavior.
 */
@customElement("ic-channel-badge")
export class IcChannelBadge extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: inline-block;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.875rem;
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: 0.5rem;
        font-size: 0.8125rem;
        transition: border-color 0.15s;
        cursor: pointer;
      }

      .badge:hover {
        border-color: var(--ic-border-hover, #374151);
      }

      .badge:focus-visible {
        outline: 2px solid var(--ic-accent);
        outline-offset: 2px;
      }

      .channel-name {
        color: var(--ic-text-muted);
        font-weight: 500;
        text-transform: capitalize;
      }

      .status-dot {
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 50%;
        margin-left: 0.25rem;
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

      .uptime {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      .disabled-label {
        font-size: 0.6875rem;
        color: var(--ic-text-dim);
        margin-left: 0.125rem;
      }
    `,
  ];

  @property({ type: String }) channelType = "";
  @property({ type: String }) name = "";
  @property({ type: String }) status = "disconnected";
  @property({ type: Boolean }) enabled = false;
  @property({ type: Number }) uptime = 0;
  @property({ type: String }) channelId = "";

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

  /** Dispatch navigate event with channel path. */
  private _handleClick(): void {
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: `channels/${this.channelId || this.channelType}`,
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

  override render() {
    const visual = getHealthVisual(this.status);
    const displayName = this.name || this.channelType;
    const shouldShowUptime = this.uptime > 0 && showUptime(normalizeChannelStatus(this.status));

    return html`
      <div
        class="badge"
        role="link"
        tabindex="0"
        @click=${this._handleClick}
        @keydown=${this._handleKeydown}
      >
        <ic-platform-icon .platform=${this.channelType} size="16px"></ic-platform-icon>
        <span class="channel-name">${displayName}</span>
        <span class="status-dot ${visual.pulse ? "pulse" : ""}" style="background: ${visual.color}"></span>
        <span class="status-label" style="font-size: 0.6875rem; color: ${visual.color};">${visual.label}</span>
        ${shouldShowUptime
          ? html`<span class="uptime">${this._formatUptime(this.uptime)}</span>`
          : ""}
        ${!this.enabled
          ? html`<span class="disabled-label">(off)</span>`
          : ""}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-channel-badge": IcChannelBadge;
  }
}
