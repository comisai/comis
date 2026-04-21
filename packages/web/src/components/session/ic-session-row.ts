// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";
import type { SessionInfo } from "../../api/types/index.js";
import {
  parseSessionKeyString,
  formatSessionDisplayName,
  computeSessionStatus,
} from "../../utils/session-key-parser.js";

// Side-effect imports to register child custom elements
import "../data/ic-tag.js";
import "../data/ic-relative-time.js";

/** Status color map for the activity dot. */
const STATUS_COLORS: Record<string, string> = {
  active: "var(--ic-success, #22c55e)",
  idle: "var(--ic-warning, #eab308)",
  expired: "var(--ic-text-dim, #6b7280)",
};

/**
 * Session row component with human-readable key display.
 *
 * Parses the raw session key into a user-friendly label with channel
 * and agent tags, status indicator, message count, and relative time.
 *
 * @fires session-click - CustomEvent<SessionInfo> when the row is clicked
 *
 * @example
 * ```html
 * <ic-session-row
 *   .session=${sessionInfo}
 *   @session-click=${handleClick}
 * ></ic-session-row>
 * ```
 */
@customElement("ic-session-row")
export class IcSessionRow extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .row {
        display: flex;
        align-items: center;
        gap: var(--ic-space-md, 0.75rem);
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        border-radius: var(--ic-radius-md, 0.5rem);
        cursor: pointer;
        transition: background var(--ic-transition, 150ms ease);
      }

      .row:hover {
        background: var(--ic-surface-2, #1f2937);
      }

      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .info {
        flex: 1;
        min-width: 0;
      }

      .display-name {
        font-weight: 600;
        font-size: var(--ic-text-sm, 0.875rem);
        color: var(--ic-text, #f3f4f6);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .tags {
        display: flex;
        gap: var(--ic-space-xs, 0.25rem);
        margin-top: 2px;
      }

      .meta {
        display: flex;
        align-items: center;
        gap: var(--ic-space-md, 0.75rem);
        flex-shrink: 0;
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-dim, #6b7280);
      }

      .msg-count {
        white-space: nowrap;
      }
    `,
  ];

  /** Session data to display in this row. */
  @property({ attribute: false }) session: SessionInfo | null = null;

  private _handleClick(): void {
    if (!this.session) return;
    this.dispatchEvent(
      new CustomEvent("session-click", {
        detail: this.session,
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    if (!this.session) return nothing;

    const s = this.session;
    const parsed = parseSessionKeyString(s.key);
    const displayName = parsed
      ? formatSessionDisplayName(parsed)
      : s.key.length > 15
        ? s.key.slice(0, 12) + "..."
        : s.key;

    const status = computeSessionStatus(s.lastActiveAt);
    const statusColor = STATUS_COLORS[status] ?? STATUS_COLORS.expired;
    const channelLabel = parsed?.channelId ?? s.channelType;
    const agentLabel = parsed?.agentId ?? s.agentId;

    return html`
      <div class="row" @click=${this._handleClick} role="button" tabindex="0" aria-label="Session ${displayName}">
        <div class="status-dot" style="background: ${statusColor}" title="${status}"></div>
        <div class="info">
          <div class="display-name" title="${s.key}">${displayName}</div>
          <div class="tags">
            <ic-tag variant=${s.channelType}>${channelLabel}</ic-tag>
            ${agentLabel ? html`<ic-tag>${agentLabel}</ic-tag>` : nothing}
          </div>
        </div>
        <div class="meta">
          <span class="msg-count">${s.messageCount} msgs</span>
          <ic-relative-time .timestamp=${s.lastActiveAt}></ic-relative-time>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-session-row": IcSessionRow;
  }
}
