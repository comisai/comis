// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { DeliveryStats, DeliveryTrace, DeliveryStep } from "../api/types/index.js";
import { systemClearInterval, systemDateFrom, systemSetInterval } from "@comis/core";

// Side-effect imports (register custom elements)
import "../components/data/ic-stat-card.js";
import "../components/data/ic-metric-gauge.js";
import "../components/data/ic-time-range-picker.js";
import "../components/data/ic-trace-timeline.js";
import "../components/data/ic-relative-time.js";
import "../components/domain/ic-delivery-row.js";
import "../components/layout/ic-detail-panel.js";
import "../components/feedback/ic-loading.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/feedback/ic-empty-state.js";

type LoadState = "loading" | "loaded" | "error";

/** Auto-refresh interval for RPC data in milliseconds. */
const RPC_REFRESH_INTERVAL_MS = 30_000;

/** Default time range: 7 days in milliseconds. */
const DEFAULT_SINCE_MS = 604_800_000;

interface DeliveryRecord {
  readonly sourceChannelId: string;
  readonly sourceChannelType: string;
  readonly targetChannelType: string;
  readonly targetChannelId: string;
  readonly deliveredAt: number;
  readonly latencyMs: number;
  readonly status: unknown;
  readonly error: unknown;
  readonly traceId: string | null;
  readonly failureStage: unknown;
  readonly errorKind: unknown;
  readonly steps: ReadonlyArray<DeliveryStep> | null;
}

function normalizeDeliveryStatus(status: unknown): DeliveryTrace["status"] {
  switch (status) {
    case "success":
    case "error":
    case "timeout":
    case "filtered":
    case "aborted":
      return status;
    default:
      return "error";
  }
}

/**
 * Standalone delivery view with success rate gauge, P50/P95/P99 latency stats,
 * searchable/filterable trace table, and detail drawer with trace timeline.
 *
 * Data flows: obs.delivery.stats + obs.delivery.recent RPC -> this view.
 */
