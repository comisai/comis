// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type {
  AgentInfo,
  ChannelInfo,
  ActivityEntry,
  DeliveryStats,
  GatewayStatus,
  PipelineSnapshot,
} from "../api/types/index.js";
import { SSE_EVENT_TYPES } from "../api/types/index.js";
import type { ApiClient, SseEventHandler } from "../api/api-client.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { SseController } from "../state/sse-controller.js";
import { systemClearInterval, systemClearTimeout, systemSetInterval, systemSetTimeout } from "@comis/core";
// Import sub-components (side-effect registrations)
import "../components/data/ic-stat-card.js";
import "../components/data/ic-sparkline.js";
import "../components/data/ic-progress-bar.js";
import "../components/data/ic-metric-gauge.js";
import type { AgentCardActionDetail } from "../components/agent-card.js";
import "../components/agent-card.js";
import "../components/channel-badge.js";
import "../components/activity-feed.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/feedback/ic-confirm-dialog.js";
import { IcToast } from "../components/feedback/ic-toast.js";

type LoadState = "loading" | "loaded" | "error";

/** Auto-refresh interval for RPC data in milliseconds. */
const RPC_REFRESH_INTERVAL_MS = 60_000;

/** Navigation target constants -- avoids inline route strings. */
const NAV_TARGETS = {
  agents: "agents",
  sessions: "sessions",
  messages: "observe/delivery",
  tokens: "observe/billing",
  cost: "observe/billing",
  errors: "observe/diagnostics",
  health: "observe/overview",
  context: "observe/context",
  channels: "channels",
  activity: "observe/delivery",
} as const;

/**
 * Format seconds into human-readable uptime string (e.g. "14d 3h 22m").
 */
export function formatUptime(seconds: number): string {
  if (seconds < 0) return "0m";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);

  return parts.join(" ");
}

/**
 * Format a number with comma separators (e.g. 1234567 -> "1,234,567").
 */
export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/**
 * Format token count with abbreviations (e.g. 845000 -> "845K", 1200000 -> "1.2M").
 */
