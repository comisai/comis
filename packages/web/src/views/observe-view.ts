// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { SseController } from "../state/sse-controller.js";
import { getHealthVisual } from "../utils/health-status.js";
import type { HealthSeverity } from "../utils/health-status.js";
import {
  deriveDiagnosticMessage,
  deriveDiagnosticLevel,
} from "../api/types/index.js";
import type {
  BillingTotal,
  DeliveryStats,
  DeliveryTrace,
  BillingByProvider,
  BillingByAgent,
  DiagnosticsEvent,
  TokenUsagePoint,
  ChannelActivity,
} from "../api/types/index.js";
import type { TabDef } from "../components/nav/ic-tabs.js";

// Side-effect imports (register custom elements)
import "../components/nav/ic-tabs.js";
import "../components/data/ic-stat-card.js";
import "../components/data/ic-sparkline.js";
import "../components/data/ic-tag.js";
import "../components/data/ic-relative-time.js";
import "../components/feedback/ic-loading.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/feedback/ic-empty-state.js";
import "../components/feedback/ic-toast.js";
import "../components/domain/ic-delivery-row.js";

type LoadState = "loading" | "loaded" | "error";

/** Auto-refresh interval for RPC data in milliseconds. */
const RPC_REFRESH_INTERVAL_MS = 30_000;

/** Tab definitions for the observability view. */
const TAB_DEFS: TabDef[] = [
  { id: "overview", label: "Overview" },
  { id: "billing", label: "Billing" },
  { id: "delivery", label: "Delivery" },
  { id: "channels", label: "Channels" },
  { id: "diagnostics", label: "Diagnostics" },
];

/** Agent health entry from agents.list + agents.get RPCs. */
interface AgentHealthEntry {
  agentId: string;
  config: Record<string, unknown>;
  suspended: boolean;
  isDefault: boolean;
}

/** Channel health entry from channels.list RPC. */
interface ChannelHealthEntry {
  channelType: string;
  channelId?: string;
  status: string;
  connectionMode?: string;
  lastMessageAt?: number;
  lastError?: string;
}

/**
 * Unified observability view with Overview, Billing, Delivery, Channels, and Diagnostics tabs.
 *
 * Overview: 6 stat cards (requests/min, error rate, avg latency, active sessions, token usage 24h,
 * cost today), time-series charts (token usage bar chart, cost sparkline, error sparkline),
 * agent/channel health grids, and reset button with double confirmation.
 * Billing: Provider breakdown table (5 cols) and agent breakdown table (4 cols).
 * Delivery: Filterable delivery trace table with channel/status/time range filters and click-to-expand detail.
 * Channels: Per-channel metrics table with stale channel alerts and sorting.
 * Diagnostics: Event table with timestamp, category, message, and severity level badge.
 *
 * Loads data via RPC client with 30s auto-refresh and graceful degradation.
 */
