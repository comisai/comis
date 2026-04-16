import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { SseController } from "../state/sse-controller.js";
import type { AgentInfo, PipelineSnapshot, DagCompactionSnapshot } from "../api/types/index.js";

// Side-effect imports (register custom elements)
import "../components/data/ic-budget-segment-bar.js";
import "../components/data/ic-layer-waterfall.js";
import "../components/data/ic-metric-gauge.js";
import "../components/data/ic-eviction-chart.js";
import "../components/data/ic-relative-time.js";
import "../components/feedback/ic-loading.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/feedback/ic-empty-state.js";

type LoadState = "loading" | "loaded" | "error";

/** Auto-refresh interval for RPC data in milliseconds. */
const RPC_REFRESH_INTERVAL_MS = 30_000;

/**
 * Context Engine view: pipeline metrics, layer waterfall, and DAG compaction panel.
 *
 * Displays end-to-end observability for the context engine pipeline including
 * token budget allocation, cache hit rates, eviction breakdowns, per-layer
 * waterfall timing, and optional DAG compaction metrics.
 *
 * Data flows: EventBus -> daemon ContextPipelineCollector -> obs.context.* RPC -> this view.
 */
@customElement("ic-context-engine-view")
export class IcContextEngineView extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .context-engine-view {
        padding: 0;
      }

      .section {
        margin-bottom: var(--ic-space-xl);
      }

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

      .metrics-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--ic-space-md);
      }

      @media (max-width: 767px) {
        .metrics-grid {
          grid-template-columns: 1fr;
        }
      }

      .budget-bar-container {
        grid-column: 1 / -1;
      }

      .stat-badges {
        display: flex;
        gap: var(--ic-space-md);
        flex-wrap: wrap;
        margin-top: var(--ic-space-md);
      }

      .stat-badge {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
        background: var(--ic-surface-2, #1f2937);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-xs) var(--ic-space-sm);
        font-size: var(--ic-text-sm);
        color: var(--ic-text-dim);
      }

      .stat-badge .stat-value {
        font-weight: 600;
        color: var(--ic-text);
        font-family: var(--ic-font-mono, ui-monospace, monospace);
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

      /* Pipeline execution list */
      .execution-list {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
        margin-bottom: var(--ic-space-md);
      }

      .execution-row {
        display: flex;
        align-items: center;
        gap: var(--ic-space-md);
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        cursor: pointer;
        font-size: var(--ic-text-sm);
        transition: background var(--ic-transition);
      }

      .execution-row:hover {
        background: var(--ic-surface-2, #1f2937);
      }

      .execution-row.selected {
        border-color: var(--ic-accent);
        background: rgba(59, 130, 246, 0.1);
      }

      .execution-row .exec-time {
        color: var(--ic-text-dim);
        min-width: 6rem;
      }

      .execution-row .exec-agent {
        color: var(--ic-text);
        font-weight: 500;
        flex: 1;
      }

      .execution-row .exec-duration {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        color: var(--ic-text-dim);
      }

      .execution-row .exec-layers {
        color: var(--ic-text-dim);
      }

      /* DAG panel */
      .dag-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: var(--ic-space-md);
      }

      .dag-stat {
        text-align: center;
        padding: var(--ic-space-md);
      }

      .dag-stat .dag-value {
        font-size: 1.5rem;
        font-weight: 700;
        color: var(--ic-text);
        font-family: var(--ic-font-mono, ui-monospace, monospace);
      }

      .dag-stat .dag-label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-top: var(--ic-space-xs);
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
    `,
  ];

  /* ---- Public properties ---- */

  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  private _sse: SseController | null = null;
  private _reloadDebounce: ReturnType<typeof setTimeout> | null = null;

  /* ---- Internal state ---- */

  @state() private _loadState: LoadState = "loading";
  @state() private _pipelines: PipelineSnapshot[] = [];
  @state() private _dagCompactions: DagCompactionSnapshot[] = [];
  @state() private _selectedPipeline: PipelineSnapshot | null = null;
  @state() private _agentFilter = "";
  @state() private _agents: AgentInfo[] = [];

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
      "observability:token_usage": () => { this._scheduleReload(); },
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
    const filterParams: Record<string, unknown> = {};
    if (this._agentFilter) {
      filterParams.agentId = this._agentFilter;
    }

    // Load pipeline data first (primary content)
    try {
      const pipelineResult = await rpc.call<PipelineSnapshot[]>("obs.context.pipeline", filterParams);
      this._pipelines = Array.isArray(pipelineResult) ? pipelineResult : [];
    } catch {
      this._pipelines = [];
    }

    // Auto-select the most recent pipeline if none selected
    if (!this._selectedPipeline && this._pipelines.length > 0) {
      this._selectedPipeline = this._pipelines[0]!;
    }

    this._loadState = "loaded";

    // Load DAG compactions and agents list in the background
    Promise.allSettled([
      rpc.call<DagCompactionSnapshot[]>("obs.context.dag", filterParams),
      rpc.call<{ agents: AgentInfo[] }>("agents.list"),
    ]).then(([dagResult, agentsResult]) => {
      this._dagCompactions = dagResult.status === "fulfilled" && Array.isArray(dagResult.value)
        ? dagResult.value : [];

      if (agentsResult.status === "fulfilled") {
        const raw = agentsResult.value;
        const list: unknown[] = Array.isArray(raw) ? raw
          : Array.isArray((raw as Record<string, unknown>).agents)
            ? (raw as { agents: unknown[] }).agents
            : [];
        // agents.list may return plain string IDs - normalize to AgentInfo objects
        this._agents = list.map((item) =>
          typeof item === "string"
            ? { id: item, name: item, provider: "", model: "", status: "active" } as AgentInfo
            : item as AgentInfo,
        );
      }
    });
  }

  /* ---- Event handlers ---- */

  private _onAgentFilter(e: Event): void {
    this._agentFilter = (e.target as HTMLSelectElement).value;
    this._selectedPipeline = null;
    this._loadData();
  }

  private _onPipelineSelect(pipeline: PipelineSnapshot): void {
    this._selectedPipeline = pipeline;
  }

  /* ---- Formatters ---- */

  private _formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  private _formatNumber(n: number): string {
    return new Intl.NumberFormat("en-US").format(n);
  }

  /* ---- Section 1: Pipeline Metrics Panel ---- */

  private _renderPipelineMetrics() {
    const latest = this._pipelines.length > 0 ? this._pipelines[0]! : null;

    if (!latest) {
      return html`
        <div class="section">
          <div class="section-title">Pipeline Metrics</div>
          <ic-empty-state
            icon="activity"
            message="No pipeline data available. Pipeline metrics appear after the context engine processes messages."
          ></ic-empty-state>
        </div>
      `;
    }

    // Compute budget bar segments
    const system = Math.max(0, latest.tokensLoaded - latest.tokensEvicted - latest.tokensMasked - latest.tokensCompacted);
    const segments = [
      { label: "System", tokens: system, color: "var(--ic-accent)" },
      { label: "Evicted", tokens: latest.tokensEvicted, color: "var(--ic-error)" },
      { label: "Masked", tokens: latest.tokensMasked, color: "var(--ic-warning)" },
      { label: "Compacted", tokens: latest.tokensCompacted, color: "var(--ic-info, #3b82f6)" },
    ].filter((s) => s.tokens > 0);

    // Compute cache hit rate
    const cacheHitCount = this._pipelines.filter((p) => p.cacheHitTokens > 0).length;
    const cacheHitRate = this._pipelines.length > 0
      ? Math.round((cacheHitCount / this._pipelines.length) * 100)
      : 0;

    return html`
      <div class="section">
        <div class="section-title">Pipeline Metrics</div>
        <div class="card">
          <div class="metrics-grid">
            <div class="budget-bar-container">
              <ic-budget-segment-bar .segments=${segments}></ic-budget-segment-bar>
            </div>
            <ic-metric-gauge
              .value=${cacheHitRate}
              label="Cache Hit Rate"
              size="sm"
            ></ic-metric-gauge>
            <ic-eviction-chart
              .categories=${latest.evictionCategories}
            ></ic-eviction-chart>
          </div>
          <div class="stat-badges">
            <div class="stat-badge">
              Masked <span class="stat-value">${this._formatNumber(latest.tokensMasked)}</span> tokens
            </div>
            <div class="stat-badge">
              Duration <span class="stat-value">${latest.durationMs}</span>ms
            </div>
            <div class="stat-badge">
              Thinking removed <span class="stat-value">${latest.thinkingBlocksRemoved}</span>
            </div>
            <div class="stat-badge">
              Budget <span class="stat-value">${Math.round(latest.budgetUtilization * 100)}%</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /* ---- Section 2: Layer Waterfall ---- */

  private _renderLayerWaterfall() {
    const recentPipelines = this._pipelines.slice(0, 10);

    return html`
      <div class="section">
        <div class="section-title">Layer Waterfall</div>
        ${recentPipelines.length === 0
          ? html`<ic-empty-state icon="layers" message="No pipeline executions to display"></ic-empty-state>`
          : html`
              <div class="execution-list">
                ${recentPipelines.map(
                  (p) => html`
                    <button
                      class="execution-row ${this._selectedPipeline === p ? "selected" : ""}"
                      @click=${() => this._onPipelineSelect(p)}
                    >
                      <span class="exec-time">${this._formatTime(p.timestamp)}</span>
                      <span class="exec-agent">${p.agentId}</span>
                      <span class="exec-duration">${p.durationMs}ms</span>
                      <span class="exec-layers">${p.layerCount} layers</span>
                    </button>
                  `,
                )}
              </div>
              ${this._selectedPipeline && this._selectedPipeline.layers.length > 0
                ? html`
                    <div class="card">
                      <ic-layer-waterfall
                        .layers=${this._selectedPipeline.layers}
                        .totalDurationMs=${this._selectedPipeline.durationMs}
                      ></ic-layer-waterfall>
                    </div>
                  `
                : nothing}
            `}
      </div>
    `;
  }

  /* ---- Section 3: DAG Metrics Panel ---- */

  private _renderDagPanel() {
    if (this._dagCompactions.length === 0) {
      return nothing;
    }

    const total = this._dagCompactions.length;
    const avgSummaries = Math.round(
      this._dagCompactions.reduce((sum, d) => sum + d.totalSummariesCreated, 0) / total,
    );
    const maxDepth = Math.max(...this._dagCompactions.map((d) => d.maxDepthReached));
    const latestDuration = this._dagCompactions[0]!.durationMs;

    return html`
      <div class="section">
        <div class="section-title">DAG Compaction</div>
        <div class="card">
          <div class="dag-grid">
            <div class="dag-stat">
              <div class="dag-value">${total}</div>
              <div class="dag-label">Total Compactions</div>
            </div>
            <div class="dag-stat">
              <div class="dag-value">${avgSummaries}</div>
              <div class="dag-label">Avg Summaries</div>
            </div>
            <div class="dag-stat">
              <div class="dag-value">${maxDepth}</div>
              <div class="dag-label">Max Depth</div>
            </div>
            <div class="dag-stat">
              <div class="dag-value">${latestDuration}ms</div>
              <div class="dag-label">Latest Duration</div>
            </div>
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
          <span class="error-message">Failed to load context engine data</span>
          <button class="retry-btn" @click=${() => this._tryLoad()}>Retry</button>
        </div>
      `;
    }

    return html`
      <div class="context-engine-view">
        <div class="filter-row">
          ${this._renderAgentFilter()}
        </div>
        ${this._renderPipelineMetrics()}
        ${this._renderLayerWaterfall()}
        ${this._renderDagPanel()}
      </div>
    `;
  }

  /** Render agent filter dropdown (separate method for Lit rendering). */
  private _renderAgentFilter() {
    return html`
      <select class="filter-select" @change=${this._onAgentFilter}>
        <option value="">All Agents</option>
        ${this._agents.map((a) => html`<option value=${a.id}>${a.id}</option>`)}
      </select>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-context-engine-view": IcContextEngineView;
  }
}