@customElement("ic-delivery-view")
export class IcDeliveryView extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host { display: block; }

      .delivery-view { padding: 0; }

      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--ic-space-lg);
        flex-wrap: wrap;
        gap: var(--ic-space-sm);
      }

      .header-title {
        font-size: var(--ic-text-base);
        font-weight: 600;
        color: var(--ic-text);
      }

      .stats-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: var(--ic-space-md);
        margin-bottom: var(--ic-space-lg);
      }

      .filter-row {
        display: flex;
        gap: var(--ic-space-sm);
        flex-wrap: wrap;
        margin-bottom: var(--ic-space-md);
        align-items: center;
      }

      .filter-input {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        padding: 0.375rem 0.625rem;
        font-size: var(--ic-text-sm);
        font-family: inherit;
        min-width: 12rem;
      }

      .filter-input::placeholder { color: var(--ic-text-dim); }
      .filter-input:focus-visible { outline: 2px solid var(--ic-accent); outline-offset: 2px; }

      .filter-select {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        padding: 0.375rem 0.625rem;
        font-size: var(--ic-text-sm);
        cursor: pointer;
        font-family: inherit;
      }

      .filter-select:focus-visible { outline: 2px solid var(--ic-accent); outline-offset: 2px; }

      .filter-count {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        margin-left: auto;
      }

      .trace-table {
        display: grid;
        grid-template-columns: auto auto 1fr auto auto auto;
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

      .section { margin-bottom: var(--ic-space-xl); }

      .section-title {
        font-size: var(--ic-text-base);
        font-weight: 600;
        color: var(--ic-text);
        margin-bottom: var(--ic-space-md);
      }

      .card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-lg);
      }

      /* Detail drawer content */
      .detail-cards {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--ic-space-sm);
        margin-bottom: var(--ic-space-lg);
      }

      .detail-card {
        background: var(--ic-surface-2, #1f2937);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm) var(--ic-space-md);
      }

      .detail-card-label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .detail-card-value {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text);
        margin-top: 2px;
      }

      .detail-card-value.status-success { color: var(--ic-success); }
      .detail-card-value.status-error { color: var(--ic-error); }
      .detail-card-value.status-timeout { color: var(--ic-warning); }
      .detail-card-value.status-filtered { color: var(--ic-text-dim); }
      .detail-card-value.status-aborted { color: var(--ic-warning); }

      .no-steps {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-dim);
        font-style: italic;
      }

      /* Per-channel success rates */
      .channel-rates {
        display: flex;
        gap: var(--ic-space-md);
        flex-wrap: wrap;
        margin-top: var(--ic-space-sm);
      }

      .channel-rate {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      .channel-rate-value {
        font-weight: 600;
        font-family: var(--ic-font-mono, ui-monospace, monospace);
      }

      .channel-rate-value.rate-good { color: var(--ic-success); }
      .channel-rate-value.rate-warn { color: var(--ic-warning); }
      .channel-rate-value.rate-bad { color: var(--ic-error); }

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

  /* ---- Internal state ---- */

  @state() private _loadState: LoadState = "loading";
  @state() private _sinceMs = DEFAULT_SINCE_MS;
  @state() private _selectedRange = "7d";
  @state() private _searchQuery = "";
  @state() private _statusFilter = "all";
  @state() private _channelFilter = "all";
  @state() private _deliveryStats: DeliveryStats | null = null;
  @state() private _traces: DeliveryTrace[] = [];
  @state() private _selectedTrace: DeliveryTrace | null = null;
  @state() private _detailOpen = false;
  @state() private _latencyPercentiles: { p50: number; p95: number; p99: number } | null = null;

  private _refreshInterval: ReturnType<typeof setInterval> | null = null;
  private _rpcStatusUnsub: (() => void) | null = null;

  private _fmtNum = new Intl.NumberFormat("en-US");

  /* ---- Lifecycle ---- */

  override connectedCallback(): void {
    super.connectedCallback();
    // Note: _tryLoad() is NOT called here -- rpcClient is typically
    // null at this point. The willUpdate() callback handles loading once
    // the client property is set.
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._refreshInterval !== null) {
      systemClearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }
    this._rpcStatusUnsub?.();
    this._rpcStatusUnsub = null;
  }

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has("rpcClient") && this.rpcClient) {
      this._tryLoad();
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
      this._refreshInterval = systemSetInterval(() => {
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
      const [statsResult, tracesResult] = await Promise.allSettled([
        rpc.call("obs.delivery.stats", { sinceMs: this._sinceMs }),
        rpc.call("obs.delivery.recent", { sinceMs: this._sinceMs, limit: 200 }),
      ]);

      if (statsResult.status === "rejected" && tracesResult.status === "rejected") {
        throw statsResult.reason;
      }

      if (statsResult.status === "fulfilled") {
        this._deliveryStats = statsResult.value;
      } else {
        this._deliveryStats = null;
      }

      if (tracesResult.status === "fulfilled") {
        this._traces = tracesResult.value.deliveries.map((delivery) => this._normalizeTrace(delivery));
      } else {
        this._traces = [];
        this._selectedTrace = null;
        this._detailOpen = false;
      }

      this._computeLatencyPercentiles();
      this._loadState = "loaded";
    } catch {
      this._loadState = "error";
    }
  }

  private _normalizeTrace(delivery: DeliveryRecord): DeliveryTrace {
    const steps = delivery.steps ?? [];
    return {
      traceId: delivery.traceId ?? `${delivery.sourceChannelId}-${delivery.deliveredAt}`,
      timestamp: delivery.deliveredAt,
      sourceChannelType: delivery.sourceChannelType,
      targetChannelType: delivery.targetChannelType,
      status: normalizeDeliveryStatus(delivery.status),
      latencyMs: delivery.latencyMs,
      error: typeof delivery.error === "string" ? delivery.error : null,
      failureStage: delivery.failureStage === "execution" || delivery.failureStage === "delivery"
        ? delivery.failureStage
        : null,
      errorKind: typeof delivery.errorKind === "string" ? delivery.errorKind : null,
      stepCount: steps.length,
      steps,
    };
  }

  private _computeLatencyPercentiles(): void {
    const values = this._traces
      .filter((trace) =>
        trace.status === "success" || trace.status === "error" || trace.status === "timeout",
      )
      .map((t) => t.latencyMs)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);

    if (values.length === 0) {
      this._latencyPercentiles = null;
      return;
    }

    const nearestRank = (percentile: number): number =>
      values[Math.max(0, Math.ceil(values.length * percentile) - 1)]!;
    this._latencyPercentiles = {
      p50: nearestRank(0.50),
      p95: nearestRank(0.95),
      p99: nearestRank(0.99),
    };
  }

  /* ---- Computed properties ---- */

  private get _filteredTraces(): DeliveryTrace[] {
    let result = this._traces;

    if (this._searchQuery) {
      const q = this._searchQuery.toLowerCase();
      result = result.filter(
        (t) =>
          t.traceId.toLowerCase().includes(q) ||
          t.sourceChannelType.toLowerCase().includes(q) ||
          t.targetChannelType.toLowerCase().includes(q),
      );
    }

    if (this._statusFilter !== "all") {
      result = result.filter((t) => t.status === this._statusFilter);
    }

    if (this._channelFilter !== "all") {
      result = result.filter((t) => t.targetChannelType === this._channelFilter);
    }

    return result;
  }

  private get _uniqueChannels(): string[] {
    return [...new Set(this._traces.map((t) => t.targetChannelType))].sort();
  }

  private get _successRate(): number | null {
    if (this._deliveryStats) {
      return this._deliveryStats.attempted > 0
        ? Math.round((this._deliveryStats.success / this._deliveryStats.attempted) * 100)
        : null;
    }
    const attempted = this._traces.filter(
      (trace) => trace.status === "success" || trace.status === "error" || trace.status === "timeout",
    );
    if (attempted.length === 0) return null;
    const successes = attempted.filter((trace) => trace.status === "success").length;
    return Math.round((successes / attempted.length) * 100);
  }

  private get _channelRates(): Array<{ channel: string; rate: number }> {
    const groups = new Map<string, { ok: number; total: number }>();
    for (const t of this._traces) {
      if (t.status === "filtered" || t.status === "aborted") continue;
      const g = groups.get(t.targetChannelType) ?? { ok: 0, total: 0 };
      g.total++;
      if (t.status === "success") g.ok++;
      groups.set(t.targetChannelType, g);
    }
    return [...groups.entries()]
      .map(([channel, g]) => ({ channel, rate: Math.round((g.ok / g.total) * 100) }))
      .sort((a, b) => a.channel.localeCompare(b.channel));
  }

  /* ---- Event handlers ---- */

  private _onTimeRangeChange(e: CustomEvent<{ sinceMs: number; label: string }>): void {
    this._sinceMs = e.detail.sinceMs;
    this._selectedRange = e.detail.label;
    this._loadData();
  }

  private _onSearchInput(e: Event): void {
    this._searchQuery = (e.target as HTMLInputElement).value;
  }

  private _onStatusFilter(e: Event): void {
    this._statusFilter = (e.target as HTMLSelectElement).value;
  }

  private _onChannelFilter(e: Event): void {
    this._channelFilter = (e.target as HTMLSelectElement).value;
  }

  private _onTraceClick(e: CustomEvent<string>): void {
    const trace = this._traces.find((t) => t.traceId === e.detail);
    if (trace) {
      this._selectedTrace = trace;
      this._detailOpen = true;
    }
  }

  private _closeDetail(): void {
    this._detailOpen = false;
    this._selectedTrace = null;
  }

  /* ---- Formatters ---- */

  private _formatLatency(ms: number | null, approximate = false): string {
    if (ms == null) return "--";
    const prefix = approximate ? "~" : "";
    if (ms >= 1000) return `${prefix}${(ms / 1000).toFixed(1)}s`;
    return `${prefix}${ms}ms`;
  }

  private _rateClass(rate: number): string {
    if (rate >= 95) return "rate-good";
    if (rate >= 90) return "rate-warn";
    return "rate-bad";
  }

  /* ---- Rendering ---- */

  private _renderStats() {
    const rate = this._successRate;
    const p = this._latencyPercentiles;
    const approximate = this._traces.length < 10
      || (this._deliveryStats?.total ?? this._traces.length) > this._traces.length;
    const total = this._deliveryStats?.total ?? this._traces.length;

    return html`
      <div class="stats-row">
        <ic-stat-card
          label="Success Rate"
          .value=${rate === null ? "N/A" : `${rate}%`}
        ></ic-stat-card>
        <ic-stat-card
          label="P50 Latency"
          .value=${p ? this._formatLatency(p.p50, approximate) : "--"}
        ></ic-stat-card>
        <ic-stat-card
          label="P95 Latency"
          .value=${p ? this._formatLatency(p.p95, approximate) : "--"}
        ></ic-stat-card>
        <ic-stat-card
          label="P99 Latency"
          .value=${p ? this._formatLatency(p.p99, approximate) : "--"}
        ></ic-stat-card>
        <ic-stat-card
          label="Total Deliveries"
          .value=${this._fmtNum.format(total)}
        ></ic-stat-card>
      </div>
      ${this._channelRates.length > 1
        ? html`
            <div class="channel-rates">
              ${this._channelRates.map(
                (cr) => html`
                  <span class="channel-rate">
                    ${cr.channel}:
                    <span class="channel-rate-value ${this._rateClass(cr.rate)}">${cr.rate}%</span>
                  </span>
                `,
              )}
            </div>
          `
        : nothing}
    `;
  }

  private _renderFilters() {
    const filtered = this._filteredTraces;

    return html`
      <div class="filter-row">
        <input
          class="filter-input"
          type="text"
          placeholder="Search traces..."
          .value=${this._searchQuery}
          @input=${this._onSearchInput}
        />
        <select class="filter-select" @change=${this._onStatusFilter}>
          <option value="all">All Status</option>
          <option value="success" ?selected=${this._statusFilter === "success"}>Success</option>
          <option value="error" ?selected=${this._statusFilter === "error"}>Error</option>
          <option value="timeout" ?selected=${this._statusFilter === "timeout"}>Timeout</option>
          <option value="filtered" ?selected=${this._statusFilter === "filtered"}>Filtered</option>
          <option value="aborted" ?selected=${this._statusFilter === "aborted"}>Aborted</option>
        </select>
        <select class="filter-select" @change=${this._onChannelFilter}>
          <option value="all">All Destinations</option>
          ${this._uniqueChannels.map(
            (ch) => html`<option value=${ch} ?selected=${this._channelFilter === ch}>${ch}</option>`,
          )}
        </select>
        <span class="filter-count">Showing ${filtered.length} of ${this._traces.length} traces</span>
      </div>
    `;
  }

  private _renderTraceTable() {
    const traces = this._filteredTraces;

    if (traces.length === 0) {
      return html`<ic-empty-state icon="activity" message="No delivery traces match your filters"></ic-empty-state>`;
    }

    return html`
      <div class="trace-table" role="table" aria-label="Delivery traces">
        <div class="table-header" role="row">
          <div class="cell" role="columnheader">Time</div>
          <div class="cell" role="columnheader">Destination</div>
          <div class="cell" role="columnheader">Trace</div>
          <div class="cell" role="columnheader">Status</div>
          <div class="cell" role="columnheader">Latency</div>
          <div class="cell" role="columnheader">Steps</div>
        </div>
        ${traces.map(
          (t) => html`
            <ic-delivery-row
              .trace=${t}
              @trace-click=${this._onTraceClick}
            ></ic-delivery-row>
          `,
        )}
      </div>
    `;
  }

  private _renderDetailDrawer() {
    const t = this._selectedTrace;
    if (!t) return nothing;

    const steps = (t.steps ?? []) as DeliveryStep[];
    const timestamp = systemDateFrom(t.timestamp).toLocaleString();

    return html`
      <ic-detail-panel
        ?open=${this._detailOpen}
        .panelTitle=${"Trace " + t.traceId.slice(0, 16)}
        @close=${this._closeDetail}
      >
        <div class="detail-cards">
          <div class="detail-card">
            <div class="detail-card-label">Source</div>
            <div class="detail-card-value">${t.sourceChannelType}</div>
          </div>
          <div class="detail-card">
            <div class="detail-card-label">Destination</div>
            <div class="detail-card-value">${t.targetChannelType}</div>
          </div>
          <div class="detail-card">
            <div class="detail-card-label">Status</div>
            <div class="detail-card-value status-${t.status}">${t.status}</div>
          </div>
          <div class="detail-card">
            <div class="detail-card-label">Failure Stage</div>
            <div class="detail-card-value">${t.failureStage ?? "--"}</div>
          </div>
          <div class="detail-card">
            <div class="detail-card-label">Error Kind</div>
            <div class="detail-card-value">${t.errorKind ?? "--"}</div>
          </div>
          <div class="detail-card">
            <div class="detail-card-label">Error</div>
            <div class="detail-card-value">${t.error ?? "--"}</div>
          </div>
          <div class="detail-card">
            <div class="detail-card-label">Latency</div>
            <div class="detail-card-value">${this._formatLatency(t.latencyMs)}</div>
          </div>
          <div class="detail-card">
            <div class="detail-card-label">Timestamp</div>
            <div class="detail-card-value">${timestamp}</div>
          </div>
        </div>

        <div class="section-title">Execution Timeline</div>
        ${steps.length > 0
          ? html`<ic-trace-timeline .steps=${steps}></ic-trace-timeline>`
          : html`<p class="no-steps">No step details available</p>`}
      </ic-detail-panel>
    `;
  }

  override render() {
    if (this._loadState === "loading" && !this.rpcClient) {
      return html`<ic-skeleton-view variant="table"></ic-skeleton-view>`;
    }

    if (this._loadState === "error") {
      return html`
        <div class="error-container">
          <span class="error-message">Failed to load delivery data</span>
          <button class="retry-btn" @click=${() => this._tryLoad()}>Retry</button>
        </div>
      `;
    }

    return html`
      <div class="delivery-view">
        <div class="header">
          <span class="header-title">Delivery</span>
          <ic-time-range-picker
            .selected=${this._selectedRange}
            @time-range-change=${this._onTimeRangeChange}
          ></ic-time-range-picker>
        </div>
        ${this._renderStats()}
        ${this._renderFilters()}
        ${this._renderTraceTable()}
        ${this._renderDetailDrawer()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-delivery-view": IcDeliveryView;
  }
}
