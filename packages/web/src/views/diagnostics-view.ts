import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { SseController } from "../state/sse-controller.js";
import type { DiagnosticsEvent } from "../api/types/index.js";
import { deriveDiagnosticMessage, deriveDiagnosticLevel } from "../api/types/index.js";

// Side-effect imports (register custom elements)
import "../components/data/ic-time-range-picker.js";
import "../components/data/ic-tag.js";
import "../components/data/ic-relative-time.js";
import "../components/form/ic-filter-chips.js";
import "../components/feedback/ic-loading.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/feedback/ic-empty-state.js";

type LoadState = "loading" | "loaded" | "error";

/** Auto-refresh interval for RPC data in milliseconds. */
const RPC_REFRESH_INTERVAL_MS = 30_000;

/** Default time range: 7 days in milliseconds. */
const DEFAULT_SINCE_MS = 604_800_000;

/** Severity color mapping for ic-tag variants. */
const SEVERITY_COLORS: Record<string, string> = {
  info: "var(--ic-text-dim)",
  warn: "var(--ic-warning)",
  error: "var(--ic-error)",
};

/**
 * Standalone diagnostics view with event log, category/severity filtering,
 * and JSONL export for offline analysis.
 *
 * Data flows: obs.diagnostics RPC -> this view.
 */
