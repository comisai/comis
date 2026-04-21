// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { ConnectionStatus } from "../../api/types/index.js";

/**
 * Top bar component for the Comis operator console.
 *
 * Displays connection status dot (green/yellow/red), notification bell
 * with badge count, user menu with logout action, and a hamburger button
 * for mobile sidebar toggle.
 *
 * The notification area is wrapped in `role="complementary"` with
 * `aria-label="System status"` to satisfy the third ARIA landmark
 * requirement (navigation + main + complementary).
 *
 * Fires:
 * - `toggle-sidebar` (CustomEvent) when hamburger is clicked
 * - `logout` (CustomEvent) when user menu logout is clicked
 */
@customElement("ic-topbar")
export class IcTopbar extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .topbar {
        display: flex;
        align-items: center;
        height: 48px;
        padding: 0 var(--ic-space-md);
        background: var(--ic-surface);
        border-bottom: 1px solid var(--ic-border);
      }

      .hamburger {
        display: none;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        margin-right: var(--ic-space-sm);
        background: none;
        border: none;
        color: var(--ic-text-muted);
        cursor: pointer;
        font-size: 18px;
      }

      .hamburger:hover {
        color: var(--ic-text);
      }

      @media (max-width: 767px) {
        .hamburger {
          display: flex;
        }
      }

      .brand {
        font-size: 1.125rem;
        font-weight: 700;
        color: var(--ic-text);
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
      }

      .brand-icon {
        width: 80px;
        height: 32px;
        object-fit: contain;
      }

      .spacer {
        flex: 1;
      }

      .status-area {
        display: flex;
        align-items: center;
        gap: var(--ic-space-md);
      }

      /* Connection status */
      .connection {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
      }

      .connection-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .connection-dot.connected {
        background: var(--ic-success);
      }

      .connection-dot.reconnecting {
        background: var(--ic-warning);
        animation: pulse 1.5s ease-in-out infinite;
      }

      .connection-dot.disconnected {
        background: var(--ic-error);
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }

      .connection-text {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      /* Notification bell */
      .bell-btn {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        background: none;
        border: none;
        color: var(--ic-text-muted);
        cursor: pointer;
        font-size: 16px;
      }

      .bell-btn:hover {
        color: var(--ic-text);
      }

      .bell-badge {
        position: absolute;
        top: 2px;
        right: 2px;
        min-width: 14px;
        height: 14px;
        padding: 0 3px;
        border-radius: 7px;
        font-size: 10px;
        font-weight: 600;
        color: white;
        background: var(--ic-error);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      /* User menu */
      .user-menu {
        position: relative;
      }

      .avatar-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        border-radius: 50%;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        color: var(--ic-text-muted);
        cursor: pointer;
        font-family: inherit;
        font-size: var(--ic-text-xs);
        font-weight: 600;
      }

      .avatar-btn:hover {
        border-color: var(--ic-accent);
        color: var(--ic-text);
      }

      .dropdown {
        position: absolute;
        top: 100%;
        right: 0;
        margin-top: var(--ic-space-xs);
        min-width: 180px;
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        box-shadow: var(--ic-shadow-lg);
        z-index: 100;
        padding: var(--ic-space-sm) 0;
      }

      .dropdown-info {
        padding: var(--ic-space-sm) var(--ic-space-md);
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .dropdown-divider {
        height: 1px;
        background: var(--ic-border);
        margin: var(--ic-space-xs) 0;
      }

      .dropdown-action {
        display: block;
        width: 100%;
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: none;
        border: none;
        color: var(--ic-text-muted);
        cursor: pointer;
        font-family: inherit;
        font-size: var(--ic-text-sm);
        text-align: left;
      }

      .dropdown-action:hover {
        background: var(--ic-surface-2);
        color: var(--ic-error);
      }
    `,
  ];

  /** WebSocket connection status */
  @property() connectionStatus: ConnectionStatus = "disconnected";

  /** Number of unread notifications for bell badge */
  @property({ type: Number }) notificationCount = 0;

  /** Whether the sidebar is collapsed (affects hamburger display logic) */
  @property({ type: Boolean }) sidebarCollapsed = false;

  /** Token ID for user avatar (first 2 chars shown) */
  @property() tokenId = "";

  /** Whether the user menu dropdown is open */
  @state() private _menuOpen = false;

  private _boundCloseMenu = this._closeMenuOnOutsideClick.bind(this);

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this._boundCloseMenu);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("click", this._boundCloseMenu);
  }

  private _closeMenuOnOutsideClick(e: Event): void {
    // Close dropdown when clicking outside
    const path = e.composedPath();
    if (this._menuOpen && !path.includes(this)) {
      this._menuOpen = false;
    }
  }

  private _toggleSidebar(): void {
    this.dispatchEvent(new CustomEvent("toggle-sidebar"));
  }

  private _toggleMenu(): void {
    this._menuOpen = !this._menuOpen;
  }

  private _logout(): void {
    this._menuOpen = false;
    this.dispatchEvent(new CustomEvent("logout"));
  }

  private _getAvatarText(): string {
    if (this.tokenId && this.tokenId.length >= 2) {
      return this.tokenId.slice(0, 2).toUpperCase();
    }
    return "OP";
  }

  private _getStatusText(): string {
    switch (this.connectionStatus) {
      case "connected":
        return "Connected";
      case "reconnecting":
        return "Reconnecting";
      case "disconnected":
        return "Disconnected";
      default:
        return "Unknown";
    }
  }

  override render() {
    return html`
      <div class="topbar">
        <button
          class="hamburger"
          @click=${this._toggleSidebar}
          aria-label="Toggle navigation"
        >
          \u2630
        </button>
        <div class="brand">
          <img class="brand-icon" src="${import.meta.env.BASE_URL}comis-logo.png" alt="Comis" />
        </div>
        <div class="spacer"></div>
        <aside role="complementary" aria-label="System status">
          <div class="status-area">
            <div class="connection" aria-live="polite">
              <span class="connection-dot ${this.connectionStatus}"></span>
              <span class="connection-text">${this._getStatusText()}</span>
            </div>
            <button
              class="bell-btn"
              aria-label="Notifications${this.notificationCount > 0 ? `, ${this.notificationCount} pending` : ""}"
            >
              \u{1F514}
              ${this.notificationCount > 0
                ? html`<span class="bell-badge">${this.notificationCount}</span>`
                : nothing}
            </button>
            <div class="user-menu">
              <button
                class="avatar-btn"
                @click=${this._toggleMenu}
                aria-label="User menu"
                aria-expanded=${this._menuOpen}
              >
                ${this._getAvatarText()}
              </button>
              ${this._menuOpen
                ? html`
                    <div class="dropdown">
                      <div class="dropdown-info">
                        ${this.tokenId
                          ? `${this.tokenId.slice(0, 6)}${"*".repeat(Math.min(8, Math.max(0, this.tokenId.length - 10)))}${this.tokenId.length > 10 ? this.tokenId.slice(-4) : ""}`
                          : "Operator"}
                      </div>
                      <div class="dropdown-divider"></div>
                      <button
                        class="dropdown-action"
                        @click=${this._logout}
                      >
                        Logout
                      </button>
                    </div>
                  `
                : nothing}
            </div>
          </div>
        </aside>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-topbar": IcTopbar;
  }
}
