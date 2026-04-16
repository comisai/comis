import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

/** Navigation item configuration */
interface NavItem {
  readonly route: string;
  readonly label: string;
  readonly icon: string;
  readonly badge?: "pendingApprovals" | "errorCount" | "agentCount" | "channelCount" | "sessionCount";
}

/** Grouped navigation section */
interface NavSection {
  readonly id: string;
  readonly label: string;
  readonly items: ReadonlyArray<NavItem>;
}

/** 4-pillar grouped navigation */
const NAV_SECTIONS: ReadonlyArray<NavSection> = [
  { id: "home", label: "Home", items: [
    { route: "dashboard", label: "Dashboard", icon: "\u25A3" },
  ]},
  { id: "operate", label: "Operate", items: [
    { route: "agents", label: "Agents", icon: "\u2B24", badge: "agentCount" },
    { route: "channels", label: "Channels", icon: "\u25CE", badge: "channelCount" },
    { route: "messages", label: "Messages", icon: "\u25CB" },
    { route: "chat", label: "Chat", icon: "\u25AC" },
    { route: "sessions", label: "Sessions", icon: "\u25F7", badge: "sessionCount" },
    { route: "subagents", label: "Sub-Agents", icon: "\u25D4" },
    { route: "pipelines", label: "Pipelines", icon: "\u25C8" },
  ]},
  { id: "observe", label: "Observe", items: [
    { route: "observe", label: "Overview", icon: "\u25B3", badge: "errorCount" },
    { route: "observe/context", label: "Context Engine", icon: "\u25E5" },
    { route: "context", label: "Context DAG", icon: "\u25D6" },
    { route: "observe/billing", label: "Billing", icon: "\u25C7" },
    { route: "observe/delivery", label: "Delivery", icon: "\u25B7" },
    { route: "observe/diagnostics", label: "Diagnostics", icon: "\u25A1" },
  ]},
  { id: "configure", label: "Configure", items: [
    { route: "skills", label: "Skills", icon: "\u2692" },
    { route: "mcp", label: "MCP Servers", icon: "\u2696" },
    { route: "models", label: "Models", icon: "\u2338" },
    { route: "memory", label: "Memory", icon: "\u25C9" },
    { route: "scheduler", label: "Scheduler", icon: "\u25A8" },
    { route: "security", label: "Security", icon: "\u2616" },
    { route: "media", label: "Media", icon: "\u25B6" },
    { route: "approvals", label: "Approvals", icon: "\u2713", badge: "pendingApprovals" },
    { route: "config", label: "Config", icon: "\u2699" },
  ]},
];

/** Setup item below divider */
const SETUP_ITEM: NavItem = { route: "setup", label: "Setup", icon: "\u25B6" };

/** LocalStorage key for sidebar collapsed state */
const COLLAPSE_KEY = "ic_sidebar_collapsed";

/**
 * Collapsible sidebar navigation component for the Comis operator console.
 *
 * Displays navigation items grouped into 4 sections (Home, Operate, Observe, Configure)
 * with non-clickable section headers, badge counts for agents, channels, sessions,
 * approvals, and errors, collapse/expand toggle with localStorage persistence,
 * and responsive behavior.
 *
 * Fires:
 * - `navigate` (CustomEvent<string>) with route name on nav item click
 * - `logout` (CustomEvent) on logout button click
 * - `close` (CustomEvent) when mobile overlay backdrop is clicked
 */
