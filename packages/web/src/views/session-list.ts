// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { ApiClient } from "../api/api-client.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { SseController } from "../state/sse-controller.js";
import type { SessionListItem } from "../api/types/index.js";
import {
  resolveSessionAuthorities,
  type ScopedSessionListItem,
  type SessionAuthority,
  type SessionTarget,
} from "../api/session-scope.js";
import { computeSessionStatus } from "../utils/session-key-parser.js";
import { IcToast } from "../components/feedback/ic-toast.js";
import { systemClearTimeout, systemNowMs, systemSetTimeout } from "@comis/core";

// Side-effect imports to register child custom elements
import "../components/session/ic-session-list.js";
import "../components/form/ic-search-input.js";
import "../components/feedback/ic-loading.js";
import "../components/feedback/ic-empty-state.js";
import "../components/feedback/ic-confirm-dialog.js";
import "../components/feedback/ic-toast.js";
import "../components/shell/ic-skeleton-view.js";

/**
 * Session list view for the operator console.
 *
 * Route: `#/sessions`
 *
 * Features:
 * - Loads sessions via apiClient.listSessions()
 * - Search input filters sessions by key, agent, or channel
 * - Agent and channel dropdown filters
 * - Sortable session table with row selection
 * - Bulk operations: reset, export, delete selected sessions
 * - Confirmation dialogs for destructive actions
 */
