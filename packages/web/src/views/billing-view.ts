// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { SseController } from "../state/sse-controller.js";
import type {
  BillingDrillLevel,
  BillingByProvider,
  BillingByAgent,
  BillingBySession,
  AgentInfo,
  CostSegment,
} from "../api/types/index.js";

// Side-effect imports (register custom elements)
import "../components/data/ic-stat-card.js";
import "../components/data/ic-cost-breakdown.js";
import "../components/data/ic-time-range-picker.js";
import "../components/feedback/ic-loading.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/feedback/ic-empty-state.js";

type LoadState = "loading" | "loaded" | "error";

/** Auto-refresh interval for RPC data in milliseconds. */
const RPC_REFRESH_INTERVAL_MS = 30_000;

/** Default time range: 7 days in milliseconds. */
const DEFAULT_SINCE_MS = 604_800_000;

/** Provider color palette for cost breakdown segments. */
const PROVIDER_COLORS = [
  "var(--ic-accent)",
  "var(--ic-success)",
  "var(--ic-warning)",
  "var(--ic-info, #3b82f6)",
  "var(--ic-error)",
  "#a78bfa",
  "#f472b6",
  "#34d399",
];

/** Billing total shape returned by obs.billing.total RPC. */
interface BillingTotalData {
  totalCost: number;
  totalTokens: number;
  callCount: number;
}

/**
 * Standalone billing view with 4-level cost attribution drill-down.
 *
 * Drill levels: total -> provider -> agent -> session.
 * Each level provides a breadcrumb trail for navigation and respects
 * the selected time range from ic-time-range-picker.
 *
 * Data flows: obs.billing.* RPC -> this view.
 */