@customElement("ic-observe-view")
export class IcObserveView extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .observe-view {
        padding: 0;
      }

      /* Stats row */
      .stats-row {
        display: flex;
        gap: var(--ic-space-md);
        flex-wrap: wrap;
        margin-bottom: var(--ic-space-lg);
      }

      .stats-row ic-stat-card {
        min-width: 10rem;
      }

      /* Section styles */
      .section {
        margin-bottom: var(--ic-space-xl);
      }

      .section-title {
        font-size: var(--ic-text-base);
        font-weight: 600;
        color: var(--ic-text);
        margin-bottom: var(--ic-space-md);
      }

      /* Chart container */
      .chart-container {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-lg);
      }

      .chart-labels {
        display: flex;
        justify-content: space-between;
        color: var(--ic-text-dim);
        font-size: var(--ic-text-xs);
        margin-top: var(--ic-space-xs);
      }

      /* Grid table styles */
      .grid-table {
        display: grid;
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        overflow: hidden;
      }

      .grid-table-scroll {
        overflow-x: auto;
      }

      .provider-table {
        grid-template-columns: 1fr repeat(3, auto);
      }

      .agent-table {
        grid-template-columns: 1fr repeat(3, auto);
      }

      .diagnostics-table {
        grid-template-columns: auto auto 1fr auto;
      }

      .grid-header {
        display: contents;
      }

      .grid-header .cell {
        background: var(--ic-surface-2, #1f2937);
        font-weight: 600;
        color: var(--ic-text-dim);
        font-size: var(--ic-text-xs);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .grid-row {
        display: contents;
      }

      .grid-row:hover .cell {
        background: var(--ic-surface-2, #1f2937);
      }

      .cell {
        padding: var(--ic-space-sm);
        font-size: var(--ic-text-sm);
        border-bottom: 1px solid var(--ic-border);
        display: flex;
        align-items: center;
      }

      .cell-mono {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
      }

      .cell-right {
        justify-content: flex-end;
      }

      .total-row .cell {
        font-weight: 600;
        background: var(--ic-surface);
      }

      /* Loading & error states */
      .state-container {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 3rem;
        color: var(--ic-text-dim);
        font-size: 0.875rem;
      }

      .error-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
        padding: 3rem;
      }

      .error-message {
        color: var(--ic-error);
        font-size: 0.875rem;
      }

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

      .retry-btn:hover {
        background: var(--ic-surface-alt, #374151);
      }

      .tab-content {
        padding-top: var(--ic-space-md);
      }

      /* Delivery tab styles */
      .delivery-table {
        grid-template-columns: auto auto 1fr auto auto auto;
      }

      .filter-row {
        display: flex;
        gap: var(--ic-space-sm);
        flex-wrap: wrap;
        margin-bottom: var(--ic-space-md);
        align-items: center;
      }

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

      .filter-select:focus-visible {
        outline: 2px solid var(--ic-accent);
        outline-offset: 2px;
      }

      .stats-summary {
        display: flex;
        gap: var(--ic-space-lg);
        font-size: var(--ic-text-sm);
        color: var(--ic-text-dim);
        margin-bottom: var(--ic-space-md);
        padding: var(--ic-space-sm) 0;
      }

      .stats-summary .stat-value {
        font-weight: 600;
        color: var(--ic-text);
      }

      .stats-summary .rate-green {
        color: var(--ic-success);
      }

      .stats-summary .rate-yellow {
        color: var(--ic-warning);
      }

      .stats-summary .rate-red {
        color: var(--ic-error);
      }

      .trace-detail {
        grid-column: 1 / -1;
        background: var(--ic-surface-2, #1f2937);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
        margin: var(--ic-space-xs) 0;
      }

      .trace-detail-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text);
      }

      .step-list {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
        margin-top: var(--ic-space-sm);
      }

      .step-item {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        font-size: var(--ic-text-sm);
      }

      .step-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .step-dot.ok {
        background: var(--ic-success);
      }

      .step-dot.error {
        background: var(--ic-error);
      }

      .step-error {
        color: var(--ic-error);
        font-size: var(--ic-text-xs);
        margin-left: calc(8px + var(--ic-space-sm));
      }

      /* Channel tab styles */
      .channel-table {
        grid-template-columns: auto 1fr auto auto auto auto;
      }

      .stale-alert {
        background: rgba(251, 191, 36, 0.1);
        border: 1px solid var(--ic-warning);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm) var(--ic-space-md);
        color: var(--ic-warning);
        font-size: var(--ic-text-sm);
        margin-bottom: var(--ic-space-md);
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
      }

      .stale .cell {
        background: rgba(251, 191, 36, 0.05);
      }

      /* Overview: 6-card grid */
      .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--ic-space-md);
        margin-bottom: var(--ic-space-lg);
      }

      /* Overview: charts section */
      .charts-section {
        display: grid;
        grid-template-columns: 2fr 1fr;
        gap: var(--ic-space-lg);
        margin-bottom: var(--ic-space-xl);
      }

      @media (max-width: 768px) {
        .charts-section {
          grid-template-columns: 1fr;
        }
      }

      .chart-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text);
        margin-bottom: var(--ic-space-sm);
      }

      /* Bar chart for token usage */
      .bar-chart {
        display: flex;
        align-items: flex-end;
        gap: 2px;
        height: 120px;
        padding: var(--ic-space-sm) 0;
      }

      .bar-chart .bar {
        flex: 1;
        background: var(--ic-accent);
        border-radius: 2px 2px 0 0;
        min-width: 4px;
        transition: opacity 0.15s;
      }

      .bar-chart .bar:hover {
        opacity: 0.8;
      }

      /* Overview: health grids section */
      .health-grids {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--ic-space-lg);
        margin-bottom: var(--ic-space-xl);
      }

      @media (max-width: 768px) {
        .health-grids {
          grid-template-columns: 1fr;
        }
      }

      .health-grid-table {
        grid-template-columns: 1fr 1fr auto;
      }

      .health-empty {
        color: var(--ic-text-dim);
        font-size: var(--ic-text-sm);
        font-style: italic;
        padding: var(--ic-space-lg);
        text-align: center;
      }

      /* Overview: reset section */
      .reset-section {
        border: 1px solid var(--ic-error);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-lg);
        margin-top: var(--ic-space-xl);
      }

      .reset-section .section-title {
        color: var(--ic-error);
      }

      .reset-btn {
        padding: 0.5rem 1rem;
        background: color-mix(in srgb, var(--ic-error) 15%, transparent);
        border: 1px solid var(--ic-error);
        border-radius: var(--ic-radius-md);
        color: var(--ic-error);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        font-family: inherit;
        font-weight: 500;
      }

      .reset-btn:hover {
        background: color-mix(in srgb, var(--ic-error) 25%, transparent);
      }

      .reset-warning {
        color: var(--ic-text-dim);
        font-size: var(--ic-text-sm);
        margin-bottom: var(--ic-space-md);
      }

      .reset-input {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        padding: 0.375rem 0.625rem;
        font-size: var(--ic-text-sm);
        font-family: inherit;
        margin-bottom: var(--ic-space-md);
        width: 12rem;
      }

      .reset-input:focus-visible {
        outline: 2px solid var(--ic-error);
        outline-offset: 2px;
      }

      .reset-actions {
        display: flex;
        gap: var(--ic-space-sm);
      }

      .reset-cancel-btn {
        padding: 0.5rem 1rem;
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        font-family: inherit;
      }

      .reset-confirm-btn {
        padding: 0.5rem 1rem;
        border: none;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        font-family: inherit;
        font-weight: 500;
      }

      .reset-confirm-btn[disabled] {
        background: var(--ic-surface);
        color: var(--ic-text-dim);
        cursor: not-allowed;
      }

      .reset-confirm-btn:not([disabled]) {
        background: var(--ic-error);
        color: #fff;
      }

      .sparkline-side {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-lg);
      }
    `,
  ];

  /* ---- Public properties ---- */

  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;
  @property() initialTab = "overview";

  private _sse: SseController | null = null;
  private _reloadDebounce: ReturnType<typeof setTimeout> | null = null;

  /* ---- Internal state ---- */

  @state() private _loadState: LoadState = "loading";
  @state() private _activeTab = "overview";
  @state() private _error = "";

  // Overview data
  @state() private _requestsToday = 0;
  @state() private _tokensToday = 0;
  @state() private _costToday = 0;
  @state() private _errorsToday = 0;
  @state() private _tokenUsage24h: TokenUsagePoint[] = [];

  // Billing data
  @state() private _billingByProvider: BillingByProvider[] = [];
  @state() private _billingByAgent: BillingByAgent[] = [];
  @state() private _billingTotal: BillingTotal | null = null;

  // Diagnostics data
  @state() private _diagnosticsEvents: DiagnosticsEvent[] = [];

  // Delivery data
  @state() private _deliveryTraces: DeliveryTrace[] = [];
  @state() private _deliveryStats: DeliveryStats | null = null;

  // Channel data
  @state() private _channelActivity: ChannelActivity[] = [];

  // Overview: enhanced data
  @state() private _agentHealth: AgentHealthEntry[] = [];
  @state() private _channelHealth: ChannelHealthEntry[] = [];
  @state() private _resetConfirming = false;
  @state() private _resetInput = "";

  // Delivery tab filter state
  @state() private _deliveryChannelFilter = "all";
  @state() private _deliveryStatusFilter = "all";
  @state() private _deliveryTimeRange = "1h";
  @state() private _expandedTraceId: string | null = null;

  private _refreshInterval: ReturnType<typeof setInterval> | null = null;
  private _rpcStatusUnsub: (() => void) | null = null;

  /* ---- Lifecycle ---- */

  override connectedCallback(): void {
    super.connectedCallback();
    this._activeTab = this.initialTab;
    // Note: _tryLoad() is NOT called here -- rpcClient is typically
    // null at this point. The willUpdate() callback handles loading once
    // the client property is set.
    this._initSse();
  }

  private _initSse(): void {
    if (!this.eventDispatcher || this._sse) return;
    this._sse = new SseController(this, this.eventDispatcher, {
      "observability:metrics": () => { this._scheduleReload(500); },
      "observability:token_usage": () => { this._scheduleReload(); },
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
    if (changedProperties.has("initialTab")) {
      this._activeTab = this.initialTab;
    }
    if (changedProperties.has("rpcClient")) {
      if (this.rpcClient) {
        this._tryLoad();
      } else {
        this._loadState = "loaded";
      }
    }
    if (changedProperties.has("eventDispatcher") && this.eventDispatcher && !this._sse) {
      this._initSse();
    }
  }

  /** Wait for RPC connection before loading data. */
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
    // Set up auto-refresh if not already running
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

    // Fire all independent RPC calls in parallel
    const [
      deliveryResult,
      billingResult,
      usage24hResult,
      byProviderResult,
      diagnosticsResult,
      deliveryRecentResult,
      channelActivityResult,
      agentListResult,
      channelListResult,
    ] = await Promise.allSettled([
      rpc.call<Record<string, unknown>>("obs.delivery.stats"),
      rpc.call<Record<string, unknown>>("obs.billing.total"),
      rpc.call<unknown>("obs.billing.usage24h"),
      rpc.call<unknown>("obs.billing.byProvider"),
      rpc.call<unknown>("obs.diagnostics"),
      rpc.call<unknown>("obs.delivery.recent"),
      rpc.call<unknown>("obs.channels.all"),
      rpc.call<Record<string, unknown>>("agents.list"),
      rpc.call<Record<string, unknown>>("channels.list"),
    ]);

    let anySuccess = false;
    let lastError = "";

    // Overview: delivery stats
    if (deliveryResult.status === "fulfilled") {
      const raw = deliveryResult.value;
      const total = Number(raw.total ?? raw.totalDelivered ?? 0);
      const failures = Number(raw.failures ?? raw.failed ?? 0);
      let successRate = 0;
      if (raw.successRate !== undefined) {
        successRate = Number(raw.successRate);
      } else if (total > 0) {
        const successes = Number(raw.successes ?? 0);
        successRate = (successes / total) * 100;
      }
      this._deliveryStats = { successRate, avgLatencyMs: Number(raw.avgLatencyMs ?? 0), totalDelivered: total, failed: failures };
      this._requestsToday = total;
      this._errorsToday = failures;
      anySuccess = true;
    } else {
      lastError = deliveryResult.reason instanceof Error ? deliveryResult.reason.message : "Failed to load delivery stats";
    }

    // Overview: billing total
    if (billingResult.status === "fulfilled") {
      const raw = billingResult.value;
      const total: BillingTotal = { totalTokens: Number(raw.totalTokens ?? 0), totalCost: Number(raw.totalCost ?? 0) };
      this._billingTotal = total;
      this._tokensToday = total.totalTokens;
      this._costToday = total.totalCost;
      anySuccess = true;
    } else if (!lastError) {
      lastError = billingResult.reason instanceof Error ? billingResult.reason.message : "Failed to load billing total";
    }

    // Overview: 24h token usage
    if (usage24hResult.status === "fulfilled") {
      this._tokenUsage24h = Array.isArray(usage24hResult.value) ? usage24hResult.value : [];
      anySuccess = true;
    }

    // Billing: by provider
    if (byProviderResult.status === "fulfilled") {
      const raw = byProviderResult.value;
      if (Array.isArray(raw)) {
        this._billingByProvider = raw;
      } else {
        const wrapped = raw as Record<string, unknown>;
        this._billingByProvider = Array.isArray(wrapped.providers) ? wrapped.providers : [];
      }
      anySuccess = true;
    }

    // Diagnostics
    if (diagnosticsResult.status === "fulfilled") {
      const raw = diagnosticsResult.value;
      if (Array.isArray(raw)) {
        this._diagnosticsEvents = raw;
      } else {
        const wrapped = raw as Record<string, unknown>;
        this._diagnosticsEvents = Array.isArray(wrapped.events) ? wrapped.events : [];
      }
      anySuccess = true;
    }

    // Delivery: recent traces
    if (deliveryRecentResult.status === "fulfilled") {
      const raw = deliveryRecentResult.value;
      if (Array.isArray(raw)) {
        this._deliveryTraces = raw;
      } else {
        const wrapped = raw as Record<string, unknown>;
        this._deliveryTraces = Array.isArray(wrapped.deliveries) ? wrapped.deliveries : [];
      }
      anySuccess = true;
    }

    // Channels: activity
    if (channelActivityResult.status === "fulfilled") {
      const raw = channelActivityResult.value;
      if (Array.isArray(raw)) {
        this._channelActivity = raw;
      } else {
        const wrapped = raw as Record<string, unknown>;
        this._channelActivity = Array.isArray(wrapped.channels) ? wrapped.channels : [];
      }
      anySuccess = true;
    }

    // Agent health - needs a second round for per-agent details
    if (agentListResult.status === "fulfilled") {
      const agentIds: string[] = Array.isArray(agentListResult.value.agents) ? agentListResult.value.agents : [];
      if (agentIds.length > 0) {
        const details = await Promise.allSettled(
          agentIds.map((id) => rpc.call<AgentHealthEntry>("agents.get", { agentId: id })),
        );
        this._agentHealth = details
          .filter((r): r is PromiseFulfilledResult<AgentHealthEntry> => r.status === "fulfilled")
          .map((r) => r.value);
      } else {
        this._agentHealth = [];
      }
      anySuccess = true;
    }

    // Channel health
    if (channelListResult.status === "fulfilled") {
      this._channelHealth = Array.isArray(channelListResult.value.channels) ? channelListResult.value.channels : [];
      anySuccess = true;
    }

    if (anySuccess) {
      this._loadState = "loaded";
      this._error = "";
    } else {
      this._loadState = "error";
      this._error = lastError || "Failed to load observability data";
    }
  }

  /* ---- Tab handling ---- */

  private _onTabChange(e: CustomEvent<string>): void {
    this._activeTab = e.detail;
  }

  /* ---- Formatters ---- */

  private _formatNumber(n: number): string {
    return new Intl.NumberFormat("en-US").format(n);
  }

  private _formatTokens(n: number): string {
    if (n >= 1_000_000) {
      const m = n / 1_000_000;
      return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
    }
    if (n >= 1_000) {
      const k = n / 1_000;
      return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`;
    }
    return String(n);
  }

  private _formatCost(n: number): string {
    return `$${(n ?? 0).toFixed(2)}`;
  }

  /* ---- Overview tab ---- */

  /** Compute error rate as percentage from delivery stats. */
  private _getErrorRate(): number {
    if (!this._deliveryStats || this._deliveryStats.totalDelivered === 0) return 0;
    return (this._deliveryStats.failed / this._deliveryStats.totalDelivered) * 100;
  }

  /** Determine color class for error rate. */
  private _getErrorRateColor(): string {
    const rate = this._getErrorRate();
    if (rate > 5) return "var(--ic-error)";
    if (rate > 1) return "var(--ic-warning)";
    return "var(--ic-success)";
  }

  /** Determine color class for latency. */
  private _getLatencyColor(): string {
    const latency = this._deliveryStats?.avgLatencyMs ?? 0;
    if (latency > 5000) return "var(--ic-error)";
    if (latency > 2000) return "var(--ic-warning)";
    return "";
  }

  /** Extract model name from agent config. */
  private _getAgentModel(config: Record<string, unknown>): string {
    if (typeof config.model === "string") return config.model;
    return "unknown";
  }

  /** Handle reset button click - enter confirmation mode. */
  private _onResetClick(): void {
    this._resetConfirming = true;
    this._resetInput = "";
  }

  /** Handle reset cancel. */
  private _onResetCancel(): void {
    this._resetConfirming = false;
    this._resetInput = "";
  }

  /** Handle reset input change. */
  private _onResetInput(e: Event): void {
    this._resetInput = (e.target as HTMLInputElement).value;
  }

  /** Handle confirmed reset - call obs.reset RPC and refresh data. */
  private async _onResetConfirm(): Promise<void> {
    if (this._resetInput !== "RESET" || !this.rpcClient) return;
    try {
      await this.rpcClient.call("obs.reset");
    } catch {
      // Best effort
    }
    this._resetConfirming = false;
    this._resetInput = "";
    // Immediately re-fetch to show cleared state
    await this._loadData();
  }

  private _renderOverview() {
    const hasRpc = this.rpcClient && this.rpcClient.status === "connected";

    // Compute overview stat values
    const errorRate = this._getErrorRate();
    const errorRateStr = hasRpc
      ? this._deliveryStats && this._deliveryStats.totalDelivered > 0
        ? `${errorRate.toFixed(1)}%`
        : "0%"
      : "---";
    const avgLatency = hasRpc
      ? this._deliveryStats
        ? `${this._deliveryStats.avgLatencyMs}ms`
        : "0ms"
      : "---";
    const activeSessions = hasRpc ? String(this._agentHealth.filter((a) => !a.suspended).length) : "---";

    return html`
      <!-- 6 Stat Cards -->
      <div class="stats-grid">
        <ic-stat-card
          label="Requests/min"
          .value=${hasRpc ? this._formatNumber(this._requestsToday) : "---"}
        ></ic-stat-card>
        <ic-stat-card
          label="Error Rate"
          .value=${errorRateStr}
        ></ic-stat-card>
        <ic-stat-card
          label="Avg Latency"
          .value=${avgLatency}
        ></ic-stat-card>
        <ic-stat-card
          label="Active Agents"
          .value=${activeSessions}
        ></ic-stat-card>
        <ic-stat-card
          label="Tokens (24h)"
          .value=${hasRpc ? this._formatTokens(this._tokensToday) : "---"}
        ></ic-stat-card>
        <ic-stat-card
          label="Cost Today"
          .value=${hasRpc ? this._formatCost(this._costToday) : "---"}
        ></ic-stat-card>
      </div>

      <!-- Time-series Charts -->
      <div class="section">
        <div class="charts-section">
          <div>
            <div class="chart-title">Token Usage (24h)</div>
            <div class="chart-container">
              ${this._tokenUsage24h.length > 0
                ? html`
                    <div class="bar-chart" aria-label="Token usage bar chart">
                      ${this._renderTokenBars()}
                    </div>
                    <div class="chart-labels">
                      <span>00</span>
                      <span>06</span>
                      <span>12</span>
                      <span>18</span>
                      <span>24</span>
                    </div>
                  `
                : html`<div style="color: var(--ic-text-dim); text-align: center; padding: var(--ic-space-lg);">No usage data</div>`}
            </div>
          </div>
          <div class="sparkline-side">
            <div>
              <div class="chart-title">Cost Trend (7d)</div>
              <div class="chart-container">
                <ic-sparkline
                  .data=${this._costToday > 0 ? [this._costToday] : []}
                  .width=${200}
                  .height=${60}
                  color="var(--ic-accent)"
                ></ic-sparkline>
              </div>
            </div>
            <div>
              <div class="chart-title">Error Rate (24h)</div>
              <div class="chart-container">
                <ic-sparkline
                  .data=${this._errorsToday > 0 ? [this._errorsToday] : []}
                  .width=${200}
                  .height=${60}
                  color="var(--ic-error)"
                ></ic-sparkline>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Health Grids -->
      <div class="section">
        <div class="health-grids">
          <div>
            <div class="section-title">Agent Health</div>
            ${this._renderAgentHealthGrid()}
          </div>
          <div>
            <div class="section-title">Channel Health</div>
            ${this._renderChannelHealthGrid()}
          </div>
        </div>
      </div>

      <!-- Reset Section -->
      ${this._renderResetSection()}
    `;
  }

  /** Render single-series token usage bar chart bars. */
  private _renderTokenBars() {
    const maxTokens = Math.max(...this._tokenUsage24h.map((p) => p.tokens), 1);
    return this._tokenUsage24h.map(
      (p) => html`<div class="bar" style="height: ${(p.tokens / maxTokens) * 100}%" title="${p.hour}:00 - ${this._formatTokens(p.tokens)} tokens"></div>`,
    );
  }

  /** Render agent health grid table. */
  private _renderAgentHealthGrid() {
    if (this._agentHealth.length === 0) {
      return html`<div class="health-empty">No agents configured</div>`;
    }

    return html`
      <div class="grid-table health-grid-table" role="table" aria-label="Agent health">
        <div class="grid-header" role="row">
          <div class="cell" role="columnheader">Agent</div>
          <div class="cell" role="columnheader">Model</div>
          <div class="cell" role="columnheader">Status</div>
        </div>
        ${this._agentHealth.map(
          (agent) => html`
            <div class="grid-row" role="row">
              <div class="cell cell-mono" role="cell">${agent.agentId}</div>
              <div class="cell" role="cell">${this._getAgentModel(agent.config)}</div>
              <div class="cell" role="cell">
                ${agent.suspended
                  ? html`<ic-tag variant="default">suspended</ic-tag>`
                  : html`<ic-tag variant="success">active</ic-tag>`}
              </div>
            </div>
          `,
        )}
      </div>
    `;
  }

  /** Render channel health grid table. */
  private _renderChannelHealthGrid() {
    if (this._channelHealth.length === 0) {
      return html`<div class="health-empty">No channels configured</div>`;
    }

    return html`
      <div class="grid-table health-grid-table" role="table" aria-label="Channel health">
        <div class="grid-header" role="row">
          <div class="cell" role="columnheader">Channel</div>
          <div class="cell" role="columnheader">Type</div>
          <div class="cell" role="columnheader">Status</div>
        </div>
        ${this._channelHealth.map(
          (ch) => {
            const visual = getHealthVisual(ch.status);
            const severityToVariant: Record<HealthSeverity, string> = {
              green: "success",
              yellow: "warning",
              red: "error",
              gray: "default",
            };
            return html`
              <div class="grid-row" role="row">
                <div class="cell" role="cell">${ch.channelId ?? ch.channelType}</div>
                <div class="cell" role="cell">${ch.channelType}</div>
                <div class="cell" role="cell">
                  <ic-tag variant=${severityToVariant[visual.severity]}>
                    ${visual.label}
                  </ic-tag>
                </div>
              </div>
            `;
          },
        )}
      </div>
    `;
  }

  /** Render reset observability data section. */
  private _renderResetSection() {
    return html`
      <div class="reset-section">
        <div class="section-title">Reset Observability Data</div>
        ${this._resetConfirming
          ? html`
              <div class="reset-warning">
                This will permanently clear all observability data. Type RESET to confirm.
              </div>
              <input
                class="reset-input"
                type="text"
                .value=${this._resetInput}
                @input=${this._onResetInput}
                placeholder="Type RESET"
              />
              <div class="reset-actions">
                <button class="reset-cancel-btn" @click=${this._onResetCancel}>Cancel</button>
                <button
                  class="reset-confirm-btn"
                  ?disabled=${this._resetInput !== "RESET"}
                  @click=${this._onResetConfirm}
                >Confirm Reset</button>
              </div>
            `
          : html`
              <button class="reset-btn" @click=${this._onResetClick}>
                Reset Observability Data
              </button>
            `}
      </div>
    `;
  }

  /* ---- Billing tab ---- */

  private _renderBilling() {
    if (this._billingByProvider.length === 0 && this._billingByAgent.length === 0) {
      return html`<ic-empty-state icon="dollar-sign" message="No billing data available"></ic-empty-state>`;
    }

    return html`
      ${this._billingByProvider.length > 0
        ? html`
            <div class="section">
              <div class="section-title">By Provider</div>
              <div class="grid-table-scroll">
                <div class="grid-table provider-table" role="table">
                  <div class="grid-header" role="row">
                    <div class="cell" role="columnheader">Provider</div>
                    <div class="cell cell-right" role="columnheader">Total Tokens</div>
                    <div class="cell cell-right" role="columnheader">Calls</div>
                    <div class="cell cell-right" role="columnheader">Cost</div>
                  </div>
                  ${this._billingByProvider.map(
                    (p) => html`
                      <div class="grid-row" role="row">
                        <div class="cell" role="cell">${p.provider}</div>
                        <div class="cell cell-mono cell-right" role="cell">${this._formatNumber(p.totalTokens)}</div>
                        <div class="cell cell-mono cell-right" role="cell">${this._formatNumber(p.callCount)}</div>
                        <div class="cell cell-mono cell-right" role="cell">${this._formatCost(p.totalCost)}</div>
                      </div>
                    `,
                  )}
                  ${this._renderProviderTotal()}
                </div>
              </div>
            </div>
          `
        : nothing}

      ${this._billingByAgent.length > 0
        ? html`
            <div class="section">
              <div class="section-title">By Agent</div>
              <div class="grid-table-scroll">
                <div class="grid-table agent-table" role="table">
                  <div class="grid-header" role="row">
                    <div class="cell" role="columnheader">Agent</div>
                    <div class="cell cell-right" role="columnheader">Tokens</div>
                    <div class="cell cell-right" role="columnheader">% Total</div>
                    <div class="cell cell-right" role="columnheader">Cost</div>
                  </div>
                  ${this._billingByAgent.map(
                    (a) => html`
                      <div class="grid-row" role="row">
                        <div class="cell" role="cell">${a.agentId}</div>
                        <div class="cell cell-mono cell-right" role="cell">${this._formatNumber(a.totalTokens)}</div>
                        <div class="cell cell-mono cell-right" role="cell">${a.percentOfTotal.toFixed(1)}%</div>
                        <div class="cell cell-mono cell-right" role="cell">${this._formatCost(a.cost)}</div>
                      </div>
                    `,
                  )}
                </div>
              </div>
            </div>
          `
        : nothing}
    `;
  }

  private _renderProviderTotal() {
    const totals = this._billingByProvider.reduce(
      (acc, p) => ({
        totalTokens: acc.totalTokens + p.totalTokens,
        callCount: acc.callCount + p.callCount,
        totalCost: acc.totalCost + p.totalCost,
      }),
      { totalTokens: 0, callCount: 0, totalCost: 0 },
    );

    return html`
      <div class="grid-row total-row" role="row">
        <div class="cell" role="cell">Total</div>
        <div class="cell cell-mono cell-right" role="cell">${this._formatNumber(totals.totalTokens)}</div>
        <div class="cell cell-mono cell-right" role="cell">${this._formatNumber(totals.callCount)}</div>
        <div class="cell cell-mono cell-right" role="cell">${this._formatCost(totals.totalCost)}</div>
      </div>
    `;
  }

  /* ---- Diagnostics tab ---- */

  private _renderDiagnostics() {
    if (this._diagnosticsEvents.length === 0) {
      return html`<ic-empty-state icon="activity" message="No diagnostic events"></ic-empty-state>`;
    }

    // Sort: most recent first
    const sorted = [...this._diagnosticsEvents].sort((a, b) => b.timestamp - a.timestamp);

    return html`
      <div class="grid-table-scroll">
        <div class="grid-table diagnostics-table" role="table">
          <div class="grid-header" role="row">
            <div class="cell" role="columnheader">Time</div>
            <div class="cell" role="columnheader">Category</div>
            <div class="cell" role="columnheader">Message</div>
            <div class="cell" role="columnheader">Level</div>
          </div>
          ${sorted.map(
            (event) => html`
              <div class="grid-row" role="row">
                <div class="cell" role="cell">
                  <ic-relative-time .timestamp=${event.timestamp}></ic-relative-time>
                </div>
                <div class="cell" role="cell">
                  <ic-tag>${event.category}</ic-tag>
                </div>
                <div class="cell" role="cell">${deriveDiagnosticMessage(event)}</div>
                <div class="cell" role="cell">
                  <ic-tag variant=${deriveDiagnosticLevel(event) === "error" ? "error" : deriveDiagnosticLevel(event) === "warn" ? "warning" : "default"}>
                    ${deriveDiagnosticLevel(event)}
                  </ic-tag>
                </div>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  /* ---- Delivery tab ---- */

  /** Time range in milliseconds for delivery filtering. */
  private _getTimeRangeMs(): number {
    const ranges: Record<string, number> = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000 };
    return ranges[this._deliveryTimeRange] ?? 3_600_000;
  }

  /** Return delivery traces filtered and sorted by current filter state. */
  private _getFilteredTraces(): DeliveryTrace[] {
    const now = Date.now();
    const rangeMs = this._getTimeRangeMs();
    return this._deliveryTraces
      .filter((t) => {
        if (this._deliveryChannelFilter !== "all" && t.channelType !== this._deliveryChannelFilter) return false;
        if (this._deliveryStatusFilter !== "all" && t.status !== this._deliveryStatusFilter) return false;
        if (t.timestamp < now - rangeMs) return false;
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  private _onDeliveryChannelFilter(e: Event): void {
    this._deliveryChannelFilter = (e.target as HTMLSelectElement).value;
  }

  private _onDeliveryStatusFilter(e: Event): void {
    this._deliveryStatusFilter = (e.target as HTMLSelectElement).value;
  }

  private _onDeliveryTimeRange(e: Event): void {
    this._deliveryTimeRange = (e.target as HTMLSelectElement).value;
  }

  private _onTraceClick(e: CustomEvent<string>): void {
    const traceId = e.detail;
    this._expandedTraceId = this._expandedTraceId === traceId ? null : traceId;
  }

  private _renderDeliveryStats() {
    if (!this._deliveryStats) return nothing;
    const stats = this._deliveryStats;
    // When there are no deliveries, don't color the rate - it's not meaningful
    const hasData = stats.totalDelivered > 0;
    const rateClass = hasData
      ? stats.successRate >= 99 ? "rate-green" : stats.successRate >= 95 ? "rate-yellow" : "rate-red"
      : "";

    return html`
      <div class="stats-summary">
        <span>Success <span class="stat-value ${rateClass}">${hasData ? `${stats.successRate.toFixed(1)}%` : "N/A"}</span></span>
        <span>Avg <span class="stat-value">${hasData ? `${stats.avgLatencyMs}ms` : "N/A"}</span></span>
        <span>Total <span class="stat-value">${this._formatNumber(stats.totalDelivered)}</span></span>
      </div>
    `;
  }

  private _renderTraceDetail(trace: DeliveryTrace) {
    if (!trace.steps || trace.steps.length === 0) {
      return html`
        <div class="trace-detail">
          <div class="trace-detail-title">Delivery Steps</div>
          <div style="color: var(--ic-text-dim); font-size: var(--ic-text-sm); margin-top: var(--ic-space-sm);">
            No step details available
          </div>
        </div>
      `;
    }

    return html`
      <div class="trace-detail">
        <div class="trace-detail-title">Delivery Steps</div>
        <div class="step-list">
          ${trace.steps.map(
            (step) => html`
              <div class="step-item">
                <span class="step-dot ${step.status}"></span>
                <span>${step.name} &mdash; ${step.durationMs}ms</span>
              </div>
              ${step.error ? html`<div class="step-error">${step.error}</div>` : nothing}
            `,
          )}
        </div>
      </div>
    `;
  }

  /** Render channel filter select (separate method to avoid Lit+happy-dom duplicate attribute binding on options). */
  private _renderChannelFilterSelect() {
    const channelTypes = [...new Set(this._deliveryTraces.map((t) => t.channelType))];
    return html`
      <select class="filter-select" @change=${this._onDeliveryChannelFilter}>
        <option value="all">All Channels</option>
        ${channelTypes.map((ch) => html`<option value=${ch}>${ch}</option>`)}
      </select>
    `;
  }

  /** Render status filter select (separate method to avoid Lit+happy-dom duplicate attribute binding on options). */
  private _renderStatusFilterSelect() {
    return html`
      <select class="filter-select" @change=${this._onDeliveryStatusFilter}>
        <option value="all">All Statuses</option>
        <option value="success">Success</option>
        <option value="failed">Failed</option>
        <option value="timeout">Timeout</option>
      </select>
    `;
  }

  /** Render time range filter select (separate method to avoid Lit+happy-dom duplicate attribute binding on options). */
  private _renderTimeRangeSelect() {
    return html`
      <select class="filter-select" @change=${this._onDeliveryTimeRange}>
        <option value="1h">1 hour</option>
        <option value="6h">6 hours</option>
        <option value="24h">24 hours</option>
        <option value="7d">7 days</option>
      </select>
    `;
  }

  /** Render a single delivery row with optional expanded detail (separate to avoid Lit duplicate binding in map). */
  private _renderDeliveryRow(trace: DeliveryTrace) {
    return html`
      <ic-delivery-row
        .trace=${trace}
        @trace-click=${this._onTraceClick}
      ></ic-delivery-row>
      ${this._expandedTraceId === trace.traceId ? this._renderTraceDetail(trace) : nothing}
    `;
  }

  private _renderDeliveryTab() {
    const filtered = this._getFilteredTraces();

    return html`
      ${this._renderDeliveryStats()}

      <div class="filter-row">
        ${this._renderChannelFilterSelect()}
        ${this._renderStatusFilterSelect()}
        ${this._renderTimeRangeSelect()}
      </div>

      ${filtered.length === 0
        ? html`<ic-empty-state icon="truck" message="No delivery traces match the current filters"></ic-empty-state>`
        : html`
            <div class="grid-table-scroll">
              <div class="grid-table delivery-table" role="table" aria-label="Delivery traces">
                <div class="grid-header" role="row">
                  <div class="cell" role="columnheader">Time</div>
                  <div class="cell" role="columnheader">Channel</div>
                  <div class="cell" role="columnheader">Message</div>
                  <div class="cell" role="columnheader">Status</div>
                  <div class="cell" role="columnheader">Latency</div>
                  <div class="cell" role="columnheader">Steps</div>
                </div>
                ${filtered.map((trace) => this._renderDeliveryRow(trace))}
              </div>
            </div>
          `}
    `;
  }

  /* ---- Channel Activity tab ---- */

  private _renderChannelsTab() {
    if (this._channelActivity.length === 0) {
      return html`<ic-empty-state icon="radio" title="No Channel Data" description="Channel activity will appear once channels are connected and processing messages."></ic-empty-state>`;
    }

    // Sort: stale first, then by lastActiveAt descending
    const sorted = [...this._channelActivity].sort((a, b) => {
      if (a.isStale && !b.isStale) return -1;
      if (!a.isStale && b.isStale) return 1;
      return b.lastActiveAt - a.lastActiveAt;
    });

    const staleCount = sorted.filter((c) => c.isStale).length;

    return html`
      ${staleCount > 0
        ? html`<div class="stale-alert">${staleCount} stale channel(s) detected</div>`
        : nothing}

      <div class="grid-table-scroll">
        <div class="grid-table channel-table" role="table" aria-label="Channel activity">
          <div class="grid-header" role="row">
            <div class="cell" role="columnheader">Channel</div>
            <div class="cell" role="columnheader">ID</div>
            <div class="cell cell-right" role="columnheader">Sent</div>
            <div class="cell cell-right" role="columnheader">Received</div>
            <div class="cell" role="columnheader">Last Active</div>
            <div class="cell" role="columnheader">Status</div>
          </div>
          ${sorted.map(
            (activity) => html`
              <div class="grid-row ${activity.isStale ? "stale" : ""}" role="row">
                <div class="cell" role="cell"><ic-tag variant=${activity.channelType}>${activity.channelType}</ic-tag></div>
                <div class="cell cell-mono" role="cell">${activity.channelId}</div>
                <div class="cell cell-mono cell-right" role="cell">${this._formatNumber(activity.messagesSent)}</div>
                <div class="cell cell-mono cell-right" role="cell">${this._formatNumber(activity.messagesReceived)}</div>
                <div class="cell" role="cell"><ic-relative-time .timestamp=${activity.lastActiveAt}></ic-relative-time></div>
                <div class="cell" role="cell">
                  ${activity.isStale
                    ? html`<ic-tag variant="warning">Stale</ic-tag>`
                    : html`<ic-tag variant="success">Active</ic-tag>`}
                </div>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  /* ---- Tab content switch ---- */

  private _renderTabContent() {
    switch (this._activeTab) {
      case "overview":
        return this._renderOverview();
      case "billing":
        return this._renderBilling();
      case "delivery":
        return this._renderDeliveryTab();
      case "channels":
        return this._renderChannelsTab();
      case "diagnostics":
        return this._renderDiagnostics();
      default:
        return this._renderOverview();
    }
  }

  /* ---- Main render ---- */

  override render() {
    if (this._loadState === "loading" && this.rpcClient) {
      return html`<ic-skeleton-view variant="table"></ic-skeleton-view>`;
    }

    if (this._loadState === "error") {
      return html`
        <div class="error-container">
          <span class="error-message">${this._error}</span>
          <button class="retry-btn" @click=${() => this._tryLoad()}>Retry</button>
        </div>
      `;
    }

    return html`
      <div class="observe-view">
        <ic-tabs
          .tabs=${TAB_DEFS}
          .activeTab=${this._activeTab}
          @tab-change=${this._onTabChange}
        >
          <div slot="overview">${this._activeTab === "overview" ? this._renderOverview() : nothing}</div>
          <div slot="billing">${this._activeTab === "billing" ? this._renderBilling() : nothing}</div>
          <div slot="delivery">${this._activeTab === "delivery" ? this._renderDeliveryTab() : nothing}</div>
          <div slot="channels">${this._activeTab === "channels" ? this._renderChannelsTab() : nothing}</div>
          <div slot="diagnostics">${this._activeTab === "diagnostics" ? this._renderDiagnostics() : nothing}</div>
        </ic-tabs>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-observe-view": IcObserveView;
  }
}
