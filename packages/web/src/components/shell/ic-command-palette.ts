import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles, srOnly } from "../../styles/shared.js";

/**
 * Command item displayed in palette search results.
 */
export interface CommandItem {
  id: string;
  label: string;
  category: "view" | "agent" | "session" | "command";
  icon: string;
  action: string;
  shortcut?: string;
}

/** Static palette items for all navigable views. */
const VIEW_ITEMS: CommandItem[] = [
  { id: "v-dashboard", label: "Dashboard", category: "view", icon: "home", action: "dashboard" },
  { id: "v-agents", label: "Agents", category: "view", icon: "users", action: "agents" },
  { id: "v-sessions", label: "Sessions", category: "view", icon: "message-circle", action: "sessions" },
  { id: "v-channels", label: "Channels", category: "view", icon: "radio", action: "channels" },
  { id: "v-chat", label: "Chat Console", category: "view", icon: "message-square", action: "chat" },
  { id: "v-memory", label: "Memory Inspector", category: "view", icon: "database", action: "memory" },
  { id: "v-skills", label: "Skills", category: "view", icon: "zap", action: "skills" },
  { id: "v-models", label: "Models", category: "view", icon: "cpu", action: "models" },
  { id: "v-scheduler", label: "Scheduler", category: "view", icon: "clock", action: "scheduler" },
  { id: "v-pipelines", label: "Pipelines", category: "view", icon: "git-branch", action: "pipelines" },
  { id: "v-observe", label: "Observability", category: "view", icon: "bar-chart-2", action: "observe/overview" },
  { id: "v-billing", label: "Billing", category: "view", icon: "dollar-sign", action: "observe/billing" },
  { id: "v-delivery", label: "Delivery", category: "view", icon: "send", action: "observe/delivery" },
  { id: "v-diagnostics", label: "Diagnostics", category: "view", icon: "activity", action: "observe/diagnostics" },
  { id: "v-context", label: "Context Engine", category: "view", icon: "layers", action: "observe/context" },
  { id: "v-security", label: "Security", category: "view", icon: "shield", action: "security" },
  { id: "v-config", label: "Settings", category: "view", icon: "settings", action: "config" },
  { id: "v-setup", label: "Setup Wizard", category: "view", icon: "compass", action: "setup" },
];

/** Static command items. */
const COMMAND_ITEMS: CommandItem[] = [
  { id: "c-refresh", label: "Refresh Data", category: "command", icon: "refresh-cw", action: "refresh" },
  { id: "c-sidebar", label: "Toggle Sidebar", category: "command", icon: "sidebar", action: "toggle-sidebar" },
  { id: "c-logout", label: "Logout", category: "command", icon: "log-out", action: "logout" },
  { id: "c-shortcuts", label: "Show Keyboard Shortcuts", category: "command", icon: "help-circle", action: "show-shortcuts" },
];

/** Category display order. */
const CATEGORY_ORDER: CommandItem["category"][] = ["view", "agent", "session", "command"];

/** Category display labels. */
const CATEGORY_LABELS: Record<string, string> = {
  view: "Views",
  agent: "Agents",
  session: "Sessions",
  command: "Commands",
};

/**
 * Command palette overlay with WAI-ARIA combobox pattern.
 *
 * Opens via Ctrl+K / Cmd+K, searches across views, agents, sessions,
 * and commands. Keyboard navigable with arrow keys, Enter, and Escape.
 *
 * @fires navigate - Dispatched when a view/agent/session item is selected, with route path
 * @fires command - Dispatched when a command item is selected, with command ID
 * @fires close - Dispatched when the palette should close
 */