@customElement("ic-billing-view")
export class IcBillingView extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host { display: block; }

      .billing-view { padding: 0; }

      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--ic-space-lg);
        flex-wrap: wrap;
        gap: var(--ic-space-sm);
      }

      .breadcrumb {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
        font-size: var(--ic-text-base);
        font-weight: 600;
        color: var(--ic-text);
      }

      .breadcrumb-link {
        color: var(--ic-accent);
        cursor: pointer;
        background: none;
        border: none;
        font-size: inherit;
        font-weight: inherit;
        font-family: inherit;
        padding: 0;
      }

      .breadcrumb-link:hover { text-decoration: underline; }
      .breadcrumb-link:focus-visible { outline: 2px solid var(--ic-accent); outline-offset: 2px; }

      .breadcrumb-sep { color: var(--ic-text-dim); }

      .section { margin-bottom: var(--ic-space-xl); }

      .section-title {
        font-size: var(--ic-text-base);
        font-weight: 600;
        color: var(--ic-text);
        margin-bottom: var(--ic-space-md);
      }

      .stats-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--ic-space-md);
        margin-bottom: var(--ic-space-lg);
      }

      .card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-lg);
      }

      /* CSS grid tables */
      .grid-table {
        display: grid;
        gap: 0;
        font-size: var(--ic-text-sm);
      }

      .grid-header, .grid-row {
        display: contents;
      }

      .grid-header > .cell {
        font-weight: 600;
        color: var(--ic-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-size: var(--ic-text-xs);
        padding: var(--ic-space-sm) var(--ic-space-md);
        border-bottom: 1px solid var(--ic-border);
      }

      .grid-row > .cell {
        padding: var(--ic-space-sm) var(--ic-space-md);
        border-bottom: 1px solid var(--ic-border);
        color: var(--ic-text);
      }

      .cell-right { text-align: right; }

      .cell-mono {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
      }

      .grid-row.clickable > .cell { cursor: pointer; }
      .grid-row.clickable:hover > .cell { background: var(--ic-surface-2, #1f2937); }

      .provider-table, .model-table, .agent-table, .session-table {
        grid-template-columns: 1fr repeat(3, auto);
      }

      .pct-bar {
        display: inline-block;
        height: 4px;
        background: var(--ic-accent);
        border-radius: 2px;
        margin-right: var(--ic-space-xs);
        vertical-align: middle;
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
  @state() private _drillLevel: BillingDrillLevel = "total";
  @state() private _drillContext: { provider?: string; agentId?: string; sessionKey?: string } = {};
  @state() private _sinceMs = DEFAULT_SINCE_MS;
  @state() private _selectedRange = "7d";
  @state() private _billingTotal: BillingTotalData | null = null;
  @state() private _previousTotal: BillingTotalData | null = null;
  @state() private _providers: BillingByProvider[] = [];
  @state() private _agentBillings: BillingByAgent[] = [];
  @state() private _sessionBillings: BillingBySession[] = [];

  private _refreshInterval: ReturnType<typeof setInterval> | null = null;
  private _rpcStatusUnsub: (() => void) | null = null;

  /* ---- Formatters ---- */

  private _fmtCost = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  private _fmtNum = new Intl.NumberFormat("en-US");

  private _formatCost(n: number): string {
    return this._fmtCost.format(n);
  }

  private _formatNumber(n: number): string {
    return this._fmtNum.format(n);
  }

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
      "observability:token_usage": () => { this._scheduleReload(); },
      "diagnostic:billing_snapshot": () => { this._scheduleReload(); },
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
      switch (this._drillLevel) {
        case "total":
          await this._loadTotalLevel(rpc);
          break;
        case "provider":
          await this._loadProviderLevel(rpc);
          break;
        case "agent":
          await this._loadAgentLevel(rpc);
          break;
        case "session":
          await this._loadSessionLevel(rpc);
          break;
      }
      this._loadState = "loaded";
    } catch {
      this._loadState = "error";
    }
  }

  private async _loadTotalLevel(rpc: RpcClient): Promise<void> {
    // Load current billing first (primary data for stat cards)
    const raw = await rpc.call<Record<string, unknown>>("obs.billing.total", { sinceMs: this._sinceMs });
    this._billingTotal = {
      totalCost: Number(raw.totalCost ?? 0),
      totalTokens: Number(raw.totalTokens ?? 0),
      callCount: Number(raw.callCount ?? 0),
    };

    // Load cumulative (for deltas) and provider breakdown in the background
    Promise.allSettled([
      rpc.call<Record<string, unknown>>("obs.billing.total", { sinceMs: this._sinceMs * 2 }),
      rpc.call<unknown>("obs.billing.byProvider", { sinceMs: this._sinceMs }),
    ]).then(([cumulativeResult, providersResult]) => {
      if (cumulativeResult.status === "fulfilled" && this._billingTotal) {
        const cumRaw = cumulativeResult.value;
        const cumulative: BillingTotalData = {
          totalCost: Number(cumRaw.totalCost ?? 0),
          totalTokens: Number(cumRaw.totalTokens ?? 0),
          callCount: Number(cumRaw.callCount ?? 0),
        };
        this._previousTotal = {
          totalCost: cumulative.totalCost - this._billingTotal.totalCost,
          totalTokens: cumulative.totalTokens - this._billingTotal.totalTokens,
          callCount: cumulative.callCount - this._billingTotal.callCount,
        };
      }

      if (providersResult.status === "fulfilled") {
        const provRaw = providersResult.value;
        if (Array.isArray(provRaw)) {
          this._providers = provRaw;
        } else {
          const wrapped = provRaw as Record<string, unknown>;
          this._providers = Array.isArray(wrapped.providers) ? wrapped.providers as BillingByProvider[] : [];
        }
      }
    });
  }

  private async _loadProviderLevel(rpc: RpcClient): Promise<void> {
    const raw = await rpc.call<unknown>("obs.billing.byProvider", { sinceMs: this._sinceMs });
    if (Array.isArray(raw)) {
      this._providers = raw;
    } else {
      const wrapped = raw as Record<string, unknown>;
      this._providers = Array.isArray(wrapped.providers) ? wrapped.providers as BillingByProvider[] : [];
    }
  }

  private async _loadAgentLevel(rpc: RpcClient): Promise<void> {
    const listResult = await rpc.call<Record<string, unknown>>("agents.list");
    const agentData = Array.isArray(listResult)
      ? listResult
      : Array.isArray((listResult as Record<string, unknown>).agents)
        ? (listResult as { agents: AgentInfo[] | string[] }).agents
        : [];

    const agentIds = agentData.map((a: AgentInfo | string) =>
      typeof a === "string" ? a : a.id,
    );

    if (agentIds.length === 0) {
      this._agentBillings = [];
      return;
    }

    const results = await Promise.allSettled(
      agentIds.map((id) =>
        rpc.call<Record<string, unknown>>("obs.billing.byAgent", { agentId: id, sinceMs: this._sinceMs }),
      ),
    );

    this._agentBillings = results
      .map((r, i) => {
        if (r.status !== "fulfilled") return null;
        const raw = r.value;
        return {
          agentId: agentIds[i]!,
          totalTokens: Number(raw.tokensToday ?? raw.totalTokens ?? 0),
          percentOfTotal: Number(raw.percentOfTotal ?? 0),
          cost: Number(raw.costToday ?? raw.cost ?? 0),
        };
      })
      .filter((a): a is BillingByAgent => a !== null)
      .sort((a, b) => b.cost - a.cost);
  }

  private async _loadSessionLevel(rpc: RpcClient): Promise<void> {
    const agentId = this._drillContext.agentId;
    if (!agentId) {
      this._sessionBillings = [];
      return;
    }

    try {
      const raw = await rpc.call<unknown>("obs.billing.bySession", {
        sessionKey: "all",
        agentId,
        sinceMs: this._sinceMs,
      });

      if (Array.isArray(raw)) {
        this._sessionBillings = raw;
      } else {
        const wrapped = raw as Record<string, unknown>;
        this._sessionBillings = Array.isArray(wrapped.sessions) ? wrapped.sessions as BillingBySession[] : [];
      }
    } catch {
      this._sessionBillings = [];
    }
  }

  /* ---- Navigation ---- */

  private _drillDown(level: BillingDrillLevel, context: Partial<typeof this._drillContext>): void {
    this._drillLevel = level;
    this._drillContext = { ...this._drillContext, ...context };
    this._loadData();
  }

  private _drillUp(targetLevel: BillingDrillLevel): void {
    this._drillLevel = targetLevel;
    if (targetLevel === "total") {
      this._drillContext = {};
    } else if (targetLevel === "provider") {
      this._drillContext = { provider: this._drillContext.provider };
    } else if (targetLevel === "agent") {
      this._drillContext = { provider: this._drillContext.provider, agentId: this._drillContext.agentId };
    }
    this._loadData();
  }

  private _onTimeRangeChange(e: CustomEvent<{ sinceMs: number; label: string }>): void {
    this._sinceMs = e.detail.sinceMs;
    this._selectedRange = e.detail.label;
    this._loadData();
  }

  /* ---- Delta helpers ---- */

  private _computeDelta(current: number, previous: number): { trend: string; value: string } {
    if (previous === 0) {
      return current > 0 ? { trend: "up", value: "new" } : { trend: "flat", value: "" };
    }
    const pct = ((current - previous) / previous) * 100;
    if (Math.abs(pct) < 0.1) return { trend: "flat", value: "0%" };
    return {
      trend: pct > 0 ? "up" : "down",
      value: `${Math.abs(pct).toFixed(1)}%`,
    };
  }

  /* ---- Breadcrumb ---- */

  private _renderBreadcrumb() {
    const crumbs: Array<{ label: string; level: BillingDrillLevel }> = [
      { label: "Billing", level: "total" },
    ];

    if (this._drillLevel !== "total" && this._drillContext.provider) {
      crumbs.push({ label: this._drillContext.provider, level: "provider" });
    }
    if ((this._drillLevel === "agent" || this._drillLevel === "session") && this._drillContext.agentId) {
      crumbs.push({ label: this._drillContext.agentId, level: "agent" });
    }
    if (this._drillLevel === "session" && this._drillContext.sessionKey) {
      crumbs.push({ label: this._drillContext.sessionKey, level: "session" });
    }

    return html`
      <nav class="breadcrumb" aria-label="Billing navigation">
        ${crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return html`
            ${i > 0 ? html`<span class="breadcrumb-sep">/</span>` : nothing}
            ${isLast
              ? html`<span>${crumb.label}</span>`
              : html`<button class="breadcrumb-link" @click=${() => this._drillUp(crumb.level)}>${crumb.label}</button>`}
          `;
        })}
      </nav>
    `;
  }

  /* ---- Level renderers ---- */

  private _renderTotalLevel() {
    const total = this._billingTotal;
    const prev = this._previousTotal;

    const costDelta = total && prev ? this._computeDelta(total.totalCost, prev.totalCost) : null;
    const tokenDelta = total && prev ? this._computeDelta(total.totalTokens, prev.totalTokens) : null;
    const callDelta = total && prev ? this._computeDelta(total.callCount, prev.callCount) : null;

    const segments: CostSegment[] = this._providers.map((p, i) => ({
      label: p.provider,
      value: p.totalCost,
      color: PROVIDER_COLORS[i % PROVIDER_COLORS.length]!,
    }));

    const totalCacheSaved = this._providers.reduce((sum, p) => sum + (p.totalCacheSaved ?? 0), 0);

    return html`
      <div class="stats-row">
        <ic-stat-card
          label="Total Cost"
          .value=${total ? this._formatCost(total.totalCost) : "---"}
          .trend=${costDelta?.trend ?? ""}
          .trendValue=${costDelta?.value ?? ""}
        ></ic-stat-card>
        <ic-stat-card
          label="Total Tokens"
          .value=${total ? this._formatNumber(total.totalTokens) : "---"}
          .trend=${tokenDelta?.trend ?? ""}
          .trendValue=${tokenDelta?.value ?? ""}
        ></ic-stat-card>
        <ic-stat-card
          label="API Calls"
          .value=${total ? this._formatNumber(total.callCount) : "---"}
          .trend=${callDelta?.trend ?? ""}
          .trendValue=${callDelta?.value ?? ""}
        ></ic-stat-card>
        ${totalCacheSaved > 0 ? html`
          <ic-stat-card
            label="Cache Savings"
            .value=${this._formatCost(totalCacheSaved)}
            trend="down"
            trendValue="saved"
          ></ic-stat-card>
        ` : nothing}
      </div>

      ${segments.length > 0
        ? html`
            <div class="section">
              <div class="section-title">Cost by Provider</div>
              <div class="card">
                <ic-cost-breakdown
                  .segments=${segments}
                  @segment-click=${(e: CustomEvent<{ label: string }>) => {
                    this._drillDown("provider", { provider: e.detail.label });
                  }}
                ></ic-cost-breakdown>
              </div>
            </div>
          `
        : nothing}
    `;
  }

  private _renderProviderLevel() {
    const provider = this._providers.find((p) => p.provider === this._drillContext.provider);
    if (!provider) {
      return html`<ic-empty-state icon="dollar-sign" message="No data for this provider"></ic-empty-state>`;
    }

    const models = provider.models ?? [];
    const modelSegments: CostSegment[] = models.map((m, i) => ({
      label: m.model,
      value: m.cost,
      color: PROVIDER_COLORS[i % PROVIDER_COLORS.length]!,
    }));

    return html`
      ${(provider.totalCacheSaved ?? 0) > 0 ? html`
        <div class="stats-row">
          <ic-stat-card
            label="Provider Cost"
            .value=${this._formatCost(provider.totalCost)}
          ></ic-stat-card>
          <ic-stat-card
            label="Cache Savings"
            .value=${this._formatCost(provider.totalCacheSaved)}
            trend="down"
            trendValue="saved"
          ></ic-stat-card>
        </div>
      ` : nothing}

      ${modelSegments.length > 0
        ? html`
            <div class="section">
              <div class="section-title">Cost by Model</div>
              <div class="card">
                <ic-cost-breakdown .segments=${modelSegments}></ic-cost-breakdown>
              </div>
            </div>
          `
        : nothing}

      <div class="section">
        <div class="section-title">Model Breakdown</div>
        <div class="card">
          <div class="grid-table model-table" role="table" aria-label="Model breakdown">
            <div class="grid-header" role="row">
              <div class="cell" role="columnheader">Model</div>
              <div class="cell cell-right" role="columnheader">Tokens</div>
              <div class="cell cell-right" role="columnheader">Cost</div>
              <div class="cell cell-right" role="columnheader">Calls</div>
            </div>
            ${models.map((m) => {
              const pct = provider.totalCost > 0 ? (m.cost / provider.totalCost) * 100 : 0;
              return html`
                <div class="grid-row" role="row">
                  <div class="cell" role="cell">${m.model}</div>
                  <div class="cell cell-mono cell-right" role="cell">${this._formatNumber(m.tokens)}</div>
                  <div class="cell cell-mono cell-right" role="cell">
                    <span class="pct-bar" style="width: ${Math.max(pct, 2)}px"></span>
                    ${this._formatCost(m.cost)} (${pct.toFixed(1)}%)
                  </div>
                  <div class="cell cell-mono cell-right" role="cell">${this._formatNumber(m.calls)}</div>
                </div>
              `;
            })}
          </div>
        </div>
      </div>

      <div class="section">
        <button
          class="breadcrumb-link"
          @click=${() => this._drillDown("agent", {})}
        >View agent breakdown</button>
      </div>
    `;
  }

  private _renderAgentLevel() {
    if (this._agentBillings.length === 0) {
      return html`<ic-empty-state icon="users" message="No agent billing data available"></ic-empty-state>`;
    }

    return html`
      <div class="section">
        <div class="section-title">Agent Billing</div>
        <div class="card">
          <div class="grid-table agent-table" role="table" aria-label="Agent billing">
            <div class="grid-header" role="row">
              <div class="cell" role="columnheader">Agent ID</div>
              <div class="cell cell-right" role="columnheader">Tokens</div>
              <div class="cell cell-right" role="columnheader">% of Total</div>
              <div class="cell cell-right" role="columnheader">Cost</div>
            </div>
            ${this._agentBillings.map(
              (a) => html`
                <div
                  class="grid-row clickable"
                  role="row"
                  @click=${() => this._drillDown("session", { agentId: a.agentId })}
                >
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
    `;
  }

  private _renderSessionLevel() {
    if (this._sessionBillings.length === 0) {
      return html`<ic-empty-state icon="list" message="No session billing data available for this agent"></ic-empty-state>`;
    }

    const sorted = [...this._sessionBillings].sort((a, b) => b.totalCost - a.totalCost);

    return html`
      <div class="section">
        <div class="section-title">Session Billing</div>
        <div class="card">
          <div class="grid-table session-table" role="table" aria-label="Session billing">
            <div class="grid-header" role="row">
              <div class="cell" role="columnheader">Session Key</div>
              <div class="cell cell-right" role="columnheader">Tokens</div>
              <div class="cell cell-right" role="columnheader">Cost</div>
              <div class="cell cell-right" role="columnheader">API Calls</div>
            </div>
            ${sorted.map(
              (s) => html`
                <div class="grid-row" role="row">
                  <div class="cell cell-mono" role="cell">${s.sessionKey}</div>
                  <div class="cell cell-mono cell-right" role="cell">${this._formatNumber(s.totalTokens)}</div>
                  <div class="cell cell-mono cell-right" role="cell">${this._formatCost(s.totalCost)}</div>
                  <div class="cell cell-mono cell-right" role="cell">${this._formatNumber(s.callCount)}</div>
                </div>
              `,
            )}
          </div>
        </div>
      </div>
    `;
  }

  /* ---- Main render ---- */

  override render() {
    if (this._loadState === "loading" && !this.rpcClient) {
      return html`<ic-skeleton-view variant="table"></ic-skeleton-view>`;
    }

    if (this._loadState === "error") {
      return html`
        <div class="error-container">
          <span class="error-message">Failed to load billing data</span>
          <button class="retry-btn" @click=${() => this._tryLoad()}>Retry</button>
        </div>
      `;
    }

    return html`
      <div class="billing-view">
        <div class="header">
          ${this._renderBreadcrumb()}
          <ic-time-range-picker
            .selected=${this._selectedRange}
            @time-range-change=${this._onTimeRangeChange}
          ></ic-time-range-picker>
        </div>

        ${this._drillLevel === "total" ? this._renderTotalLevel() : nothing}
        ${this._drillLevel === "provider" ? this._renderProviderLevel() : nothing}
        ${this._drillLevel === "agent" ? this._renderAgentLevel() : nothing}
        ${this._drillLevel === "session" ? this._renderSessionLevel() : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-billing-view": IcBillingView;
  }
}