@customElement("ic-diagnostics-view")
export class IcDiagnosticsView extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host { display: block; }

      .diagnostics-view { padding: 0; }

      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--ic-space-lg);
        flex-wrap: wrap;
        gap: var(--ic-space-sm);
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: var(--ic-space-md);
      }

      .header-title {
        font-size: var(--ic-text-base);
        font-weight: 600;
        color: var(--ic-text);
      }

      .header-right {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
      }

      .export-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs);
        padding: 0.375rem 0.75rem;
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        font-family: inherit;
        transition: background var(--ic-transition), border-color var(--ic-transition);
      }

      .export-btn:hover:not(:disabled) {
        background: var(--ic-surface-2, #1f2937);
        border-color: var(--ic-text-dim);
      }

      .export-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .export-btn:focus-visible { outline: 2px solid var(--ic-accent); outline-offset: 2px; }

      .filter-section {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm);
        margin-bottom: var(--ic-space-md);
      }

      .filter-group {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
      }

      .filter-label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        min-width: 5rem;
      }

      .summary-bar {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        margin-bottom: var(--ic-space-md);
        font-size: var(--ic-text-sm);
        color: var(--ic-text-dim);
      }

      .event-table {
        display: grid;
        grid-template-columns: auto auto 1fr auto;
        gap: 0;
        font-size: var(--ic-text-sm);
      }

      .table-header {
        display: contents;
      }

      .table-header > .cell {
        font-weight: 600;
        color: var(--ic-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-size: var(--ic-text-xs);
        padding: var(--ic-space-sm) var(--ic-space-md);
        border-bottom: 1px solid var(--ic-border);
      }

      .event-row {
        display: contents;
      }

      .event-row > .cell {
        padding: var(--ic-space-xs) var(--ic-space-md);
        border-bottom: 1px solid var(--ic-border);
        color: var(--ic-text);
        display: flex;
        align-items: center;
      }

      .cell-message {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .error-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
        padding: 3rem;
      }

      .error-message { color: var(--ic-error); font-size: 0.875rem; }

      .retry-btn {
        padding: 0.5rem 1rem;
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: 0.375rem;
        color: var(--ic-text);
        font-size: 0.8125rem;
        cursor: pointer;
        font-family: inherit;
      }

      .retry-btn:hover { background: var(--ic-surface-alt, #374151); }
    `,
  ];

  /* ---- Public properties ---- */

  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  private _sse: SseController | null = null;
  private _reloadDebounce: ReturnType<typeof setTimeout> | null = null;

  /* ---- Internal state ---- */

  @state() private _loadState: LoadState = "loading";
  @state() private _sinceMs = DEFAULT_SINCE_MS;
  @state() private _selectedRange = "7d";
  @state() private _events: DiagnosticsEvent[] = [];
  @state() private _selectedCategories: Set<string> = new Set();
  @state() private _selectedSeverities: Set<string> = new Set();
  @state() private _eventCounts: Record<string, number> = {};

  private _refreshInterval: ReturnType<typeof setInterval> | null = null;
  private _rpcStatusUnsub: (() => void) | null = null;

  /* ---- Lifecycle ---- */

  override connectedCallback(): void {
    super.connectedCallback();
    // Note: _tryLoad() is NOT called here -- rpcClient is typically
    // null at this point. The willUpdate() callback handles loading once
    // the client property is set.
    this._initSse();
  }

  private _initSse(): void {
    if (!this.eventDispatcher || this._sse) return;
    this._sse = new SseController(this, this.eventDispatcher, {
      "observability:reset": () => { this._scheduleReload(); },
    });
  }

  private _scheduleReload(delayMs = 300): void {
    if (this._reloadDebounce !== null) clearTimeout(this._reloadDebounce);
    this._reloadDebounce = setTimeout(() => {
      this._reloadDebounce = null;
      void this._loadData();
    }, delayMs);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._reloadDebounce !== null) {
      clearTimeout(this._reloadDebounce);
      this._reloadDebounce = null;
    }
    if (this._refreshInterval !== null) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }
    this._rpcStatusUnsub?.();
    this._rpcStatusUnsub = null;
  }

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has("rpcClient") && this.rpcClient) {
      this._tryLoad();
    }
    if (changedProperties.has("eventDispatcher") && this.eventDispatcher && !this._sse) {
      this._initSse();
    }
  }

  private _tryLoad(): void {
    if (!this.rpcClient) {
      this._loadState = "loaded";
      return;
    }
    this._rpcStatusUnsub?.();
    if (this.rpcClient.status === "connected") {
      this._startLoading();
    } else {
      this._rpcStatusUnsub = this.rpcClient.onStatusChange((status) => {
        if (status === "connected") {
          this._startLoading();
        }
      });
    }
  }

  private _startLoading(): void {
    this._loadData();
    if (this._refreshInterval === null) {
      this._refreshInterval = setInterval(() => {
        this._loadData();
      }, RPC_REFRESH_INTERVAL_MS);
    }
  }

  /* ---- Data loading ---- */

  private async _loadData(): Promise<void> {
    if (!this.rpcClient || this.rpcClient.status !== "connected") {
      this._loadState = "loaded";
      return;
    }

    const rpc = this.rpcClient;

    try {
      const raw = await rpc.call<Record<string, unknown>>("obs.diagnostics", {
        sinceMs: this._sinceMs,
        limit: 500,
      });

      if (Array.isArray(raw)) {
        this._events = raw;
        this._eventCounts = this._computeCounts(raw);
      } else {
        const events = Array.isArray(raw.events) ? raw.events as DiagnosticsEvent[] : [];
        this._events = events;
        this._eventCounts = (raw.counts as Record<string, number>) ?? this._computeCounts(events);
      }

      this._loadState = "loaded";
    } catch {
      this._loadState = "error";
    }
  }

  private _computeCounts(events: DiagnosticsEvent[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const e of events) {
      counts[e.category] = (counts[e.category] ?? 0) + 1;
    }
    return counts;
  }

  /* ---- Computed properties ---- */

  private get _filteredEvents(): DiagnosticsEvent[] {
    let result = this._events;

    if (this._selectedCategories.size > 0) {
      result = result.filter((e) => this._selectedCategories.has(e.category));
    }

    if (this._selectedSeverities.size > 0) {
      result = result.filter((e) => this._selectedSeverities.has(deriveDiagnosticLevel(e)));
    }

    return result.sort((a, b) => b.timestamp - a.timestamp);
  }

  private get _categoryOptions(): Array<{ value: string; label: string }> {
    const categories = [...new Set(this._events.map((e) => e.category))].sort();
    return categories.map((c) => ({
      value: c,
      label: `${c} (${this._eventCounts[c] ?? 0})`,
    }));
  }

  private get _severityOptions(): Array<{ value: string; label: string; color?: string }> {
    const severities = [...new Set(this._events.map((e) => deriveDiagnosticLevel(e)))].sort();
    return severities.map((s) => ({
      value: s,
      label: s,
      color: SEVERITY_COLORS[s],
    }));
  }

  /* ---- Event handlers ---- */

  private _onTimeRangeChange(e: CustomEvent<{ sinceMs: number; label: string }>): void {
    this._sinceMs = e.detail.sinceMs;
    this._selectedRange = e.detail.label;
    this._loadData();
  }

  private _onCategoryFilter(e: CustomEvent<{ selected: Set<string> }>): void {
    this._selectedCategories = e.detail.selected;
  }

  private _onSeverityFilter(e: CustomEvent<{ selected: Set<string> }>): void {
    this._selectedSeverities = e.detail.selected;
  }

  private _exportJsonl(): void {
    const filtered = this._filteredEvents;
    if (filtered.length === 0) return;

    const jsonl = filtered.map((e) => JSON.stringify(e)).join("\n");
    const blob = new Blob([jsonl], { type: "application/jsonl" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `diagnostics-${new Date().toISOString().slice(0, 10)}.jsonl`;
    a.click();

    URL.revokeObjectURL(url);
  }

  /* ---- Rendering ---- */

  private _renderFilters() {
    return html`
      <div class="filter-section">
        <div class="filter-group">
          <span class="filter-label">Category</span>
          <ic-filter-chips
            .options=${this._categoryOptions}
            .selected=${this._selectedCategories}
            @filter-change=${this._onCategoryFilter}
          ></ic-filter-chips>
        </div>
        <div class="filter-group">
          <span class="filter-label">Severity</span>
          <ic-filter-chips
            .options=${this._severityOptions}
            .selected=${this._selectedSeverities}
            @filter-change=${this._onSeverityFilter}
          ></ic-filter-chips>
        </div>
      </div>
    `;
  }

  private _renderSummary() {
    const filtered = this._filteredEvents;
    return html`
      <div class="summary-bar">
        Showing ${filtered.length} of ${this._events.length} events
      </div>
    `;
  }

  private _renderEventTable() {
    const events = this._filteredEvents;

    if (events.length === 0) {
      return html`<ic-empty-state icon="activity" message="No diagnostic events match your filters"></ic-empty-state>`;
    }

    return html`
      <div class="event-table" role="table" aria-label="Diagnostic events">
        <div class="table-header" role="row">
          <div class="cell" role="columnheader">Timestamp</div>
          <div class="cell" role="columnheader">Category</div>
          <div class="cell" role="columnheader">Message</div>
          <div class="cell" role="columnheader">Severity</div>
        </div>
        ${events.map(
          (evt) => html`
            <div class="event-row" role="row">
              <div class="cell" role="cell">
                <ic-relative-time .timestamp=${evt.timestamp}></ic-relative-time>
              </div>
              <div class="cell" role="cell">
                <ic-tag>${evt.category}</ic-tag>
              </div>
              <div class="cell cell-message" role="cell" title=${deriveDiagnosticMessage(evt)}>
                ${deriveDiagnosticMessage(evt)}
              </div>
              <div class="cell" role="cell">
                <ic-tag
                  style="--tag-color: ${SEVERITY_COLORS[deriveDiagnosticLevel(evt)] ?? "var(--ic-text-dim)"}"
                >${deriveDiagnosticLevel(evt)}</ic-tag>
              </div>
            </div>
          `,
        )}
      </div>
    `;
  }

  override render() {
    if (this._loadState === "loading" && !this.rpcClient) {
      return html`<ic-skeleton-view variant="table"></ic-skeleton-view>`;
    }

    if (this._loadState === "error") {
      return html`
        <div class="error-container">
          <span class="error-message">Failed to load diagnostics data</span>
          <button class="retry-btn" @click=${() => this._tryLoad()}>Retry</button>
        </div>
      `;
    }

    const filtered = this._filteredEvents;

    return html`
      <div class="diagnostics-view">
        <div class="header">
          <div class="header-left">
            <span class="header-title">Diagnostics</span>
          </div>
          <div class="header-right">
            <button
              class="export-btn"
              ?disabled=${filtered.length === 0}
              @click=${this._exportJsonl}
            >
              Export JSONL (${filtered.length} events)
            </button>
            <ic-time-range-picker
              .selected=${this._selectedRange}
              @time-range-change=${this._onTimeRangeChange}
            ></ic-time-range-picker>
          </div>
        </div>
        ${this._events.length > 0 ? this._renderFilters() : nothing}
        ${this._renderSummary()}
        ${this._renderEventTable()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-diagnostics-view": IcDiagnosticsView;
  }
}
