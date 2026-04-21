// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { ApiClient, BrowseMemoryParams } from "../api/api-client.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { MemoryEntry, MemoryStats, EmbeddingCacheStats } from "../api/types/index.js";
import "../components/memory-table.js";
import "../components/memory-detail.js";
import "../components/data/ic-stat-card.js";
import "../components/data/ic-tag.js";
import "../components/form/ic-search-input.js";
import "../components/layout/ic-detail-panel.js";
import "../components/feedback/ic-confirm-dialog.js";

/** Memory type filter options. */
const MEMORY_TYPES = ["working", "episodic", "semantic", "procedural"] as const;

/** Trust level filter options. */
const TRUST_LEVELS = ["system", "learned", "external"] as const;

/**
 * Memory inspector view with search, browse, filters, bulk operations, and detail panel.
 *
 * Features:
 * - Stat cards for total entries, sessions, vectors, DB size
 * - Mode toggle: Search (with query) or Browse All (paginated)
 * - Filters: memory type, trust level, agent, date range
 * - Results table with ic-data-table via ic-memory-table
 * - Bulk actions: delete selected, export selected
 * - Detail panel with full metadata and delete action
 */
@customElement("ic-memory-inspector")
export class IcMemoryInspector extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .page-header {
        font-size: var(--ic-text-lg);
        font-weight: 600;
        color: var(--ic-text);
        margin-bottom: var(--ic-space-md);
      }

      /* Stats row */
      .stats-row {
        display: flex;
        gap: var(--ic-space-md);
        flex-wrap: wrap;
        margin-bottom: var(--ic-space-lg);
      }

      /* Mode toggle + search bar */
      .toolbar {
        display: flex;
        gap: var(--ic-space-md);
        align-items: center;
        margin-bottom: var(--ic-space-md);
      }

      .mode-toggle {
        display: flex;
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        overflow: hidden;
        flex-shrink: 0;
      }

      .mode-btn {
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: transparent;
        border: none;
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        transition: background var(--ic-transition), color var(--ic-transition);
        white-space: nowrap;
      }

      .mode-btn:hover {
        color: var(--ic-text);
      }

      .mode-btn[data-active] {
        background: var(--ic-accent);
        color: var(--ic-text);
      }

      .search-wrapper {
        flex: 1;
      }

      /* Filters row */
      .filters-row {
        display: flex;
        align-items: center;
        gap: var(--ic-space-md);
        margin-bottom: var(--ic-space-md);
        flex-wrap: wrap;
      }

      .filter-group {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
      }

      .filter-label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        white-space: nowrap;
      }

      .filter-checkbox {
        display: flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
      }

      .filter-checkbox input {
        accent-color: var(--ic-accent);
      }

      .filter-select {
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-xs) var(--ic-space-sm);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
      }

      .filter-date {
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-xs) var(--ic-space-sm);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        font-family: inherit;
      }

      /* Results header */
      .results-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--ic-space-sm);
      }

      .result-count {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
      }

      .export-btn {
        padding: var(--ic-space-xs) var(--ic-space-md);
        background: transparent;
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        transition: color var(--ic-transition), border-color var(--ic-transition);
      }

      .export-btn:hover {
        color: var(--ic-text);
        border-color: var(--ic-text-dim);
      }

      /* Bulk actions bar */
      .bulk-bar {
        display: flex;
        align-items: center;
        gap: var(--ic-space-md);
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: var(--ic-surface);
        border: 1px solid var(--ic-accent);
        border-radius: var(--ic-radius-md);
        margin-bottom: var(--ic-space-md);
      }

      .bulk-count {
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        font-weight: 500;
      }

      .bulk-btn {
        padding: var(--ic-space-xs) var(--ic-space-md);
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        border: none;
        transition: background var(--ic-transition);
      }

      .bulk-btn--delete {
        background: var(--ic-error);
        color: var(--ic-text);
      }

      .bulk-btn--delete:hover {
        background: color-mix(in srgb, var(--ic-error) 85%, black);
      }

      .bulk-btn--export {
        background: var(--ic-surface-2);
        color: var(--ic-text-muted);
        border: 1px solid var(--ic-border);
      }

      .bulk-btn--export:hover {
        color: var(--ic-text);
      }

      /* Browse pagination controls */
      .browse-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: var(--ic-space-md);
      }

      .browse-info {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
      }

      .browse-nav {
        display: flex;
        gap: var(--ic-space-sm);
      }

      .browse-btn {
        padding: var(--ic-space-xs) var(--ic-space-md);
        background: transparent;
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        transition: color var(--ic-transition), border-color var(--ic-transition);
      }

      .browse-btn:hover:not(:disabled) {
        color: var(--ic-text);
        border-color: var(--ic-text-dim);
      }

      .browse-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      /* Loading / Error */
      .state-container {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--ic-space-2xl);
        color: var(--ic-text-dim);
        font-size: var(--ic-text-sm);
      }

      .loading-spinner {
        width: 1.5rem;
        height: 1.5rem;
        border: 2px solid var(--ic-border);
        border-top-color: var(--ic-accent);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      .error-message {
        color: var(--ic-error);
        font-size: var(--ic-text-sm);
        padding: var(--ic-space-md);
        background: color-mix(in srgb, var(--ic-error) 8%, transparent);
        border: 1px solid color-mix(in srgb, var(--ic-error) 30%, transparent);
        border-radius: var(--ic-radius-md);
        margin-bottom: var(--ic-space-md);
      }

      .empty-state {
        text-align: center;
        padding: var(--ic-space-2xl);
        color: var(--ic-text-dim);
        font-size: var(--ic-text-sm);
      }

      .empty-hint {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        margin-top: var(--ic-space-xs);
      }

      /* By-agent bar chart */
      .agent-chart {
        margin-bottom: var(--ic-space-lg);
      }

      .agent-chart-title {
        font-size: var(--ic-text-sm);
        font-weight: 500;
        color: var(--ic-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.03em;
        margin-bottom: var(--ic-space-sm);
      }

      .bar-container {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        margin-bottom: var(--ic-space-xs);
      }

      .bar-label {
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        min-width: 100px;
        text-align: right;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex-shrink: 0;
      }

      .bar-track {
        flex: 1;
        background: var(--ic-surface-2);
        height: 8px;
        border-radius: 4px;
        overflow: hidden;
      }

      .bar-fill {
        height: 100%;
        border-radius: 4px;
        background: var(--ic-accent);
        transition: width 0.3s ease;
      }

      .bar-value {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        min-width: 36px;
        text-align: right;
        flex-shrink: 0;
      }

      .agent-chart-overflow {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        margin-top: var(--ic-space-xs);
        padding-left: calc(100px + var(--ic-space-sm));
      }

      /* Creation form */
      .create-toggle {
        padding: var(--ic-space-xs) var(--ic-space-md);
        background: transparent;
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        transition: color var(--ic-transition), border-color var(--ic-transition);
      }

      .create-toggle:hover {
        color: var(--ic-text);
        border-color: var(--ic-text-dim);
      }

      .create-form {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
        margin-bottom: var(--ic-space-md);
      }

      .create-form-title {
        font-size: var(--ic-text-sm);
        font-weight: 500;
        color: var(--ic-text);
        margin-bottom: var(--ic-space-md);
      }

      .create-field {
        margin-bottom: var(--ic-space-sm);
      }

      .create-label {
        display: block;
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        margin-bottom: var(--ic-space-xs);
      }

      .create-textarea {
        width: 100%;
        min-height: 80px;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        resize: vertical;
        box-sizing: border-box;
      }

      .create-input {
        width: 100%;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        box-sizing: border-box;
      }

      .create-select {
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
      }

      .create-actions {
        display: flex;
        gap: var(--ic-space-sm);
        margin-top: var(--ic-space-md);
      }

      .create-submit {
        padding: var(--ic-space-sm) var(--ic-space-lg);
        background: var(--ic-accent);
        border: none;
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        font-weight: 500;
        transition: background var(--ic-transition);
      }

      .create-submit:hover:not(:disabled) {
        background: color-mix(in srgb, var(--ic-accent) 85%, white);
      }

      .create-submit:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .create-message {
        font-size: var(--ic-text-sm);
        padding: var(--ic-space-xs) var(--ic-space-sm);
        border-radius: var(--ic-radius-md);
        margin-top: var(--ic-space-sm);
      }

      .create-message--success {
        color: var(--ic-success, #4ade80);
        background: color-mix(in srgb, var(--ic-success, #4ade80) 10%, transparent);
      }

      .create-message--error {
        color: var(--ic-error);
        background: color-mix(in srgb, var(--ic-error) 10%, transparent);
      }

      /* Flush button */
      .flush-btn {
        padding: var(--ic-space-xs) var(--ic-space-md);
        background: transparent;
        border: 1px solid var(--ic-error);
        border-radius: var(--ic-radius-md);
        color: var(--ic-error);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        transition: background var(--ic-transition), color var(--ic-transition);
        margin-left: auto;
      }

      .flush-btn:hover {
        background: color-mix(in srgb, var(--ic-error) 15%, transparent);
      }

      /* Flush scope filter */
      .flush-scope {
        margin-bottom: var(--ic-space-md);
      }

      .flush-scope-label {
        display: block;
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        margin-bottom: var(--ic-space-xs);
      }

      .toolbar-right {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        margin-left: auto;
      }

      /* Embedding infrastructure section */
      .embedding-section {
        margin-bottom: var(--ic-space-lg);
      }

      .section-heading {
        font-size: var(--ic-text-md);
        font-weight: 600;
        color: var(--ic-text);
        margin-bottom: var(--ic-space-md);
      }

      .embedding-disabled {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-dim);
        padding: var(--ic-space-md);
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        display: flex;
        align-items: center;
        gap: var(--ic-space-md);
      }
    `,
  ];

  @property({ attribute: false }) apiClient: ApiClient | null = null;
  @property({ attribute: false }) rpcClient: RpcClient | null = null;

  // Mode
  @state() private _mode: "search" | "browse" = "search";

  // Search
  @state() private _query = "";
  @state() private _results: MemoryEntry[] = [];
  @state() private _loading = false;
  @state() private _searched = false;
  @state() private _error = "";

  // Stats
  @state() private _stats: MemoryStats | null = null;
  @state() private _statsLoaded = false;

  // Detail panel
  @state() private _selectedEntry: MemoryEntry | null = null;

  // Selection for bulk ops
  @state() private _selectedIds: string[] = [];

  // Filters
  @state() private _typeFilter: Set<string> = new Set(MEMORY_TYPES);
  @state() private _trustFilter: Set<string> = new Set(TRUST_LEVELS);
  @state() private _agentFilter = "";
  @state() private _dateFrom = "";
  @state() private _dateTo = "";

  // Browse pagination
  @state() private _browseOffset = 0;
  @state() private _browseLimit = 25;
  @state() private _total = 0;

  // Agents list for dropdown
  @state() private _agents: string[] = [];

  // Confirm dialog
  @state() private _confirmOpen = false;

  // Creation form
  @state() private _createOpen = false;
  @state() private _createContent = "";
  @state() private _createTags = "";
  @state() private _createTrustLevel = "learned";
  @state() private _createProvenance = "";
  @state() private _createSubmitting = false;
  @state() private _createMessage = "";
  @state() private _createMessageType: "success" | "error" = "success";

  // Embedding infrastructure stats
  @state() private _embeddingStats: EmbeddingCacheStats | null = null;
  @state() private _embeddingLoading = false;

  // Flush dialog
  @state() private _flushDialogOpen = false;
  @state() private _flushAgentId = "";
  @state() private _flushSubmitting = false;

  override connectedCallback(): void {
    super.connectedCallback();
    // Note: _loadStats() and _loadAgents() are NOT called here --
    // apiClient is typically null at this point. The updated() callback
    // handles loading once the client property is set.
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("apiClient") && this.apiClient) {
      this._loadStats();
      this._loadAgents();
    }
    if (changed.has("rpcClient") && this.rpcClient) {
      this._loadEmbeddingStats();
    }
  }

  // --- Entry normalization ---

  /**
   * Normalize a raw memory entry from the daemon into a complete MemoryEntry.
   * The daemon's memory.browse RPC may omit fields like memoryType, hasEmbedding, tenantId.
   */
  private _normalizeEntry(raw: Record<string, unknown>): MemoryEntry {
    return {
      id: String(raw.id ?? ""),
      content: String(raw.content ?? ""),
      memoryType: String(raw.memoryType ?? raw.type ?? "unknown"),
      trustLevel: String(raw.trustLevel ?? raw.trust ?? "unknown"),
      agentId: String(raw.agentId ?? "unknown"),
      tenantId: String(raw.tenantId ?? "default"),
      source: typeof raw.source === "string" ? raw.source : undefined,
      tags: Array.isArray(raw.tags) ? raw.tags as string[] : undefined,
      score: typeof raw.score === "number" ? raw.score : undefined,
      hasEmbedding: Boolean(raw.hasEmbedding ?? false),
      embeddingDims: typeof raw.embeddingDims === "number" ? raw.embeddingDims : undefined,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : undefined,
    };
  }

  // --- Data loading ---

  private async _loadStats(): Promise<void> {
    if (!this.apiClient) return;
    try {
      const result = await this.apiClient.getMemoryStats();
      const outer = result as Record<string, unknown>;
      const statsObj =
        typeof outer["stats"] === "object" && outer["stats"] !== null
          ? (outer["stats"] as Record<string, unknown>)
          : outer;
      this._stats = {
        totalEntries: (statsObj["totalEntries"] as number) ?? 0,
        totalSessions: (statsObj["totalSessions"] as number) ?? 0,
        embeddedEntries: (statsObj["embeddedEntries"] as number) ?? 0,
        dbSizeBytes: (statsObj["dbSizeBytes"] as number) ?? 0,
        byType: statsObj["byType"] as Record<string, number> | undefined,
        byTrustLevel: statsObj["byTrustLevel"] as Record<string, number> | undefined,
        byAgent: statsObj["byAgent"] as Record<string, number> | undefined,
        oldestCreatedAt: statsObj["oldestCreatedAt"] as number | null | undefined,
      };
      this._statsLoaded = true;
    } catch {
      this._statsLoaded = true;
    }
  }

  private async _loadAgents(): Promise<void> {
    if (!this.apiClient) return;
    try {
      const agents = await this.apiClient.getAgents();
      this._agents = agents.map((a) => a.id);
    } catch {
      // Non-critical
    }
  }

  private async _loadEmbeddingStats(): Promise<void> {
    if (!this.rpcClient || this._embeddingLoading) return;
    this._embeddingLoading = true;
    try {
      const result = await this.rpcClient.call("memory.embeddingCache");
      this._embeddingStats = result as unknown as EmbeddingCacheStats;
    } catch {
      // Non-critical -- embedding may be disabled
    } finally {
      this._embeddingLoading = false;
    }
  }

  // --- Search ---

  private async _search(): Promise<void> {
    const query = this._query.trim();
    if (!query || !this.apiClient || this._loading) return;

    this._loading = true;
    this._error = "";
    this._selectedIds = [];

    try {
      const results = await this.apiClient.searchMemory(query, 50);
      // Normalize: results from searchMemory are MemorySearchResult, map to MemoryEntry
      this._results = results.map((r) => this._normalizeEntry(r as unknown as Record<string, unknown>));
      this._searched = true;
    } catch (err) {
      this._error =
        err instanceof Error && !err.message.startsWith("Request failed")
          ? err.message
          : "Search failed. Please try again.";
      this._results = [];
    } finally {
      this._loading = false;
    }
  }

  // --- Browse ---

  private async _browse(): Promise<void> {
    if (!this.apiClient || this._loading) return;

    this._loading = true;
    this._error = "";
    this._selectedIds = [];

    try {
      const params: Record<string, unknown> = {
        offset: this._browseOffset,
        limit: this._browseLimit,
      };

      // Pass server-side filters
      if (this._typeFilter.size < MEMORY_TYPES.length) {
        params.type = [...this._typeFilter].join(",");
      }
      if (this._trustFilter.size < TRUST_LEVELS.length) {
        params.trust = [...this._trustFilter].join(",");
      }
      if (this._agentFilter) {
        params.agentId = this._agentFilter;
      }
      if (this._dateFrom) {
        params.from = new Date(this._dateFrom).getTime();
      }
      if (this._dateTo) {
        params.to = new Date(this._dateTo).getTime();
      }

      const result = await this.apiClient.browseMemory(params as unknown as BrowseMemoryParams);
      this._results = result.entries.map((e) => this._normalizeEntry(e as unknown as Record<string, unknown>));
      this._total = result.total;
      this._searched = true;
    } catch (err) {
      this._error =
        err instanceof Error && !err.message.startsWith("Request failed")
          ? err.message
          : "Browse failed. Please try again.";
      this._results = [];
    } finally {
      this._loading = false;
    }
  }

  // --- Filters ---

  private _applyFilters(entries: MemoryEntry[]): MemoryEntry[] {
    return entries.filter((entry) => {
      if (!this._typeFilter.has(entry.memoryType)) return false;
      if (!this._trustFilter.has(entry.trustLevel)) return false;
      if (this._agentFilter && entry.agentId !== this._agentFilter) return false;
      if (this._dateFrom) {
        const from = new Date(this._dateFrom).getTime();
        if (entry.createdAt < from) return false;
      }
      if (this._dateTo) {
        const to = new Date(this._dateTo).getTime() + 86400000; // End of day
        if (entry.createdAt > to) return false;
      }
      return true;
    });
  }

  private _getFilteredResults(): MemoryEntry[] {
    if (this._mode === "search") {
      // Client-side filtering for search results
      return this._applyFilters(this._results);
    }
    // Browse mode: filters applied server-side
    return this._results;
  }

  private _toggleTypeFilter(type: string): void {
    const next = new Set(this._typeFilter);
    if (next.has(type)) {
      next.delete(type);
    } else {
      next.add(type);
    }
    this._typeFilter = next;
  }

  private _toggleTrustFilter(level: string): void {
    const next = new Set(this._trustFilter);
    if (next.has(level)) {
      next.delete(level);
    } else {
      next.add(level);
    }
    this._trustFilter = next;
  }

  // --- Event handlers ---

  private _handleModeChange(mode: "search" | "browse"): void {
    if (this._mode === mode) return;
    this._mode = mode;
    this._results = [];
    this._searched = false;
    this._error = "";
    this._selectedIds = [];
    this._browseOffset = 0;

    if (mode === "browse") {
      this._browse();
    }
  }

  private _handleSearchEvent(e: CustomEvent<string>): void {
    this._query = e.detail;
    if (this._query.trim()) {
      this._search();
    }
  }

  private _handleDetailRequested(e: CustomEvent<MemoryEntry>): void {
    this._selectedEntry = e.detail;
  }

  private _handleDetailClose(): void {
    this._selectedEntry = null;
  }

  private _handleSelectionChange(e: CustomEvent<string[]>): void {
    this._selectedIds = e.detail;
  }

  private _handleAgentFilterChange(e: Event): void {
    this._agentFilter = (e.target as HTMLSelectElement).value;
    if (this._mode === "browse") {
      this._browseOffset = 0;
      this._browse();
    }
  }

  private _handleDateFromChange(e: Event): void {
    this._dateFrom = (e.target as HTMLInputElement).value;
    if (this._mode === "browse") {
      this._browseOffset = 0;
      this._browse();
    }
  }

  private _handleDateToChange(e: Event): void {
    this._dateTo = (e.target as HTMLInputElement).value;
    if (this._mode === "browse") {
      this._browseOffset = 0;
      this._browse();
    }
  }

  // --- Creation form ---

  private _toggleCreateForm(): void {
    this._createOpen = !this._createOpen;
    if (!this._createOpen) {
      this._createContent = "";
      this._createTags = "";
      this._createTrustLevel = "learned";
      this._createProvenance = "";
      this._createMessage = "";
    }
  }

  private async _submitCreate(): Promise<void> {
    const content = this._createContent.trim();
    if (!content || !this.rpcClient || this._createSubmitting) return;

    this._createSubmitting = true;
    this._createMessage = "";

    try {
      const tags: string[] = this._createTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (this._createProvenance.trim()) {
        tags.push(`provenance:${this._createProvenance.trim()}`);
      }

      await this.rpcClient.call("memory.store", {
        content,
        tags: tags.length > 0 ? tags : undefined,
        trustLevel: this._createTrustLevel,
      });

      this._createMessage = "Memory entry created successfully.";
      this._createMessageType = "success";
      this._createContent = "";
      this._createTags = "";
      this._createProvenance = "";

      // Reload data
      this._loadStats();
      if (this._mode === "browse") {
        this._browse();
      }
    } catch (err) {
      this._createMessage =
        err instanceof Error ? err.message : "Failed to create memory entry.";
      this._createMessageType = "error";
    } finally {
      this._createSubmitting = false;
    }
  }

  // --- Flush ---

  private _openFlushDialog(): void {
    this._flushAgentId = "";
    this._flushDialogOpen = true;
  }

  private async _confirmFlush(): Promise<void> {
    this._flushDialogOpen = false;
    if (!this.rpcClient || this._flushSubmitting) return;

    this._flushSubmitting = true;

    try {
      await this.rpcClient.call("memory.flush", {
        agent_id: this._flushAgentId || undefined,
      });

      // Reload data
      this._loadStats();
      this._results = [];
      this._searched = false;
      if (this._mode === "browse") {
        this._browse();
      }
    } catch (err) {
      this._error =
        err instanceof Error ? err.message : "Flush failed. Please try again.";
    } finally {
      this._flushSubmitting = false;
    }
  }

  private _cancelFlush(): void {
    this._flushDialogOpen = false;
  }

  // --- Bulk operations ---

  private _handleBulkDelete(): void {
    this._confirmOpen = true;
  }

  private async _confirmBulkDelete(): Promise<void> {
    this._confirmOpen = false;
    if (!this.apiClient || this._selectedIds.length === 0) return;

    try {
      await this.apiClient.deleteMemoryBulk(this._selectedIds);
      // Remove deleted entries from results
      const deletedSet = new Set(this._selectedIds);
      this._results = this._results.filter((e) => !deletedSet.has(e.id));
      this._selectedIds = [];
      this._loadStats();
    } catch (err) {
      this._error =
        err instanceof Error ? err.message : "Delete failed. Please try again.";
    }
  }

  private _cancelBulkDelete(): void {
    this._confirmOpen = false;
  }

  private async _handleExport(ids?: string[]): Promise<void> {
    if (!this.apiClient) return;
    try {
      const jsonl = await this.apiClient.exportMemory(ids);
      const blob = new Blob([jsonl], { type: "application/jsonl" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `memory-export-${Date.now()}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      this._error =
        err instanceof Error ? err.message : "Export failed. Please try again.";
    }
  }

  private _handleExportAll(): void {
    this._handleExport();
  }

  private _handleExportSelected(): void {
    this._handleExport(this._selectedIds);
  }

  // --- Entry deleted from detail panel ---

  private async _handleEntryDeleted(e: CustomEvent<string>): Promise<void> {
    if (!this.apiClient) return;
    const entryId = e.detail;
    try {
      await this.apiClient.deleteMemory(entryId);
      this._results = this._results.filter((r) => r.id !== entryId);
      this._selectedEntry = null;
      this._loadStats();
    } catch (err) {
      this._error =
        err instanceof Error ? err.message : "Delete failed. Please try again.";
    }
  }

  // --- Browse pagination ---

  private _handleBrowsePrev(): void {
    this._browseOffset = Math.max(0, this._browseOffset - this._browseLimit);
    this._browse();
  }

  private _handleBrowseNext(): void {
    this._browseOffset += this._browseLimit;
    this._browse();
  }

  // --- Formatting ---

  private _formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = bytes / Math.pow(1024, i);
    return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  private _formatNumber(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  private _formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffDay > 365) {
      const years = Math.floor(diffDay / 365);
      return `${years} year${years !== 1 ? "s" : ""} ago`;
    }
    if (diffDay > 30) {
      const months = Math.floor(diffDay / 30);
      return `${months} month${months !== 1 ? "s" : ""} ago`;
    }
    if (diffDay > 0) return `${diffDay} day${diffDay !== 1 ? "s" : ""} ago`;
    if (diffHr > 0) return `${diffHr} hour${diffHr !== 1 ? "s" : ""} ago`;
    if (diffMin > 0) return `${diffMin} min${diffMin !== 1 ? "s" : ""} ago`;
    return "just now";
  }

  private _formatFullDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  /** Render byAgent horizontal bar chart sorted by count descending. */
  private _renderAgentChart() {
    const byAgent = this._stats?.byAgent;
    if (!byAgent) return nothing;

    const entries = Object.entries(byAgent).sort(([, a], [, b]) => b - a);
    if (entries.length === 0) return nothing;

    const maxCount = entries[0][1];
    const displayed = entries.slice(0, 10);
    const overflow = entries.length - displayed.length;

    return html`
      <div class="agent-chart">
        <div class="agent-chart-title">Entries by Agent</div>
        ${displayed.map(
          ([agentId, count]) => html`
            <div class="bar-container">
              <div class="bar-label" title=${agentId}>${agentId}</div>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  style="width: ${maxCount > 0 ? (count / maxCount) * 100 : 0}%"
                ></div>
              </div>
              <div class="bar-value">${this._formatNumber(count)}</div>
            </div>
          `,
        )}
        ${overflow > 0
          ? html`<div class="agent-chart-overflow">and ${overflow} more</div>`
          : nothing}
      </div>
    `;
  }

  /** Render embedding infrastructure section. */
  private _renderEmbeddingSection() {
    if (!this._embeddingStats) return nothing;
    const stats = this._embeddingStats;

    // Circuit breaker state display
    const cbState = stats.circuitBreaker.state;
    const cbVariant = cbState === "closed" ? "success"
      : cbState === "halfOpen" ? "warning"
      : cbState === "open" ? "error"
      : "default";
    const cbLabel = cbState === "closed" ? "Closed (Healthy)"
      : cbState === "halfOpen" ? "Half-Open (Recovering)"
      : cbState === "open" ? "Open (Failing)"
      : "Unknown";

    // Vec availability
    const vecVariant = stats.vecAvailable ? "success" : "error";
    const vecLabel = stats.vecAvailable ? "Active" : "Unavailable";

    if (!stats.enabled) {
      return html`
        <div class="embedding-section">
          <div class="section-heading">Embedding Infrastructure</div>
          <div class="embedding-disabled">
            <span>Embedding cache not configured</span>
            <span>Vec: <ic-tag variant=${vecVariant}>${vecLabel}</ic-tag></span>
            <span>CB: <ic-tag variant=${cbVariant}>${cbLabel}</ic-tag></span>
          </div>
        </div>
      `;
    }

    const hitRate = stats.l1 ? (stats.l1.hitRate * 100).toFixed(1) + "%" : "N/A";
    const entriesLabel = stats.l1 ? `${stats.l1.entries}/${stats.l1.maxEntries}` : "N/A";

    return html`
      <div class="embedding-section">
        <div class="section-heading">Embedding Infrastructure</div>
        <div class="stats-row">
          <ic-stat-card label="Provider" value=${stats.provider ?? "N/A"}></ic-stat-card>
          <ic-stat-card label="L1 Hit Rate" value=${hitRate}></ic-stat-card>
          <ic-stat-card label="L1 Entries" value=${entriesLabel}></ic-stat-card>
          <ic-stat-card label="Vector Search" value=${vecLabel}></ic-stat-card>
        </div>
        <div class="stats-row">
          <ic-stat-card label="L1 Hits" value=${this._formatNumber(stats.l1?.hits ?? 0)}></ic-stat-card>
          <ic-stat-card label="L1 Misses" value=${this._formatNumber(stats.l1?.misses ?? 0)}></ic-stat-card>
          <ic-stat-card label="Circuit Breaker" value=${cbLabel}></ic-stat-card>
        </div>
      </div>
    `;
  }

  override render() {
    const filtered = this._getFilteredResults();

    return html`
      <div class="page-header">Memory Inspector</div>

      <!-- Stat cards -->
      ${this._statsLoaded && this._stats
        ? html`
            <div class="stats-row">
              <ic-stat-card
                label="Total Entries"
                value=${this._formatNumber(this._stats.totalEntries)}
              ></ic-stat-card>
              <ic-stat-card
                label="Sessions"
                value=${this._formatNumber(this._stats.totalSessions)}
              ></ic-stat-card>
              <ic-stat-card
                label="Vectors"
                value=${this._formatNumber(this._stats.embeddedEntries)}
              ></ic-stat-card>
              <ic-stat-card
                label="DB Size"
                value=${this._formatBytes(this._stats.dbSizeBytes)}
              ></ic-stat-card>
              ${this._stats.oldestCreatedAt != null
                ? html`
                    <ic-stat-card
                      label="Oldest Entry"
                      value=${this._formatRelativeTime(this._stats.oldestCreatedAt)}
                      title=${this._formatFullDate(this._stats.oldestCreatedAt)}
                    ></ic-stat-card>
                  `
                : nothing}
            </div>
            ${this._stats.byType || this._stats.byTrustLevel ? html`
              <div class="stats-row">
                ${this._stats.byType ? Object.entries(this._stats.byType).map(([type, count]) => html`
                  <ic-stat-card label=${type} value=${this._formatNumber(count)}></ic-stat-card>
                `) : nothing}
                ${this._stats.byTrustLevel ? Object.entries(this._stats.byTrustLevel).map(([level, count]) => html`
                  <ic-stat-card label=${"Trust: " + level} value=${this._formatNumber(count)}></ic-stat-card>
                `) : nothing}
              </div>
            ` : nothing}
            ${this._renderAgentChart()}
          `
        : nothing}

      <!-- Embedding Infrastructure -->
      ${this._renderEmbeddingSection()}

      <!-- Creation form -->
      <button class="create-toggle" @click=${this._toggleCreateForm}>
        ${this._createOpen ? "- Hide Create Form" : "+ Create Entry"}
      </button>

      ${this._createOpen
        ? html`
            <div class="create-form">
              <div class="create-form-title">Create Memory Entry</div>

              <div class="create-field">
                <label class="create-label">Content *</label>
                <textarea
                  class="create-textarea"
                  placeholder="Memory content..."
                  .value=${this._createContent}
                  @input=${(e: Event) => { this._createContent = (e.target as HTMLTextAreaElement).value; }}
                ></textarea>
              </div>

              <div class="create-field">
                <label class="create-label">Tags</label>
                <input
                  class="create-input"
                  type="text"
                  placeholder="tag1, tag2, ..."
                  .value=${this._createTags}
                  @input=${(e: Event) => { this._createTags = (e.target as HTMLInputElement).value; }}
                />
              </div>

              <div class="create-field">
                <label class="create-label">Trust Level</label>
                <select
                  class="create-select"
                  .value=${this._createTrustLevel}
                  @change=${(e: Event) => { this._createTrustLevel = (e.target as HTMLSelectElement).value; }}
                >
                  <option value="learned">learned</option>
                  <option value="external">external</option>
                </select>
              </div>

              <div class="create-field">
                <label class="create-label">Provenance</label>
                <input
                  class="create-input"
                  type="text"
                  placeholder="Source description (optional)"
                  .value=${this._createProvenance}
                  @input=${(e: Event) => { this._createProvenance = (e.target as HTMLInputElement).value; }}
                />
              </div>

              <div class="create-actions">
                <button
                  class="create-submit"
                  ?disabled=${!this._createContent.trim() || this._createSubmitting}
                  @click=${this._submitCreate}
                >
                  ${this._createSubmitting ? "Creating..." : "Create"}
                </button>
              </div>

              ${this._createMessage
                ? html`<div class="create-message create-message--${this._createMessageType}">${this._createMessage}</div>`
                : nothing}
            </div>
          `
        : nothing}

      <!-- Mode toggle + search bar + flush -->
      <div class="toolbar">
        <div class="mode-toggle">
          <button
            class="mode-btn"
            ?data-active=${this._mode === "search"}
            @click=${() => this._handleModeChange("search")}
          >
            Search
          </button>
          <button
            class="mode-btn"
            ?data-active=${this._mode === "browse"}
            @click=${() => this._handleModeChange("browse")}
          >
            Browse All
          </button>
        </div>
        ${this._mode === "search"
          ? html`
              <div class="search-wrapper">
                <ic-search-input
                  placeholder="Search memories by content, topic, or keyword..."
                  .value=${this._query}
                  @search=${this._handleSearchEvent}
                ></ic-search-input>
              </div>
            `
          : nothing}
        <div class="toolbar-right">
          <span class="filter-label">Flush scope:</span>
          <select
            class="filter-select"
            .value=${this._flushAgentId}
            @change=${(e: Event) => { this._flushAgentId = (e.target as HTMLSelectElement).value; }}
          >
            <option value="">All Agents</option>
            ${this._agents.map(
              (id) => html`<option value=${id}>${id}</option>`,
            )}
          </select>
          <button class="flush-btn" @click=${this._openFlushDialog}>Flush Memory</button>
        </div>
      </div>

      <!-- Filters row -->
      <div class="filters-row">
        <div class="filter-group">
          <span class="filter-label">Type:</span>
          ${MEMORY_TYPES.map(
            (type) => html`
              <label class="filter-checkbox">
                <input
                  type="checkbox"
                  .checked=${this._typeFilter.has(type)}
                  @change=${() => this._toggleTypeFilter(type)}
                />
                ${type}
              </label>
            `,
          )}
        </div>

        <div class="filter-group">
          <span class="filter-label">Trust:</span>
          ${TRUST_LEVELS.map(
            (level) => html`
              <label class="filter-checkbox">
                <input
                  type="checkbox"
                  .checked=${this._trustFilter.has(level)}
                  @change=${() => this._toggleTrustFilter(level)}
                />
                ${level}
              </label>
            `,
          )}
        </div>

        <div class="filter-group">
          <span class="filter-label">Agent:</span>
          <select
            class="filter-select"
            .value=${this._agentFilter}
            @change=${this._handleAgentFilterChange}
          >
            <option value="">All</option>
            ${this._agents.map(
              (id) => html`<option value=${id}>${id}</option>`,
            )}
          </select>
        </div>

        <div class="filter-group">
          <span class="filter-label">Date:</span>
          <input
            type="date"
            class="filter-date"
            .value=${this._dateFrom}
            @change=${this._handleDateFromChange}
          />
          <span class="filter-label">to</span>
          <input
            type="date"
            class="filter-date"
            .value=${this._dateTo}
            @change=${this._handleDateToChange}
          />
        </div>
      </div>

      <!-- Error -->
      ${this._error
        ? html`<div class="error-message">${this._error}</div>`
        : nothing}

      <!-- Bulk actions bar -->
      ${this._selectedIds.length > 0
        ? html`
            <div class="bulk-bar">
              <span class="bulk-count">${this._selectedIds.length} selected</span>
              <button class="bulk-btn bulk-btn--delete" @click=${this._handleBulkDelete}>
                Delete Selected
              </button>
              <button class="bulk-btn bulk-btn--export" @click=${this._handleExportSelected}>
                Export Selected
              </button>
            </div>
          `
        : nothing}

      <!-- Results area -->
      ${this._loading
        ? html`
            <div class="state-container">
              <div class="loading-spinner"></div>
            </div>
          `
        : !this._searched
          ? html`
              <div class="empty-state">
                <div>Search your agent's memory</div>
                <div class="empty-hint">
                  Enter a query to find stored memories by content or semantic similarity
                </div>
              </div>
            `
          : html`
              <!-- Results header -->
              <div class="results-header">
                <span class="result-count">
                  ${filtered.length} result${filtered.length !== 1 ? "s" : ""}
                  ${this._mode === "browse" && this._total > 0
                    ? html` of ${this._total}`
                    : nothing}
                </span>
                <button class="export-btn" @click=${this._handleExportAll}>
                  Export JSONL
                </button>
              </div>

              <ic-memory-table
                .entries=${filtered}
                ?selectable=${true}
                @detail-requested=${this._handleDetailRequested}
                @selection-change=${this._handleSelectionChange}
              ></ic-memory-table>

              <!-- Browse pagination controls -->
              ${this._mode === "browse"
                ? html`
                    <div class="browse-controls">
                      <span class="browse-info">
                        ${this._browseOffset + 1}-${Math.min(this._browseOffset + this._browseLimit, this._total)}
                        of ${this._total}
                      </span>
                      <div class="browse-nav">
                        <button
                          class="browse-btn"
                          ?disabled=${this._browseOffset === 0}
                          @click=${this._handleBrowsePrev}
                        >
                          Prev
                        </button>
                        <button
                          class="browse-btn"
                          ?disabled=${this._browseOffset + this._browseLimit >= this._total}
                          @click=${this._handleBrowseNext}
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  `
                : nothing}
            `}

      <!-- Detail panel -->
      <ic-detail-panel
        ?open=${this._selectedEntry !== null}
        panelTitle="Memory Entry"
        @close=${this._handleDetailClose}
      >
        <ic-memory-detail
          .entry=${this._selectedEntry}
          @delete-requested=${this._handleEntryDeleted}
          @close=${this._handleDetailClose}
        ></ic-memory-detail>
      </ic-detail-panel>

      <!-- Confirm dialog for bulk delete -->
      <ic-confirm-dialog
        ?open=${this._confirmOpen}
        title="Delete Memories"
        message="Are you sure you want to delete ${this._selectedIds.length} selected ${this._selectedIds.length === 1 ? "entry" : "entries"}? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        @confirm=${this._confirmBulkDelete}
        @cancel=${this._cancelBulkDelete}
      ></ic-confirm-dialog>

      <!-- Flush confirm dialog -->
      <ic-confirm-dialog
        ?open=${this._flushDialogOpen}
        title="Flush Memory"
        .message=${"This will permanently delete " + (this._flushAgentId ? `all memory entries for agent "${this._flushAgentId}"` : "ALL memory entries") + ". This cannot be undone."}
        confirmLabel="Flush"
        variant="danger"
        @confirm=${this._confirmFlush}
        @cancel=${this._cancelFlush}
      ></ic-confirm-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-memory-inspector": IcMemoryInspector;
  }
}