@customElement("ic-sidebar")
export class IcSidebar extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .sidebar {
        display: flex;
        flex-direction: column;
        width: 240px;
        height: 100vh;
        background: var(--ic-surface);
        border-right: 1px solid var(--ic-border);
        position: sticky;
        top: 0;
        transition: width var(--ic-transition);
        overflow: hidden;
      }

      .sidebar.collapsed {
        width: 64px;
      }

      nav {
        flex: 1;
        display: flex;
        flex-direction: column;
        padding: var(--ic-space-sm) 0;
        overflow-y: auto;
      }

      .section-header {
        display: flex;
        align-items: center;
        padding: 6px 16px 4px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--ic-text-dim);
        user-select: none;
        margin-top: 4px;
      }

      .section-header:first-of-type {
        margin-top: 0;
      }

      .collapsed .section-header {
        justify-content: center;
        padding: 6px 0;
      }

      .collapsed .section-label {
        display: none;
      }

      .collapsed .section-header::after {
        content: "";
        display: block;
        width: 16px;
        height: 1px;
        background: var(--ic-border);
      }

      .nav-item {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: none;
        border: none;
        border-left: 3px solid transparent;
        color: var(--ic-text-muted);
        cursor: pointer;
        font-family: inherit;
        font-size: var(--ic-text-sm);
        width: 100%;
        text-align: left;
        transition: color var(--ic-transition), background var(--ic-transition),
          border-color var(--ic-transition);
        white-space: nowrap;
      }

      .nav-item:hover {
        color: var(--ic-text);
        background: var(--ic-surface-2);
      }

      .nav-item[aria-current="page"] {
        color: var(--ic-accent);
        background: rgba(59, 130, 246, 0.1);
        border-left-color: var(--ic-accent);
      }

      .nav-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        font-size: 14px;
        flex-shrink: 0;
      }

      .nav-label {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .collapsed .nav-label {
        display: none;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        border-radius: 9px;
        font-size: 11px;
        font-weight: 600;
        color: white;
        background: var(--ic-error);
        flex-shrink: 0;
      }

      .collapsed .badge {
        display: none;
      }

      .divider {
        height: 1px;
        background: var(--ic-border);
        margin: var(--ic-space-sm) var(--ic-space-md);
      }

      .sidebar-footer {
        padding: var(--ic-space-sm);
        border-top: 1px solid var(--ic-border);
      }

      .collapse-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        padding: var(--ic-space-sm);
        background: none;
        border: none;
        color: var(--ic-text-dim);
        cursor: pointer;
        font-family: inherit;
        font-size: var(--ic-text-sm);
        transition: color var(--ic-transition);
      }

      .collapse-btn:hover {
        color: var(--ic-text);
      }

      .logout-btn {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        width: 100%;
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: none;
        border: none;
        border-left: 3px solid transparent;
        color: var(--ic-text-dim);
        cursor: pointer;
        font-family: inherit;
        font-size: var(--ic-text-sm);
        text-align: left;
        transition: color var(--ic-transition);
      }

      .logout-btn:hover {
        color: var(--ic-error);
      }

      .collapsed .logout-label {
        display: none;
      }

      /* Mobile overlay */
      .overlay {
        display: none;
      }

      @media (max-width: 767px) {
        .sidebar {
          position: fixed;
          z-index: 50;
          left: 0;
          top: 0;
          transform: translateX(-100%);
          transition: transform var(--ic-transition-slow);
        }

        :host([open]) .sidebar {
          transform: translateX(0);
          width: 240px;
        }

        :host([open]) .sidebar.collapsed {
          width: 240px;
        }

        :host([open]) .collapsed .nav-label,
        :host([open]) .collapsed .badge,
        :host([open]) .collapsed .logout-label,
        :host([open]) .collapsed .section-label {
          display: inline;
        }

        :host([open]) .collapsed .section-header::after {
          display: none;
        }

        :host([open]) .overlay {
          display: block;
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.5);
          z-index: 49;
        }
      }

      @media (min-width: 768px) and (max-width: 1023px) {
        .sidebar:not(.collapsed) {
          width: 64px;
        }

        .sidebar:not(.collapsed) .nav-label,
        .sidebar:not(.collapsed) .badge,
        .sidebar:not(.collapsed) .logout-label,
        .sidebar:not(.collapsed) .section-label {
          display: none;
        }

        .sidebar:not(.collapsed) .section-header {
          justify-content: center;
          padding: 6px 0;
        }

        .sidebar:not(.collapsed) .section-header::after {
          content: "";
          display: block;
          width: 16px;
          height: 1px;
          background: var(--ic-border);
        }
      }
    `,
  ];

  /** Current route for highlighting the active nav item */
  @property() currentRoute = "dashboard";

  /** Badge count for Approvals item */
  @property({ type: Number }) pendingApprovals = 0;

  /** Badge count for Observe item */
  @property({ type: Number }) errorCount = 0;

  /** Badge count for Agents item */
  @property({ type: Number }) agentCount = 0;

  /** Badge count for Channels item */
  @property({ type: Number }) channelCount = 0;

  /** Badge count for Sessions item */
  @property({ type: Number }) sessionCount = 0;

  /** Whether the mobile overlay is open */
  @property({ type: Boolean, reflect: true }) open = false;

  /** Whether the sidebar is collapsed */
  @state() private _collapsed = false;

  override connectedCallback(): void {
    super.connectedCallback();
    try {
      const stored = localStorage.getItem(COLLAPSE_KEY);
      if (stored !== null) {
        this._collapsed = JSON.parse(stored) as boolean;
      }
    } catch {
      // localStorage unavailable or corrupt - use default
    }
  }

  private _isActive(route: string): boolean {
    if (this.currentRoute === route) return true;
    if (!this.currentRoute.startsWith(route + "/")) return false;
    // Prefix matched - but only highlight if no more specific nav item matches
    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        if (item.route.length > route.length &&
            (this.currentRoute === item.route || this.currentRoute.startsWith(item.route + "/"))) {
          return false;
        }
      }
    }
    return true;
  }

  private _navigate(route: string): void {
    this.dispatchEvent(new CustomEvent("navigate", { detail: route }));
  }

  private _logout(): void {
    this.dispatchEvent(new CustomEvent("logout"));
  }

  private _toggleCollapse(): void {
    this._collapsed = !this._collapsed;
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(this._collapsed));
    } catch {
      // localStorage unavailable - collapse still works in-memory
    }
  }

  private _closeOverlay(): void {
    this.dispatchEvent(new CustomEvent("close"));
  }

  private _getBadgeValue(item: NavItem): number {
    switch (item.badge) {
      case "pendingApprovals": return this.pendingApprovals;
      case "errorCount": return this.errorCount;
      case "agentCount": return this.agentCount;
      case "channelCount": return this.channelCount;
      case "sessionCount": return this.sessionCount;
      default: return 0;
    }
  }

  private _renderNavItem(item: NavItem) {
    const active = this._isActive(item.route);
    const badgeValue = this._getBadgeValue(item);

    return html`
      <button
        class="nav-item"
        aria-current=${active ? "page" : nothing}
        @click=${() => this._navigate(item.route)}
      >
        <span class="nav-icon">${item.icon}</span>
        <span class="nav-label">${item.label}</span>
        ${badgeValue > 0
          ? html`<span class="badge">${badgeValue}</span>`
          : nothing}
      </button>
    `;
  }

  override render() {
    return html`
      <div class="overlay" @click=${this._closeOverlay}></div>
      <div class="sidebar ${this._collapsed ? "collapsed" : ""}">
        <nav role="navigation" aria-label="Main navigation">
          ${NAV_SECTIONS.map((section) => html`
            <div class="section-header">
              <span class="section-label">${section.label}</span>
            </div>
            ${section.items.map((item) => this._renderNavItem(item))}
          `)}
          <div class="divider"></div>
          ${this._renderNavItem(SETUP_ITEM)}
        </nav>
        <div class="sidebar-footer">
          <button
            class="logout-btn"
            @click=${this._logout}
            aria-label="Logout"
          >
            <span class="nav-icon">\u2BBB</span>
            <span class="logout-label">Logout</span>
          </button>
          <button
            class="collapse-btn"
            @click=${this._toggleCollapse}
            aria-label=${this._collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            ${this._collapsed ? "\u00BB" : "\u00AB"}
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-sidebar": IcSidebar;
  }
}