export function formatTokens(n: number): string {
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

/** Currency formatter for USD costs. */
const costFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/**
 * Get a CSS color variable based on value and thresholds.
 */
function thresholdColor(value: number, green: number, yellow: number): string {
  if (value < green) return "var(--ic-success)";
  if (value < yellow) return "var(--ic-warning)";
  return "var(--ic-error)";
}

/**
 * Get a threshold label for color-independent status indication.
 */
function thresholdLabel(value: number, green: number, yellow: number): string {
  if (value < green) return "";
  if (value < yellow) return "(Warning)";
  return "(Critical)";
}

/** Context engine summary aggregated from pipeline snapshots. */
interface ContextSummary {
  cacheHitRate: number;
  budgetUtilization: number;
  totalEvictions: number;
  reReads: number;
}

/** Billing total RPC response (obs.billing.total / obs.billing.byAgent). */
interface BillingTotalResult {
  totalCost?: number;
  totalTokens?: number;
}

/** Per-hour token-usage histogram entry (obs.billing.usage24h). */
interface BillingHourlyEntry {
  hour: number;
  tokens: number;
}

/**
 * Dashboard view combining stat cards, system health, context engine summary,
 * sparklines, agent fleet cards with per-agent cost, channel badges, and
 * live activity feed.
 *
 * Fetches data from both the REST ApiClient and JSON-RPC RpcClient.
 * REST data loads once on mount; RPC data refreshes periodically at 60s.
 * SSE events via EventDispatcher provide real-time stat card updates.
 * Every metric is clickable and navigates to its detail view.
 * Shows loading and error states with graceful degradation.
 */
@customElement("ic-dashboard")
export class IcDashboard extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .dashboard-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 1.5rem;
      }

      /* Stats row -- 3-column grid (responsive) */
      .stats-row {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--ic-space-md);
      }

      @media (max-width: 1023px) {
        .stats-row {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      @media (max-width: 639px) {
        .stats-row {
          grid-template-columns: 1fr;
        }
      }

      /* Clickable stat card link wrappers */
      .stat-card-link {
        cursor: pointer;
        border-radius: var(--ic-radius-md);
        transition: transform 0.1s;
      }

      .stat-card-link:hover {
        transform: translateY(-1px);
      }

      .stat-card-link:focus-visible {
        outline: 2px solid var(--ic-accent);
        outline-offset: 2px;
      }

      /* Info cards row */
      .info-cards-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--ic-space-lg);
      }

      @media (max-width: 767px) {
        .info-cards-row {
          grid-template-columns: 1fr;
        }
      }

      .info-card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-lg);
      }

      .info-card--link {
        cursor: pointer;
        transition: border-color 0.15s;
      }

      .info-card--link:hover {
        border-color: var(--ic-border-hover, #374151);
      }

      .info-card--link:focus-visible {
        outline: 2px solid var(--ic-accent);
        outline-offset: 2px;
      }

      .info-card-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text);
        margin-bottom: var(--ic-space-md);
      }

      .info-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--ic-space-xs) 0;
        font-size: var(--ic-text-sm);
      }

      .info-label {
        color: var(--ic-text-dim);
      }

      .info-value {
        color: var(--ic-text);
        font-family: var(--ic-font-mono, ui-monospace, monospace);
      }

      /* Context engine summary grid */
      .context-summary-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--ic-space-md);
        align-items: start;
      }

      .context-metric {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--ic-space-xs);
      }

      .context-metric-label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      .context-metric-value {
        font-size: var(--ic-text-lg);
        font-weight: 600;
        color: var(--ic-text);
        font-family: var(--ic-font-mono, ui-monospace, monospace);
      }

      /* Sparklines row */
      .sparklines-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--ic-space-lg);
      }

      @media (max-width: 639px) {
        .sparklines-row {
          grid-template-columns: 1fr;
        }
      }

      .sparkline-card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-md) var(--ic-space-lg);
        cursor: pointer;
        transition: border-color 0.15s;
      }

      .sparkline-card:hover {
        border-color: var(--ic-border-hover, #374151);
      }

      .sparkline-card:focus-visible {
        outline: 2px solid var(--ic-accent);
        outline-offset: 2px;
      }

      .sparkline-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--ic-space-md);
      }

      .sparkline-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-dim);
      }

      /* Section styles */
      .section {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }

      .section-title {
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--ic-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .section-title--link {
        cursor: pointer;
      }

      .section-title--link:hover {
        color: var(--ic-accent);
      }

      .section-title--link:focus-visible {
        outline: 2px solid var(--ic-accent);
        outline-offset: 2px;
      }

      .agents-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 0.75rem;
      }

      .agent-card-wrapper {
        position: relative;
      }

      .agent-cost-badge {
        position: absolute;
        top: 0.5rem;
        right: 0.5rem;
        padding: 0.125rem 0.5rem;
        background: var(--ic-accent);
        color: #fff;
        font-size: 0.6875rem;
        font-weight: 600;
        border-radius: 9999px;
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        pointer-events: none;
      }

      .channels-row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
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

      .empty-text {
        color: var(--ic-text-dim);
        font-size: 0.8125rem;
      }

      .stat-value-placeholder {
        color: var(--ic-text-dim);
      }

      .no-data-placeholder {
        color: var(--ic-text-dim);
        font-size: var(--ic-text-sm);
        padding: var(--ic-space-md) 0;
      }
    `,
  ];

  @property({ attribute: false }) apiClient: ApiClient | null = null;
  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  @state() private _loadState: LoadState = "loading";
  @state() private _error = "";
  @state() private _agents: AgentInfo[] = [];
  @state() private _channels: ChannelInfo[] = [];
  @state() private _activity: ActivityEntry[] = [];
  @state() private _systemHealth: GatewayStatus | null = null;
  @state() private _deliveryStats: DeliveryStats | null = null;
  @state() private _messagesToday = 0;
  @state() private _tokenUsageToday = 0;
  @state() private _sessionCount = 0;
  @state() private _errorCount = 0;
  @state() private _totalCost = 0;
  @state() private _prevMessages = 0;
  @state() private _prevTokens = 0;
  @state() private _prevCost = 0;
  @state() private _mcpStatus = "---";
  @state() private _contextSummary: ContextSummary | null = null;
  @state() private _tokenSparklineData: number[] = [];
  @state() private _costSparklineData: number[] = [];
  @state() private _agentBilling: Map<string, { cost: number; tokens: number }> = new Map();
  @state() private _deleteTarget: AgentInfo | null = null;
  @state() private _agentActionPending = "";
  /** Mirrors rpcClient.status so render() can react to WS connect/disconnect. */
  @state() private _rpcStatus: "connected" | "reconnecting" | "disconnected" = "disconnected";

  private _sse: SseController | null = null;
  private _rpcRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private _reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  private _rpcStatusUnsub: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // Note: _loadData() and _startRpcRefresh() are NOT called here --
    // apiClient/rpcClient are typically null at this point. The updated()
    // callback handles loading once the client properties are set.
    this._initSse();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._reloadDebounce !== null) {
      systemClearTimeout(this._reloadDebounce);
      this._reloadDebounce = null;
    }
    this._stopRpcRefresh();
    this._rpcStatusUnsub?.();
    this._rpcStatusUnsub = null;
  }

  override updated(changed: Map<string, unknown>): void {
    const loadsRpcAfterRest = changed.has("apiClient") && this.apiClient !== null;
    if (loadsRpcAfterRest) {
      this._loadData();
    }
    if (changed.has("rpcClient")) {
      this._stopRpcRefresh();
      this._startRpcRefresh();
      if (!loadsRpcAfterRest) {
        this._loadRpcData();
      }
      // Track RPC status so render() can show "---" placeholders when disconnected.
      this._rpcStatusUnsub?.();
      this._rpcStatusUnsub = null;
      if (this.rpcClient) {
        this._rpcStatus = this.rpcClient.status;
        this._rpcStatusUnsub = this.rpcClient.onStatusChange((status) => {
          this._rpcStatus = status;
        });
      } else {
        this._rpcStatus = "disconnected";
      }
    }
    if (changed.has("eventDispatcher") && this.eventDispatcher && !this._sse) {
      this._initSse();
    }
  }

  // ---------------------------------------------------------------------------
  // Navigation helpers
  // ---------------------------------------------------------------------------

  private _navigate(route: string): void {
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: route,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _makeKeyHandler(route: string): (e: KeyboardEvent) => void {
    return (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this._navigate(route);
      }
    };
  }

  private _handleAgentAction(
    e: CustomEvent<AgentCardActionDetail>,
  ): void {
    const { action, agentId } = e.detail;
    switch (action) {
      case "configure":
        this._navigate(`agents/${agentId}/edit`);
        return;
      case "suspend":
      case "resume":
        void this._changeAgentStatus(action, agentId);
        return;
      case "delete":
        if (this._agentActionPending) return;
        this._deleteTarget = this._agents.find((agent) => agent.id === agentId) ?? null;
        return;
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }

  private async _changeAgentStatus(
    action: "suspend" | "resume",
    agentId: string,
  ): Promise<void> {
    if (!this.rpcClient || this._agentActionPending) return;
    this._agentActionPending = agentId;
    try {
      if (action === "resume") {
        await this.rpcClient.call("agents.resume", { agentId });
      } else {
        await this.rpcClient.call("agents.suspend", { agentId });
      }
      // The successful mutation is authoritative for the only agent field this
      // action changes. A full dashboard reload fans out into many unrelated
      // metric calls and can exhaust the per-connection WebSocket budget.
      const status = action === "resume" ? "active" : "suspended";
      this._agents = this._agents.map((agent) =>
        agent.id === agentId ? { ...agent, status } : agent,
      );
      IcToast.show(`Agent ${agentId} ${action === "resume" ? "resumed" : "suspended"}`, "success");
    } catch (err) {
      IcToast.show(
        `Failed to ${action} agent: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    } finally {
      this._agentActionPending = "";
    }
  }

  private async _confirmAgentDelete(): Promise<void> {
    if (!this.rpcClient || !this._deleteTarget || this._agentActionPending) return;
    const agentId = this._deleteTarget.id;
    this._deleteTarget = null;
    this._agentActionPending = agentId;
    try {
      await this.rpcClient.call("agents.delete", { agentId });
      // Deletion only changes the fleet cards and their cached billing entry;
      // the remaining dashboard datasets do not need to be reloaded.
      this._agents = this._agents.filter((agent) => agent.id !== agentId);
      const billing = new Map(this._agentBilling);
      billing.delete(agentId);
      this._agentBilling = billing;
      IcToast.show(`Agent ${agentId} deleted`, "success");
    } catch (err) {
      IcToast.show(
        `Failed to delete agent: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    } finally {
      this._agentActionPending = "";
    }
  }

  // ---------------------------------------------------------------------------
  // SSE subscription via SseController
  // ---------------------------------------------------------------------------

  private _scheduleReload(delayMs = 300): void {
    if (this._reloadDebounce !== null) systemClearTimeout(this._reloadDebounce);
    this._reloadDebounce = systemSetTimeout(() => {
      this._reloadDebounce = null;
      void this._loadData();
    }, delayMs);
  }

  private _initSse(): void {
    if (!this.eventDispatcher || this._sse) return;
    this._sse = new SseController(this, this.eventDispatcher, {
      "message:received": () => { this._messagesToday++; },
      "message:sent": () => { this._messagesToday++; },
      "session:created": () => { this._sessionCount++; },
      "system:error": () => { this._errorCount++; },
      "observability:token_usage": () => { this._scheduleReload(); },
      "diagnostic:channel_health": () => { this._scheduleReload(500); },
      "diagnostic:billing_snapshot": () => { this._scheduleReload(); },
      "agent:hot_added": () => { void this._loadAgents(); },
      "agent:hot_removed": () => { void this._loadAgents(); },
      "channel:registered": () => { this._scheduleReload(); },
      "channel:deregistered": () => { this._scheduleReload(); },
      "observability:metrics": () => { this._scheduleReload(500); },
    });
  }

  private async _loadAgents(): Promise<void> {
    if (!this.apiClient) return;
    // Keep the last known roster when the targeted refresh fails. A later
    // lifecycle event or full dashboard refresh will retry the REST read.
    const agents = await this.apiClient.getAgents().catch(() => null);
    if (agents !== null) this._agents = agents;
  }

  // ---------------------------------------------------------------------------
  // RPC refresh
  // ---------------------------------------------------------------------------

  private _startRpcRefresh(): void {
    if (this._rpcRefreshInterval !== null) return;
    this._rpcRefreshInterval = systemSetInterval(() => {
      this._loadRpcData();
    }, RPC_REFRESH_INTERVAL_MS);
  }

  private _stopRpcRefresh(): void {
    if (this._rpcRefreshInterval !== null) {
      systemClearInterval(this._rpcRefreshInterval);
      this._rpcRefreshInterval = null;
    }
  }

  private async _loadRpcData(): Promise<void> {
    if (!this.rpcClient || this.rpcClient.status !== "connected") return;

    // Fire all independent RPC calls in parallel for fast dashboard population.
    // Each result is handled individually for graceful degradation.
    const rpc = this.rpcClient;

    const [
      gatewayResult,
      deliveryResult,
      billingTodayResult,
      billing2DayResult,
      sessionResult,
      mcpResult,
      pipelineResult,
      sparklineTokenResult,
    ] = await Promise.allSettled([
      rpc.call<GatewayStatus>("gateway.status"),
      rpc.call<Record<string, unknown>>("obs.delivery.stats"),
      rpc.call<Record<string, unknown>>("obs.billing.total", { sinceMs: 86_400_000 }),
      rpc.call<Record<string, unknown>>("obs.billing.total", { sinceMs: 172_800_000 }),
      rpc.call<Record<string, unknown>>("session.list", {}),
      rpc.call<{ servers: Array<{ name: string; status: string }>; total: number }>("mcp.list"),
      rpc.call<PipelineSnapshot[]>("obs.context.pipeline", { limit: 50 }),
      rpc.call<Array<{ hour: number; tokens: number }>>("obs.billing.usage24h"),
    ]);

    // 1. Gateway status (system health)
    if (gatewayResult.status === "fulfilled") {
      this._systemHealth = gatewayResult.value;
    }

    // 2. Delivery stats -> message count + error count baseline
    if (deliveryResult.status === "fulfilled") {
      const raw = deliveryResult.value;
      const total = Number(raw.total ?? raw.totalDelivered ?? 0);
      const successes = Number(raw.successes ?? 0);
      const failures = Number(raw.failures ?? raw.failed ?? 0);
      const avgLatencyMs = Number(raw.avgLatencyMs ?? 0);
      this._deliveryStats = {
        successRate: total > 0 ? (successes / total) * 100 : 0,
        avgLatencyMs,
        totalDelivered: total,
        failed: failures,
      };
      this._messagesToday = total;
      this._errorCount = failures;
    }

    // 3. Billing totals (today) + deltas vs previous day
    if (billingTodayResult.status === "fulfilled") {
      const todayTokens = Number(billingTodayResult.value.totalTokens ?? 0);
      const todayCost = Number(billingTodayResult.value.totalCost ?? 0);
      this._tokenUsageToday = todayTokens;
      this._totalCost = todayCost;

      if (billing2DayResult.status === "fulfilled") {
        const twoDayTokens = Number(billing2DayResult.value.totalTokens ?? 0);
        const twoDayCost = Number(billing2DayResult.value.totalCost ?? 0);
        this._prevTokens = Math.max(0, twoDayTokens - todayTokens);
        this._prevCost = Math.max(0, twoDayCost - todayCost);
      }
      // No previous-period message data available from obs.delivery.stats
      this._prevMessages = 0;
    }

    // 4. Session count
    if (sessionResult.status === "fulfilled") {
      this._sessionCount = Number((sessionResult.value as Record<string, unknown>).total ?? 0);
    }

    // 5. MCP status
    if (mcpResult.status === "fulfilled") {
      const raw = mcpResult.value;
      if (!raw.servers || raw.total === 0) {
        this._mcpStatus = "N/A";
      } else {
        const connected = raw.servers.filter((s) => s.status === "connected").length;
        this._mcpStatus = `${connected}/${raw.total}`;
      }
    }

    // 6. Context engine pipeline summary
    if (pipelineResult.status === "fulfilled") {
      const pipelines = pipelineResult.value;
      if (pipelines && pipelines.length > 0) {
        const cacheHits = pipelines.filter((p) => p.cacheHitTokens > 0).length;
        const avgBudget = pipelines.reduce((s, p) => s + p.budgetUtilization, 0) / pipelines.length;
        const totalEvictions = pipelines.reduce((s, p) => s + p.tokensEvicted, 0);
        this._contextSummary = {
          cacheHitRate: Math.round((cacheHits / pipelines.length) * 100),
          budgetUtilization: Math.round(avgBudget),
          totalEvictions,
          reReads: pipelines.length - cacheHits,
        };
      } else {
        this._contextSummary = null;
      }
    }

    // 7. Token sparkline (24h)
    if (sparklineTokenResult.status === "fulfilled" && Array.isArray(sparklineTokenResult.value)) {
      this._tokenSparklineData = sparklineTokenResult.value.map((d) => d.tokens);
    }

    // 8. Cost sparkline (7d) + per-agent billing - fire in parallel
    await Promise.allSettled([
      this._loadCostSparkline(),
      this._loadAgentBilling(),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Cost sparkline loading (7d)
  // ---------------------------------------------------------------------------

  private async _loadCostSparkline(): Promise<void> {
    if (!this.rpcClient) return;
    const dayMs = 86_400_000;
    const calls = Array.from({ length: 7 }, (_, i) =>
      this.rpcClient!.call<BillingTotalResult>("obs.billing.total", { sinceMs: dayMs * (i + 1) }),
    );
    const results = await Promise.allSettled(calls);

    const cumulative = results.map((r) =>
      r.status === "fulfilled" ? Number(r.value.totalCost ?? 0) : 0,
    );
    const daily = cumulative.map((val, i) =>
      i === 0 ? val : Math.max(0, val - cumulative[i - 1]),
    );
    this._costSparklineData = daily.reverse();
  }

  // ---------------------------------------------------------------------------
  // Sparkline data loading - used by SSE billing_snapshot events
  // ---------------------------------------------------------------------------

  private async _loadSparklineData(): Promise<void> {
    if (!this.rpcClient || this.rpcClient.status !== "connected") return;

    await Promise.allSettled([
      (async () => {
        const usage24h = await this.rpcClient!.call<BillingHourlyEntry[]>("obs.billing.usage24h");
        this._tokenSparklineData = usage24h.map((d) => d.tokens);
      })(),
      this._loadCostSparkline(),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Per-agent billing
  // ---------------------------------------------------------------------------

  private async _loadAgentBilling(): Promise<void> {
    if (!this.rpcClient || this._agents.length === 0) return;

    const results = await Promise.allSettled(
      this._agents.slice(0, 20).map((agent) =>
        this.rpcClient!.call<BillingTotalResult>("obs.billing.byAgent", { agentId: agent.id }),
      ),
    );

    const billing = new Map<string, { cost: number; tokens: number }>();
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        billing.set(this._agents[i].id, {
          cost: result.value.totalCost ?? 0,
          tokens: result.value.totalTokens ?? 0,
        });
      }
    });
    this._agentBilling = billing;
  }

  // ---------------------------------------------------------------------------
  // REST data loading
  // ---------------------------------------------------------------------------

  private async _loadData(): Promise<void> {
    if (!this.apiClient) return;

    this._loadState = "loading";
    this._error = "";

    try {
      const [agents, channels, activity] = await Promise.all([
        this.apiClient.getAgents().catch(() => [] as AgentInfo[]),
        this.apiClient.getChannels().catch(() => [] as ChannelInfo[]),
        this.apiClient.getActivity(50).catch(() => [] as ActivityEntry[]),
      ]);

      this._agents = agents;
      this._channels = channels;
      this._activity = activity;
      this._loadState = "loaded";

      // Also fetch RPC data after REST data loads
      this._loadRpcData();
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to load dashboard data";
      this._loadState = "error";
    }
  }

  // ---------------------------------------------------------------------------
  // Delta computation helper
  // ---------------------------------------------------------------------------

  private _computeDelta(current: number, previous: number): { trend: string; trendValue: string } {
    if (previous <= 0) {
      return current > 0 ? { trend: "up", trendValue: "+100%" } : { trend: "flat", trendValue: "" };
    }
    const pct = Math.round(((current - previous) / previous) * 100);
    if (pct > 0) return { trend: "up", trendValue: `+${pct}%` };
    if (pct < 0) return { trend: "down", trendValue: `${pct}%` };
    return { trend: "flat", trendValue: "" };
  }

  // ---------------------------------------------------------------------------
  // SSE subscriber for activity feed
  //
  // Multiplexes `<ic-activity-feed>`'s per-handler `(event, data)` contract
  // over `EventDispatcher.addEventListener(type, handler)`. The dispatcher
  // already opens ONE EventSource per page (started in `app-controller.ts`);
  // this adapter just bridges per-type listeners to the single-handler shape
  // expected by `activity-feed.ts:267`.
  //
  // Inline (YAGNI) — single consumer, no cross-file reuse
  // warrants an exported helper.
  // ---------------------------------------------------------------------------

  private _getSseSubscriber(): ((handler: SseEventHandler) => () => void) | null {
    if (!this.eventDispatcher) return null;
    const dispatcher = this.eventDispatcher;
    return (handler: SseEventHandler) => {
      const unsubs: Array<() => void> = [];
      for (const eventType of SSE_EVENT_TYPES) {
        unsubs.push(
          dispatcher.addEventListener(eventType, (data) => handler(eventType, data)),
        );
      }
      return () => {
        for (const u of unsubs) u();
      };
    };
  }

  // ---------------------------------------------------------------------------
  // System Health card
  // ---------------------------------------------------------------------------

  private _renderSystemHealth() {
    if (!this._systemHealth) {
      return html`
        <div class="info-card info-card--link" role="link" tabindex="0"
          @click=${() => this._navigate(NAV_TARGETS.health)}
          @keydown=${this._makeKeyHandler(NAV_TARGETS.health)}
          aria-label="View system overview"
        >
          <div class="info-card-title">System Health</div>
          <div class="info-row">
            <span class="info-label">Loading...</span>
            <span class="info-value">---</span>
          </div>
        </div>
      `;
    }

    const h = this._systemHealth;
    const memUsageBytes = h.memoryUsage ?? 0;
    const memMb = Math.round(memUsageBytes / 1024 / 1024);
    const eventLoopDelay = h.eventLoopDelay ?? 0;
    const eventLoopColor = thresholdColor(eventLoopDelay, 50, 100);
    const uptime = h.uptime ?? 0;
    const nodeVersion = h.nodeVersion ?? "---";

    return html`
      <div class="info-card info-card--link" role="link" tabindex="0"
        @click=${() => this._navigate(NAV_TARGETS.health)}
        @keydown=${this._makeKeyHandler(NAV_TARGETS.health)}
        aria-label="View system overview"
      >
        <div class="info-card-title">System Health</div>
        <div class="info-row">
          <span class="info-label">Uptime</span>
          <span class="info-value">${formatUptime(uptime)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Memory (RSS)</span>
          <span class="info-value">${memMb} MB</span>
        </div>
        <div class="info-row">
          <span class="info-label">Event Loop Delay</span>
          <span class="info-value" style="color: ${eventLoopColor}">
            ${eventLoopDelay.toFixed(1)}ms ${thresholdLabel(eventLoopDelay, 50, 100)}
          </span>
        </div>
        <div class="info-row">
          <span class="info-label">Node.js</span>
          <span class="info-value">${nodeVersion}</span>
        </div>
        <div class="info-row">
          <span class="info-label">MCP Servers</span>
          <span class="info-value">${this._mcpStatus}</span>
        </div>
        ${h.cpuUsage != null
          ? html`
              <div class="info-row">
                <span class="info-label">CPU</span>
                <div style="flex: 1; max-width: 60%; margin-left: auto;">
                  <ic-progress-bar
                    .value=${Math.round(h.cpuUsage)}
                    .showPercent=${true}
                    .thresholds=${{ green: 70, yellow: 90 }}
                  ></ic-progress-bar>
                </div>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Context Engine Summary card
  // ---------------------------------------------------------------------------

  private _renderContextSummary() {
    if (!this._contextSummary) {
      return html`
        <div class="info-card info-card--link" role="link" tabindex="0"
          @click=${() => this._navigate(NAV_TARGETS.context)}
          @keydown=${this._makeKeyHandler(NAV_TARGETS.context)}
          aria-label="View context engine"
        >
          <div class="info-card-title">Context Engine</div>
          <div class="no-data-placeholder">No pipeline data</div>
        </div>
      `;
    }

    const ctx = this._contextSummary;

    return html`
      <div class="info-card info-card--link" role="link" tabindex="0"
        @click=${() => this._navigate(NAV_TARGETS.context)}
        @keydown=${this._makeKeyHandler(NAV_TARGETS.context)}
        aria-label="View context engine"
      >
        <div class="info-card-title">Context Engine</div>
        <div class="context-summary-grid">
          <div class="context-metric">
            <span class="context-metric-value">${ctx.cacheHitRate}%</span>
            <span class="context-metric-label">Cache Hit Rate</span>
          </div>
          <div class="context-metric">
            <ic-metric-gauge
              .value=${ctx.budgetUtilization}
              label="Budget Used"
              size="sm"
            ></ic-metric-gauge>
          </div>
          <div class="context-metric">
            <span class="context-metric-value">${formatNumber(ctx.reReads)}</span>
            <span class="context-metric-label">Re-reads</span>
          </div>
          <div class="context-metric">
            <span class="context-metric-value">${formatNumber(ctx.totalEvictions)}</span>
            <span class="context-metric-label">Evictions</span>
          </div>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  override render() {
    if (this._loadState === "loading") {
      return html`<ic-skeleton-view variant="dashboard"></ic-skeleton-view>`;
    }

    if (this._loadState === "error") {
      return html`
        <div class="error-container">
          <span class="error-message">${this._error}</span>
          <button class="retry-btn" @click=${() => this._loadData()}>Retry</button>
        </div>
      `;
    }

    const activeAgents = this._agents.filter((a) => a.status === "active").length;
    // RPC-dependent stat cards show "---" placeholder when the WS connection is
    // not yet established (status !== "connected"). The presence of an
    // RpcClient instance is not sufficient -- the daemon may be unreachable.
    // Use the @state-tracked _rpcStatus so render reruns on status changes.
    const hasRpc = this.rpcClient != null && this._rpcStatus === "connected";

    // Compute deltas for messages, tokens, cost
    const msgDelta = this._computeDelta(this._messagesToday, this._prevMessages);
    const tokenDelta = this._computeDelta(this._tokenUsageToday, this._prevTokens);
    const costDelta = this._computeDelta(this._totalCost, this._prevCost);

    return html`
      <div class="dashboard-grid" role="region" aria-label="Dashboard">
        <!-- Stats row: 6 stat cards with click-to-navigate -->
        <div class="stats-row" aria-live="polite">
          <div class="stat-card-link" role="link" tabindex="0"
            @click=${() => this._navigate(NAV_TARGETS.agents)}
            @keydown=${this._makeKeyHandler(NAV_TARGETS.agents)}
            aria-label="View all agents"
          >
            <ic-stat-card
              label="Active Agents"
              .value=${`${activeAgents}/${this._agents.length}`}
            ></ic-stat-card>
          </div>
          <div class="stat-card-link" role="link" tabindex="0"
            @click=${() => this._navigate(NAV_TARGETS.sessions)}
            @keydown=${this._makeKeyHandler(NAV_TARGETS.sessions)}
            aria-label="View all sessions"
          >
            <ic-stat-card
              label="Sessions"
              .value=${hasRpc ? formatNumber(this._sessionCount) : "---"}
            ></ic-stat-card>
          </div>
          <div class="stat-card-link" role="link" tabindex="0"
            @click=${() => this._navigate(NAV_TARGETS.messages)}
            @keydown=${this._makeKeyHandler(NAV_TARGETS.messages)}
            aria-label="View message delivery"
          >
            <ic-stat-card
              label="Messages Today"
              .value=${hasRpc ? formatNumber(this._messagesToday) : "---"}
              .trend=${hasRpc ? msgDelta.trend : ""}
              .trendValue=${hasRpc ? msgDelta.trendValue : ""}
            ></ic-stat-card>
          </div>
          <div class="stat-card-link" role="link" tabindex="0"
            @click=${() => this._navigate(NAV_TARGETS.tokens)}
            @keydown=${this._makeKeyHandler(NAV_TARGETS.tokens)}
            aria-label="View token billing"
          >
            <ic-stat-card
              label="Tokens Today"
              .value=${hasRpc ? formatTokens(this._tokenUsageToday) : "---"}
              .trend=${hasRpc ? tokenDelta.trend : ""}
              .trendValue=${hasRpc ? tokenDelta.trendValue : ""}
            ></ic-stat-card>
          </div>
          <div class="stat-card-link" role="link" tabindex="0"
            @click=${() => this._navigate(NAV_TARGETS.cost)}
            @keydown=${this._makeKeyHandler(NAV_TARGETS.cost)}
            aria-label="View cost billing"
          >
            <ic-stat-card
              label="Cost Today"
              .value=${hasRpc ? costFormatter.format(this._totalCost) : "---"}
              .trend=${hasRpc ? costDelta.trend : ""}
              .trendValue=${hasRpc ? costDelta.trendValue : ""}
            ></ic-stat-card>
          </div>
          <div class="stat-card-link" role="link" tabindex="0"
            @click=${() => this._navigate(NAV_TARGETS.errors)}
            @keydown=${this._makeKeyHandler(NAV_TARGETS.errors)}
            aria-label="View error diagnostics"
          >
            <ic-stat-card
              label="Errors"
              .value=${hasRpc ? formatNumber(this._errorCount) : "---"}
              .threshold=${this._errorCount > 10 ? "critical" : this._errorCount > 3 ? "warning" : "normal"}
            ></ic-stat-card>
          </div>
        </div>

        <!-- Info cards row: System Health + Context Engine Summary (clickable) -->
        <div class="info-cards-row">
          ${this._renderSystemHealth()}
          ${this._renderContextSummary()}
        </div>

        <!-- Sparklines row -->
        <div class="sparklines-row">
          <div class="sparkline-card" role="link" tabindex="0"
            @click=${() => this._navigate(NAV_TARGETS.tokens)}
            @keydown=${this._makeKeyHandler(NAV_TARGETS.tokens)}
            aria-label="View token usage details"
          >
            <div class="sparkline-header">
              <span class="sparkline-title">Token Usage (24h)</span>
              <ic-sparkline
                .data=${this._tokenSparklineData}
                width=${120}
                height=${32}
                color="var(--ic-accent)"
              ></ic-sparkline>
            </div>
          </div>
          <div class="sparkline-card" role="link" tabindex="0"
            @click=${() => this._navigate(NAV_TARGETS.cost)}
            @keydown=${this._makeKeyHandler(NAV_TARGETS.cost)}
            aria-label="View cost trend details"
          >
            <div class="sparkline-header">
              <span class="sparkline-title">Cost Trend (7d)</span>
              <ic-sparkline
                .data=${this._costSparklineData}
                width=${120}
                height=${32}
                color="var(--ic-success)"
              ></ic-sparkline>
            </div>
          </div>
        </div>

        <!-- Agents section -->
        <div class="section">
          <span class="section-title section-title--link"
            role="link" tabindex="0"
            @click=${() => this._navigate(NAV_TARGETS.agents)}
            @keydown=${this._makeKeyHandler(NAV_TARGETS.agents)}
          >Agents</span>
          <div class="agents-grid">
            ${this._agents.length === 0
              ? html`<div class="empty-text">No agents configured</div>`
              : this._agents.map((agent) => {
                  const billing = this._agentBilling.get(agent.id);
                  return html`
                    <div class="agent-card-wrapper">
                      <ic-agent-card
                        .name=${agent.name ?? agent.id}
                        .provider=${agent.provider}
                        .model=${agent.model}
                        .status=${agent.status}
                        .suspended=${agent.status === "suspended"}
                        .actionsDisabled=${Boolean(this._agentActionPending)}
                        .agentId=${agent.id}
                        .messagesToday=${agent.messagesToday ?? 0}
                        .tokenUsageToday=${agent.tokenUsageToday ?? 0}
                        @agent-action=${(e: CustomEvent<AgentCardActionDetail>) =>
                          this._handleAgentAction(e)}
                      ></ic-agent-card>
                      ${billing ? html`<div class="agent-cost-badge">${costFormatter.format(billing.cost)}</div>` : nothing}
                    </div>
                  `;
                })}
          </div>
        </div>

        <!-- Channels section -->
        <div class="section">
          <span class="section-title section-title--link"
            role="link" tabindex="0"
            @click=${() => this._navigate(NAV_TARGETS.channels)}
            @keydown=${this._makeKeyHandler(NAV_TARGETS.channels)}
          >Channels</span>
          <div class="channels-row">
            ${this._channels.length === 0
              ? html`<div class="empty-text">No channels configured</div>`
              : this._channels.map(
                  (ch) => html`
                    <ic-channel-badge
                      .channelType=${ch.type}
                      .name=${ch.name}
                      .status=${ch.status}
                      .enabled=${ch.enabled}
                      .uptime=${ch.uptime}
                    ></ic-channel-badge>
                  `,
                )}
          </div>
        </div>

        <!-- Activity section -->
        <div class="section">
          <ic-activity-feed
            .entries=${this._activity}
            .sseSubscribe=${this._getSseSubscriber()}
          ></ic-activity-feed>
        </div>
      </div>
      ${this._deleteTarget
        ? html`
            <ic-confirm-dialog
              open
              variant="danger"
              title="Delete Agent"
              message=${`Are you sure you want to delete agent ${this._deleteTarget.id}? This cannot be undone.`}
              confirmLabel="Delete"
              @confirm=${() => void this._confirmAgentDelete()}
              @cancel=${() => { this._deleteTarget = null; }}
            ></ic-confirm-dialog>
          `
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-dashboard": IcDashboard;
  }
}