@customElement("ic-session-list-view")
export class IcSessionListView extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .page-header {
        margin-bottom: var(--ic-space-lg);
      }

      .page-title {
        font-size: var(--ic-text-xl);
        font-weight: 700;
        color: var(--ic-text);
        margin: 0;
      }

      .filter-bar {
        display: flex;
        align-items: center;
        gap: var(--ic-space-md);
        margin-bottom: var(--ic-space-md);
        flex-wrap: wrap;
      }

      .filter-bar ic-search-input {
        flex: 1;
        min-width: 12rem;
      }

      .filter-select {
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
        min-width: 8rem;
      }

      .filter-select:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .bulk-bar {
        display: flex;
        align-items: center;
        gap: var(--ic-space-md);
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        margin-bottom: var(--ic-space-md);
      }

      .bulk-count {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        font-weight: 500;
      }

      .bulk-actions {
        display: flex;
        gap: var(--ic-space-sm);
        margin-left: auto;
      }

      .btn {
        padding: var(--ic-space-xs) var(--ic-space-md);
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        transition: background var(--ic-transition), border-color var(--ic-transition);
        white-space: nowrap;
      }

      .btn-ghost {
        background: transparent;
        border: 1px solid var(--ic-border);
        color: var(--ic-text-muted);
      }

      .btn-ghost:hover {
        border-color: var(--ic-text-dim);
        color: var(--ic-text);
      }

      .btn-danger {
        background: transparent;
        border: 1px solid var(--ic-error);
        color: var(--ic-error);
      }

      .btn-danger:hover {
        background: var(--ic-error);
        color: #fff;
      }

      .error-container {
        padding: var(--ic-space-lg);
        text-align: center;
      }

      .error-message {
        color: var(--ic-error);
        font-size: var(--ic-text-sm);
        margin-bottom: var(--ic-space-md);
      }

      .retry-btn {
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: var(--ic-accent);
        border: none;
        border-radius: var(--ic-radius-md);
        color: #fff;
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
      }

      .retry-btn:hover {
        background: var(--ic-accent-hover);
      }

      .loading-container {
        display: flex;
        justify-content: center;
        padding: var(--ic-space-2xl);
      }
    `,
  ];

  /** API client for data fetching. */
  @property({ attribute: false }) apiClient: ApiClient | null = null;

  /** RPC client for session.search content search. */
  @property({ attribute: false }) rpcClient: RpcClient | null = null;

  /** Event dispatcher for SSE subscriptions (injected from app.ts). */
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  private _sse: SseController | null = null;
  private _reloadDebounce: ReturnType<typeof setTimeout> | null = null;

  @state() private _sessions: ScopedSessionListItem[] = [];
  @state() private _filteredSessions: ScopedSessionListItem[] = [];
  @state() private _loading = false;
  @state() private _error = "";
  @state() private _searchQuery = "";
  @state() private _agentFilter = "";
  @state() private _kindFilter = "";
  @state() private _statusFilter: "" | "active" | "idle" | "expired" = "";
  @state() private _selectedKeys: string[] = [];
  @state() private _showConfirm = false;
  @state() private _confirmAction = "";
  @state() private _configuredAgentIds: string[] = [];
  private _authorities: SessionAuthority[] = [];

  /** Debounce timer for search RPC calls. */
  private _searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Search results from session.search RPC (used to filter by content match). */
  private _searchResultKeys: Set<string> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // Note: _loadSessions() is NOT called here -- apiClient is typically
    // null at this point. The updated() callback handles loading once
    // the client property is set.
    this._initSse();
  }

  override updated(changed: Map<string, unknown>): void {
    if (
      (changed.has("apiClient") || changed.has("rpcClient"))
      && this.apiClient
      && this.rpcClient
    ) {
      this._loadSessions();
    }
    if (changed.has("eventDispatcher") && this.eventDispatcher && !this._sse) {
      this._initSse();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._reloadDebounce !== null) {
      systemClearTimeout(this._reloadDebounce);
      this._reloadDebounce = null;
    }
  }

  private _initSse(): void {
    if (!this.eventDispatcher || this._sse) return;
    this._sse = new SseController(this, this.eventDispatcher, {
      "session:created": () => { this._scheduleReload(); },
      "session:expired": () => { this._scheduleReload(); },
    });
  }

  private _scheduleReload(delayMs = 300): void {
    if (this._reloadDebounce !== null) systemClearTimeout(this._reloadDebounce);
    this._reloadDebounce = systemSetTimeout(() => {
      this._reloadDebounce = null;
      void this._loadSessions();
    }, delayMs);
  }

  private async _loadSessions(): Promise<void> {
    if (!this.apiClient || !this.rpcClient) return;
    const apiClient = this.apiClient;
    const rpcClient = this.rpcClient;
    this._loading = true;
    this._error = "";
    try {
      this._authorities = await resolveSessionAuthorities(rpcClient);
      this._configuredAgentIds = this._authorities.map((authority) => authority.agentId);
      const results = await Promise.all(this._authorities.map(async (authority) => {
        const sessions = await apiClient.listSessions(authority);
        return sessions.map((session) => ({ ...session, tenantId: authority.tenantId }));
      }));
      this._sessions = results.flat();
      this._applyFilters();
    } catch {
      this._error = "Failed to load sessions. Please try again.";
    } finally {
      this._loading = false;
    }
  }

  private _applyFilters(): void {
    let filtered = this._sessions;

    if (this._searchQuery) {
      // If RPC search provided keys, filter to those keys
      const searchResultKeys = this._searchResultKeys;
      if (searchResultKeys) {
        filtered = filtered.filter((s) => searchResultKeys.has(s.conversationRef));
      } else {
        // Client-side fallback: text match on reference, agent, or kind
        const q = this._searchQuery.toLowerCase();
        filtered = filtered.filter(
          (s) =>
            s.conversationRef.toLowerCase().includes(q) ||
            s.agentId.toLowerCase().includes(q) ||
            s.kind.toLowerCase().includes(q),
        );
      }
    }

    if (this._agentFilter) {
      filtered = filtered.filter((s) => s.agentId === this._agentFilter);
    }

    if (this._kindFilter) {
      filtered = filtered.filter((s) => s.kind === this._kindFilter);
    }

    if (this._statusFilter) {
      filtered = filtered.filter(
        (s) => computeSessionStatus(s.updatedAt) === this._statusFilter,
      );
    }

    this._filteredSessions = filtered;
  }

  private _getUniqueAgents(): string[] {
    const agents = new Set([
      ...this._configuredAgentIds,
      ...this._sessions.map((s) => s.agentId),
    ]);
    return [...agents].sort();
  }

  private _getUniqueKinds(): string[] {
    const kinds = new Set(this._sessions.map((s) => s.kind));
    return [...kinds].sort();
  }

  private _handleSearch(e: CustomEvent<string>): void {
    this._searchQuery = e.detail;

    // Clear previous debounce timer
    if (this._searchDebounceTimer !== null) {
      systemClearTimeout(this._searchDebounceTimer);
      this._searchDebounceTimer = null;
    }

    if (!this._searchQuery) {
      // Clear search results and apply filters immediately
      this._searchResultKeys = null;
      this._applyFilters();
      return;
    }

    // If rpcClient is available, debounce the RPC search call
    if (this.rpcClient) {
      this._searchDebounceTimer = systemSetTimeout(() => {
        this._performRpcSearch(this._searchQuery);
      }, 300);
    } else {
      // No RPC client -- fall back to client-side filtering immediately
      this._searchResultKeys = null;
      this._applyFilters();
    }
  }

  private async _performRpcSearch(query: string): Promise<void> {
    if (!this.rpcClient) return;
    const rpcClient = this.rpcClient;
    try {
      const responses = await Promise.all(this._authorities.map((authority) =>
        rpcClient.call("session.search", {
          tenant_id: authority.tenantId,
          agent_id: authority.agentId,
          query,
          limit: 50,
        })
      ));
      const refs = responses.flatMap((response) => {
        const results = response["results"];
        if (!Array.isArray(results)) return [];
        return results.flatMap((result) => {
          if (result === null || typeof result !== "object") return [];
          const conversationRef = (result as Record<string, unknown>)["conversationRef"];
          return typeof conversationRef === "string" ? [conversationRef] : [];
        });
      });
      this._searchResultKeys = new Set(refs);
    } catch {
      // RPC failed -- fall back to client-side filtering
      this._searchResultKeys = null;
    }
    this._applyFilters();
  }

  private _handleAgentFilter(e: Event): void {
    this._agentFilter = (e.target as HTMLSelectElement).value;
    this._applyFilters();
  }

  private _handleKindFilter(e: Event): void {
    this._kindFilter = (e.target as HTMLSelectElement).value;
    this._applyFilters();
  }

  private _handleStatusFilter(e: Event): void {
    this._statusFilter = (e.target as HTMLSelectElement).value as typeof this._statusFilter;
    this._applyFilters();
  }

  private _handleSessionClick(e: CustomEvent<SessionListItem>): void {
    const session = e.detail;
    window.location.hash = `#/sessions/${session.conversationRef}`;
  }

  private _handleSelectionChange(e: CustomEvent<string[]>): void {
    this._selectedKeys = e.detail;
  }

  private _selectedTargets(): SessionTarget[] {
    const selected = new Set(this._selectedKeys);
    return this._sessions
      .filter((session) => selected.has(session.conversationRef))
      .map((session) => ({
        tenantId: session.tenantId,
        agentId: session.agentId,
        conversationRef: session.conversationRef,
      }));
  }

  private _showBulkConfirm(action: string): void {
    this._confirmAction = action;
    this._showConfirm = true;
  }

  private _handleConfirmCancel(): void {
    this._showConfirm = false;
    this._confirmAction = "";
  }

  private async _handleConfirm(): Promise<void> {
    this._showConfirm = false;
    if (!this.apiClient) return;

    try {
      if (this._confirmAction === "reset") {
        await this.apiClient.resetSessionsBulk(this._selectedTargets());
        IcToast.show(`${this._selectedKeys.length} sessions reset`, "success");
      } else if (this._confirmAction === "delete") {
        await this.apiClient.deleteSessionsBulk(this._selectedTargets());
        IcToast.show(`${this._selectedKeys.length} sessions deleted`, "success");
      }
      this._selectedKeys = [];
      this._confirmAction = "";
      await this._loadSessions();
    } catch {
      IcToast.show("Operation failed. Please try again.", "error");
    }
  }

  private async _handleBulkExport(): Promise<void> {
    if (!this.apiClient || this._selectedKeys.length === 0) return;

    try {
      const data = await this.apiClient.exportSessionsBulk(this._selectedTargets());
      const blob = new Blob([data], { type: "application/jsonl" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sessions-export-${systemNowMs()}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
      IcToast.show(`${this._selectedKeys.length} sessions exported`, "success");
    } catch {
      IcToast.show("Export failed. Please try again.", "error");
    }
  }

  private _renderAgentSelect() {
    const agents = this._getUniqueAgents();
    return html`<select class="filter-select" .value=${this._agentFilter} @change=${this._handleAgentFilter} aria-label="Filter by agent">
      <option value="">All Agents</option>
      ${agents.map((a) => html`<option .value=${a}>${a}</option>`)}
    </select>`;
  }

  private _renderKindSelect() {
    const kinds = this._getUniqueKinds();
    return html`<select class="filter-select" .value=${this._kindFilter} @change=${this._handleKindFilter} aria-label="Filter by kind">
      <option value="">All Kinds</option>
      ${kinds.map((kind) => html`<option .value=${kind}>${kind}</option>`)}
    </select>`;
  }

  private _renderStatusSelect() {
    return html`<select class="filter-select" .value=${this._statusFilter} @change=${this._handleStatusFilter} aria-label="Filter by status">
      <option value="">All Statuses</option>
      <option value="active">Active</option>
      <option value="idle">Idle</option>
      <option value="expired">Expired</option>
    </select>`;
  }

  private _renderFilterBar() {
    return html`
      <div class="filter-bar">
        <ic-search-input
          placeholder="Search sessions..."
          .value=${this._searchQuery}
          @search=${this._handleSearch}
        ></ic-search-input>
        ${this._renderAgentSelect()}
        ${this._renderKindSelect()}
        ${this._renderStatusSelect()}
      </div>
    `;
  }

  private _renderBulkBar() {
    if (this._selectedKeys.length === 0) return nothing;

    return html`
      <div class="bulk-bar">
        <span class="bulk-count">${this._selectedKeys.length} selected</span>
        <div class="bulk-actions">
          <button class="btn btn-ghost" @click=${() => this._showBulkConfirm("reset")}>
            Reset Selected
          </button>
          <button class="btn btn-ghost" @click=${this._handleBulkExport}>
            Export Selected
          </button>
          <button class="btn btn-danger" @click=${() => this._showBulkConfirm("delete")}>
            Delete Selected
          </button>
        </div>
      </div>
    `;
  }

  private _getConfirmProps(): { title: string; message: string; variant: string; label: string } {
    if (this._confirmAction === "delete") {
      return {
        title: "Delete Sessions",
        message: `Are you sure you want to delete ${this._selectedKeys.length} sessions? This action cannot be undone.`,
        variant: "danger",
        label: "Delete",
      };
    }
    return {
      title: "Reset Sessions",
      message: `Are you sure you want to reset ${this._selectedKeys.length} sessions? All conversation history will be cleared.`,
      variant: "default",
      label: "Reset",
    };
  }

  override render() {
    if (this._loading) {
      return html`
        <div class="page-header"><h1 class="page-title">Sessions</h1></div>
        <ic-skeleton-view variant="list"></ic-skeleton-view>
      `;
    }

    if (this._error) {
      return html`
        <div class="page-header"><h1 class="page-title">Sessions</h1></div>
        <div class="error-container">
          <div class="error-message">${this._error}</div>
          <button class="retry-btn" @click=${() => this._loadSessions()}>Retry</button>
        </div>
      `;
    }

    if (this._sessions.length === 0) {
      return html`
        <div class="page-header"><h1 class="page-title">Sessions</h1></div>
        <ic-empty-state
          icon="message-circle"
          message="No active sessions"
          description="Sessions appear when agents receive messages."
        >
          <button class="retry-btn" @click=${() => { window.location.hash = "#/chat"; }}>Go to Chat</button>
        </ic-empty-state>
      `;
    }

    const confirmProps = this._getConfirmProps();

    return html`
      <div class="page-header" role="region" aria-label="Sessions">
        <h1 class="page-title">Sessions</h1>
      </div>

      ${this._renderFilterBar()}
      ${this._renderBulkBar()}

      <ic-session-list
        .sessions=${this._filteredSessions}
        selectable
        @session-click=${this._handleSessionClick}
        @selection-change=${this._handleSelectionChange}
      ></ic-session-list>

      <ic-confirm-dialog
        ?open=${this._showConfirm}
        title=${confirmProps.title}
        message=${confirmProps.message}
        variant=${confirmProps.variant}
        confirmLabel=${confirmProps.label}
        @confirm=${this._handleConfirm}
        @cancel=${this._handleConfirmCancel}
      ></ic-confirm-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-session-list-view": IcSessionListView;
  }
}
