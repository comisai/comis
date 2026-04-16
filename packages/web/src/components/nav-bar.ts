// DEPRECATED: Replaced by ic-sidebar + ic-topbar.
// This file is retained for backward compatibility with existing tests.
// Remove when tests are updated.
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

/** Navigation links configuration */
const NAV_LINKS = [
  { route: "dashboard", label: "Dashboard", icon: "\u25A3" },
  { route: "chat", label: "Chat", icon: "\u25AC" },
  { route: "memory", label: "Memory", icon: "\u25C9" },
] as const;

/**
 * Navigation bar component for the Comis dashboard.
 *
 * Displays a horizontal header with links to Dashboard, Chat, and Memory views,
 * highlights the active route, and provides a logout action.
 *
 * Fires:
 * - `navigate` (CustomEvent<string>) when a nav link is clicked
 * - `logout` (CustomEvent) when logout is clicked
 */
@customElement("ic-nav-bar")
export class IcNavBar extends LitElement {
  static override styles = css`
    :host {
      display: block;
      background: #111827;
      border-bottom: 1px solid #1f2937;
    }

    nav {
      display: flex;
      align-items: center;
      padding: 0 1.5rem;
      height: 3.5rem;
      max-width: 80rem;
      margin: 0 auto;
      width: 100%;
      box-sizing: border-box;
    }

    .brand {
      font-size: 1.125rem;
      font-weight: 700;
      color: #f3f4f6;
      margin-right: 2rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .brand-icon {
      color: #3b82f6;
    }

    .nav-links {
      display: flex;
      gap: 0.25rem;
      flex: 1;
    }

    .nav-link {
      padding: 0.5rem 0.75rem;
      border-radius: 0.375rem;
      font-size: 0.875rem;
      color: #9ca3af;
      cursor: pointer;
      background: none;
      border: none;
      font-family: inherit;
      display: flex;
      align-items: center;
      gap: 0.375rem;
      transition:
        color 0.15s,
        background 0.15s;
    }

    .nav-link:hover {
      color: #f3f4f6;
      background: #1f2937;
    }

    .nav-link[data-active] {
      color: #3b82f6;
      background: #1e3a5f;
    }

    .nav-icon {
      font-size: 0.75rem;
    }

    .nav-actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .status-dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: #22c55e;
    }

    .status-label {
      font-size: 0.75rem;
      color: #6b7280;
    }

    .logout-btn {
      padding: 0.375rem 0.75rem;
      border-radius: 0.375rem;
      font-size: 0.75rem;
      color: #9ca3af;
      cursor: pointer;
      background: none;
      border: 1px solid #374151;
      font-family: inherit;
      margin-left: 0.75rem;
      transition:
        color 0.15s,
        border-color 0.15s;
    }

    .logout-btn:hover {
      color: #f87171;
      border-color: #f87171;
    }
  `;

  @property({ type: String }) currentRoute = "dashboard";

  private _navigate(route: string): void {
    this.dispatchEvent(new CustomEvent("navigate", { detail: route }));
  }

  private _logout(): void {
    this.dispatchEvent(new CustomEvent("logout"));
  }

  override render() {
    return html`
      <nav>
        <div class="brand">
          <span class="brand-icon">\u2726</span>
          Comis
        </div>

        <div class="nav-links">
          ${NAV_LINKS.map(
            (link) => html`
              <button
                class="nav-link"
                ?data-active=${this.currentRoute === link.route}
                @click=${() => this._navigate(link.route)}
              >
                <span class="nav-icon">${link.icon}</span>
                ${link.label}
              </button>
            `,
          )}
        </div>

        <div class="nav-actions">
          <span class="status-dot"></span>
          <span class="status-label">Connected</span>
          <button class="logout-btn" @click=${this._logout}>Disconnect</button>
        </div>
      </nav>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-nav-bar": IcNavBar;
  }
}
