import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import { parseSessionKeyString, formatSessionDisplayName } from "../../utils/session-key-parser.js";

// Side-effect imports for sub-components used in template
import "../../components/form/ic-search-input.js";
import "../../components/data/ic-tag.js";
import "../../components/data/ic-relative-time.js";
import "../../components/display/ic-icon.js";

/** Session information from session.status RPC. */
export interface SessionInfo {
  key: string;
  agentId: string;
  channelType: string;
  messageCount: number;
  lastActivity: number;
  label?: string;
}

/**
 * Session list sidebar sub-component.
 * Renders filterable list of sessions with search and new session button.
 *
 * @fires session-selected - Dispatched with { key } when a session is clicked
 * @fires filter-changed - Dispatched with { value } when search query changes
 * @fires new-session - Dispatched when the new session button is clicked
 */
@customElement("ic-session-sidebar")
export class IcSessionSidebar extends LitElement {
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
        height: 100%;
        border-right: 1px solid var(--ic-border);
        background: var(--ic-surface);
        width: 280px;
        overflow: hidden;
      }

      .sidebar-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--ic-space-sm) var(--ic-space-md);
        border-bottom: 1px solid var(--ic-border);
      }

      .sidebar-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text);
      }

      .new-btn {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
        padding: 0.375rem 0.75rem;
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-xs);
        font-family: inherit;
        cursor: pointer;
      }

      .new-btn:hover {
        opacity: 0.9;
      }

      .sidebar-search {
        padding: var(--ic-space-sm) var(--ic-space-md);
        border-bottom: 1px solid var(--ic-border);
      }

      .session-list {
        flex: 1;
        overflow-y: auto;
        padding: var(--ic-space-xs) 0;
      }

      .session-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--ic-space-sm) var(--ic-space-md);
        cursor: pointer;
        border-bottom: 1px solid color-mix(in srgb, var(--ic-border) 50%, transparent);
        transition: background 0.15s;
      }

      .session-item:hover {
        background: var(--ic-surface-2);
      }

      .session-item--active {
        background: color-mix(in srgb, var(--ic-accent) 10%, transparent);
        border-left: 3px solid var(--ic-accent);
      }

      .session-key {
        font-size: var(--ic-text-sm);
        font-weight: 500;
        color: var(--ic-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .session-meta {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      .msg-count {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }
    `,
  ];

  @property({ type: Array }) sessions: SessionInfo[] = [];
  @property({ type: String }) selectedKey = "";
  @property({ type: String }) filter = "";
  @property({ type: Boolean }) open = false;

  private _renderSessionItem(session: SessionInfo) {
    const isActive = session.key === this.selectedKey;
    const itemClass = isActive ? "session-item session-item--active" : "session-item";
    const parsed = parseSessionKeyString(session.key);
    const displayName = parsed ? formatSessionDisplayName(parsed) : (session.key.length > 8 ? session.key.slice(0, 8) : session.key);
    const channelTag = parsed?.channelId ?? session.channelType;

    return html`
      <div
        class=${itemClass}
        @click=${() => this.dispatchEvent(new CustomEvent("session-selected", { detail: { key: session.key }, bubbles: true, composed: true }))}
        role="button"
        tabindex="0"
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            this.dispatchEvent(new CustomEvent("session-selected", { detail: { key: session.key }, bubbles: true, composed: true }));
          }
        }}
      >
        <span class="session-key" title=${session.key}>${displayName}</span>
        <div class="session-meta">
          <ic-tag variant="accent" size="sm">${channelTag}</ic-tag>
          <span class="msg-count">${session.messageCount}</span>
          <ic-relative-time .timestamp=${session.lastActivity}></ic-relative-time>
        </div>
      </div>
    `;
  }

  override render() {
    return html`
      <aside class="sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">Sessions</span>
          <button class="new-btn" @click=${() => this.dispatchEvent(new CustomEvent("new-session", { bubbles: true, composed: true }))}>
            <ic-icon name="plus" size="14px"></ic-icon>
            New
          </button>
        </div>
        <div class="sidebar-search">
          <ic-search-input
            placeholder="Filter sessions..."
            debounce="200"
            @search=${(e: CustomEvent<string>) => this.dispatchEvent(new CustomEvent("filter-changed", { detail: { value: e.detail }, bubbles: true, composed: true }))}
          ></ic-search-input>
        </div>
        <div class="session-list">
          ${this.sessions.map((s) => this._renderSessionItem(s))}
        </div>
      </aside>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-session-sidebar": IcSessionSidebar;
  }
}