@customElement("ic-command-palette")
export class IcCommandPalette extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    srOnly,
    css`
      :host {
        display: block;
      }

      .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 100;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding-top: 15vh;
      }

      .palette {
        background: var(--ic-surface, #111827);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-lg, 0.75rem);
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.4);
        max-width: 640px;
        width: 90%;
        max-height: 400px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .search-input {
        width: 100%;
        padding: var(--ic-space-md, 0.75rem) var(--ic-space-lg, 1rem);
        background: transparent;
        border: none;
        border-bottom: 1px solid var(--ic-border, #374151);
        color: var(--ic-text, #f3f4f6);
        font-size: 1rem;
        font-family: inherit;
        outline: none;
        box-sizing: border-box;
      }

      .search-input::placeholder {
        color: var(--ic-text-dim, #6b7280);
      }

      .results {
        overflow-y: auto;
        flex: 1;
        padding: var(--ic-space-xs, 0.25rem) 0;
      }

      .category-header {
        padding: var(--ic-space-xs, 0.25rem) var(--ic-space-md, 0.75rem);
        font-size: 0.6875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--ic-text-dim, #6b7280);
        margin-top: var(--ic-space-xs, 0.25rem);
      }

      .result-item {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm, 0.5rem);
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        cursor: pointer;
        color: var(--ic-text, #f3f4f6);
        font-size: var(--ic-text-sm, 0.875rem);
        transition: background 0.1s;
      }

      .result-item:hover,
      .result-item[aria-selected="true"] {
        background: var(--ic-accent, #3b82f6);
        color: #fff;
      }

      .result-icon {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        opacity: 0.7;
      }

      .result-label {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .result-shortcut {
        font-size: 0.6875rem;
        color: var(--ic-text-dim, #6b7280);
        font-family: var(--ic-font-mono, monospace);
        flex-shrink: 0;
      }

      .result-item[aria-selected="true"] .result-shortcut {
        color: rgba(255, 255, 255, 0.7);
      }

      .no-results {
        padding: var(--ic-space-lg, 1rem);
        text-align: center;
        color: var(--ic-text-dim, #6b7280);
        font-size: var(--ic-text-sm, 0.875rem);
      }

      .footer {
        border-top: 1px solid var(--ic-border, #374151);
        padding: var(--ic-space-xs, 0.25rem) var(--ic-space-md, 0.75rem);
        display: flex;
        gap: var(--ic-space-md, 0.75rem);
        font-size: 0.6875rem;
        color: var(--ic-text-dim, #6b7280);
      }

      .footer kbd {
        background: var(--ic-surface-2, #1f2937);
        border: 1px solid var(--ic-border, #374151);
        border-radius: 3px;
        padding: 1px 4px;
        font-size: 0.625rem;
        font-family: inherit;
      }
    `,
  ];

  /** Whether the palette is visible. */
  @property({ type: Boolean }) open = false;

  /** Dynamic agent list for search. */
  @property({ attribute: false }) agents: Array<{ id: string; name?: string }> = [];

  /** Dynamic session list for search. */
  @property({ attribute: false }) sessions: Array<{ key: string; agentId: string }> = [];

  @state() private _query = "";
  @state() private _activeIndex = -1;
  @state() private _results: CommandItem[] = [];

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("open") && this.open) {
      this._query = "";
      this._activeIndex = -1;
      this._results = this._filterResults("");
      this.updateComplete.then(() => {
        const input = this.shadowRoot?.querySelector<HTMLInputElement>(".search-input");
        input?.focus();
      });
    }
  }

  private _getAllItems(): CommandItem[] {
    const items: CommandItem[] = [...VIEW_ITEMS];

    // Dynamic agents
    for (const agent of this.agents) {
      items.push({
        id: `a-${agent.id}`,
        label: agent.name ?? agent.id,
        category: "agent",
        icon: "user",
        action: `agents/${agent.id}`,
      });
    }

    // Dynamic sessions (capped at 20)
    for (const session of this.sessions.slice(0, 20)) {
      items.push({
        id: `s-${session.key}`,
        label: `${session.agentId}: ${session.key}`,
        category: "session",
        icon: "message-circle",
        action: `sessions/${session.key}`,
      });
    }

    items.push(...COMMAND_ITEMS);
    return items;
  }

  private _filterResults(query: string): CommandItem[] {
    const allItems = this._getAllItems();
    if (!query) {
      // Show views and commands when no query
      return allItems.filter((i) => i.category === "view" || i.category === "command").slice(0, 20);
    }
    const q = query.toLowerCase();
    return allItems.filter((item) => item.label.toLowerCase().includes(q)).slice(0, 20);
  }

  private _getGroupedResults(): Array<{ category: string; items: CommandItem[] }> {
    const groups = new Map<string, CommandItem[]>();
    for (const item of this._results) {
      let group = groups.get(item.category);
      if (!group) {
        group = [];
        groups.set(item.category, group);
      }
      group.push(item);
    }

    return CATEGORY_ORDER
      .filter((cat) => groups.has(cat))
      .map((cat) => ({ category: cat, items: groups.get(cat)! }));
  }

  private _handleInput(e: InputEvent): void {
    this._query = (e.target as HTMLInputElement).value;
    this._results = this._filterResults(this._query);
    this._activeIndex = this._results.length > 0 ? 0 : -1;
  }

  private _handleKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (this._results.length > 0) {
          this._activeIndex = Math.min(this._activeIndex + 1, this._results.length - 1);
          this._scrollActiveIntoView();
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (this._results.length > 0) {
          this._activeIndex = Math.max(this._activeIndex - 1, 0);
          this._scrollActiveIntoView();
        }
        break;
      case "Enter":
        e.preventDefault();
        if (this._activeIndex >= 0 && this._activeIndex < this._results.length) {
          this._executeItem(this._results[this._activeIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        this._close();
        break;
    }
  }

  private _scrollActiveIntoView(): void {
    this.updateComplete.then(() => {
      const active = this.shadowRoot?.querySelector(`#result-${this._activeIndex}`);
      active?.scrollIntoView({ block: "nearest" });
    });
  }

  private _executeItem(item: CommandItem): void {
    if (item.category === "command") {
      this.dispatchEvent(new CustomEvent("command", { detail: item.action, bubbles: true, composed: true }));
    } else {
      this.dispatchEvent(new CustomEvent("navigate", { detail: item.action, bubbles: true, composed: true }));
    }
    this._close();
  }

  private _close(): void {
    this._query = "";
    this._activeIndex = -1;
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  private _handleBackdropClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).classList.contains("backdrop")) {
      this._close();
    }
  }

  override render() {
    if (!this.open) return nothing;

    const grouped = this._getGroupedResults();
    let flatIndex = 0;

    return html`
      <div class="backdrop" @click=${this._handleBackdropClick}>
        <div class="palette" role="dialog" aria-label="Command palette">
          <input
            class="search-input"
            type="text"
            placeholder="Search views, agents, sessions, commands..."
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant=${this._activeIndex >= 0 ? `result-${this._activeIndex}` : ""}
            aria-autocomplete="list"
            .value=${this._query}
            @input=${this._handleInput}
            @keydown=${this._handleKeydown}
          />
          <div class="results" id="palette-results" role="listbox" aria-label="Search results">
            ${this._results.length === 0
              ? html`<div class="no-results">No results found</div>`
              : grouped.map((group) => html`
                  <div class="category-header">${CATEGORY_LABELS[group.category] ?? group.category}</div>
                  ${group.items.map((item) => {
                    const idx = flatIndex++;
                    return html`
                      <div
                        id="result-${idx}"
                        class="result-item"
                        role="option"
                        aria-selected=${idx === this._activeIndex ? "true" : "false"}
                        @click=${() => this._executeItem(item)}
                        @pointerenter=${() => { this._activeIndex = idx; }}
                      >
                        <ic-icon class="result-icon" name=${item.icon} size="16px"></ic-icon>
                        <span class="result-label">${item.label}</span>
                        ${item.shortcut ? html`<span class="result-shortcut">${item.shortcut}</span>` : nothing}
                      </div>
                    `;
                  })}
                `)
            }
          </div>
          <div class="footer">
            <span><kbd>&uarr;</kbd><kbd>&darr;</kbd> Navigate</span>
            <span><kbd>Enter</kbd> Select</span>
            <span><kbd>Esc</kbd> Close</span>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-command-palette": IcCommandPalette;
  }
}
