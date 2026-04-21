// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { AgentDetail, AgentBilling, HeartbeatAgentStateDto } from "../../api/types/index.js";
import type { ApiClient } from "../../api/api-client.js";
import type { RpcClient } from "../../api/rpc-client.js";
import type { EventDispatcher } from "../../state/event-dispatcher.js";
import { SseController } from "../../state/sse-controller.js";
import { IcToast } from "../../components/feedback/ic-toast.js";

// Side-effect imports to register custom elements used in template
import "../../components/nav/ic-breadcrumb.js";
import "../../components/data/ic-stat-card.js";
import "../../components/data/ic-metric-gauge.js";
import "../../components/domain/ic-budget-bar.js";
import "../../components/data/ic-tag.js";
import "../../components/feedback/ic-toast.js";
import "../../components/feedback/ic-loading.js";
import "../../components/shell/ic-skeleton-view.js";
import "../../components/feedback/ic-confirm-dialog.js";
import "../../components/data/ic-relative-time.js";

/**
 * Format a token count for display.
 * Returns "612K" for 612000, "1.2M" for 1200000, plain number for < 1000.
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const millions = n / 1_000_000;
    return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const thousands = n / 1_000;
    return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
  }
  return String(n);
}

/**
 * Format cost with Intl.NumberFormat.
 */
function formatCost(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Format a number with comma separators.
 */
function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Maps circuit breaker state to ic-tag variant. */
const CB_STATE_VARIANT: Record<string, string> = {
  closed: "success",
  open: "error",
  "half-open": "warning",
};

/** Skill description returned by the skills.list RPC. */
interface DiscoveredSkill {
  name: string;
  description: string;
  location: string;
  source?: "bundled" | "workspace" | "local";
  disableModelInvocation?: boolean;
}

/**
 * Agent detail view.
 *
 * Two-column layout: left (60%) has identity, stats, and config cards;
 * right (40%) has budget gauges, circuit breaker, skills, and heartbeat.
 * Collapses to single column on mobile (< 768px).
 *
 * @fires navigate - Dispatched when breadcrumb or edit button clicked, with route path as detail
 */
@customElement("ic-agent-detail")
export class IcAgentDetail extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      /* Header */
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--ic-space-lg, 1.5rem);
      }

      .header-left {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs, 0.25rem);
      }

      .agent-title {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm, 0.5rem);
      }

      .agent-title h1 {
        font-size: var(--ic-text-xl, 1.25rem);
        font-weight: 700;
        margin: 0;
      }

      .header-actions {
        display: flex;
        gap: var(--ic-space-sm, 0.5rem);
      }

      .btn {
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs, 0.25rem);
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        font-size: var(--ic-text-sm, 0.875rem);
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        transition: background var(--ic-transition, 150ms ease),
          border-color var(--ic-transition, 150ms ease),
          color var(--ic-transition, 150ms ease);
      }

      .btn--primary {
        background: var(--ic-accent, #3b82f6);
        color: #fff;
        border-color: var(--ic-accent, #3b82f6);
      }

      .btn--primary:hover {
        background: var(--ic-accent-hover, #2563eb);
      }

      .btn--secondary {
        background: transparent;
        color: var(--ic-text, #f3f4f6);
      }

      .btn--secondary:hover {
        background: var(--ic-surface-2, #1f2937);
        border-color: var(--ic-accent, #3b82f6);
      }

      .btn--danger {
        background: transparent;
        color: var(--ic-error, #f87171);
        border-color: var(--ic-error, #f87171);
      }

      .btn--danger:hover {
        background: color-mix(in srgb, var(--ic-error, #f87171) 10%, transparent);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Two-column layout */
      .detail-layout {
        display: grid;
        grid-template-columns: 3fr 2fr;
        gap: var(--ic-space-lg, 1.5rem);
      }

      .left-column,
      .right-column {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-lg, 1.5rem);
      }

      /* Card */
      .card {
        background: var(--ic-surface, #111827);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        padding: var(--ic-space-lg, 1.5rem);
      }

      .card-title {
        font-size: var(--ic-text-md, 1rem);
        font-weight: 600;
        margin: 0 0 var(--ic-space-md, 0.75rem) 0;
      }

      /* Identity rows */
      .identity-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        padding: var(--ic-space-xs, 0.25rem) 0;
        border-bottom: 1px solid color-mix(in srgb, var(--ic-border, #374151) 50%, transparent);
      }

      .identity-row:last-child {
        border-bottom: none;
      }

      .identity-label {
        font-size: var(--ic-text-sm, 0.875rem);
        color: var(--ic-text-dim, #858d9d);
      }

      .identity-value {
        font-size: var(--ic-text-sm, 0.875rem);
        color: var(--ic-text, #f3f4f6);
        font-weight: 500;
      }

      .identity-value--mono {
        font-family: var(--ic-font-mono, monospace);
        font-size: var(--ic-text-xs, 0.75rem);
      }

      /* Stats 2x2 grid */
      .stat-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--ic-space-sm, 0.5rem);
      }

      /* Config groups */
      .config-group {
        margin-bottom: var(--ic-space-md, 0.75rem);
      }

      .config-group:last-child {
        margin-bottom: 0;
      }

      .config-group-title {
        font-size: var(--ic-text-xs, 0.75rem);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--ic-text-dim, #858d9d);
        margin: 0 0 var(--ic-space-xs, 0.25rem) 0;
      }

      /* Budget gauges */
      .budget-gauges {
        display: flex;
        justify-content: space-around;
        gap: var(--ic-space-md, 0.75rem);
      }

      .budget-empty {
        color: var(--ic-text-dim, #858d9d);
        font-size: var(--ic-text-sm, 0.875rem);
        font-style: italic;
        text-align: center;
        padding: var(--ic-space-md, 0.75rem) 0;
      }

      /* Circuit breaker */
      .circuit-breaker {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs, 0.25rem);
      }

      .cb-row {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm, 0.5rem);
        font-size: var(--ic-text-sm, 0.875rem);
      }

      .cb-label {
        color: var(--ic-text-dim, #858d9d);
        min-width: 80px;
      }

      /* Skills */
      .skill-chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--ic-space-xs, 0.25rem);
      }

      .muted {
        color: var(--ic-text-dim, #858d9d);
        font-size: var(--ic-text-sm, 0.875rem);
        font-style: italic;
      }

      /* Heartbeat */
      .heartbeat-info {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs, 0.25rem);
      }

      .hb-row {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm, 0.5rem);
        font-size: var(--ic-text-sm, 0.875rem);
      }

      .hb-label {
        color: var(--ic-text-dim, #858d9d);
        min-width: 100px;
      }

      .hb-running {
        color: var(--ic-accent, #3b82f6);
        font-size: var(--ic-text-xs, 0.75rem);
        font-style: italic;
      }

      /* Error state */
      .error-container {
        text-align: center;
        padding: var(--ic-space-2xl, 3rem);
        color: var(--ic-text-muted, #9ca3af);
      }

      .error-message {
        margin-bottom: var(--ic-space-md, 0.75rem);
        color: var(--ic-error, #f87171);
      }

      .retry-btn {
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        background: transparent;
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        color: var(--ic-text, #f3f4f6);
        font-size: var(--ic-text-sm, 0.875rem);
        font-family: inherit;
        cursor: pointer;
      }

      .retry-btn:hover {
        border-color: var(--ic-accent, #3b82f6);
        color: var(--ic-accent, #3b82f6);
      }

      /* Responsive */
      @media (max-width: 767px) {
        .detail-layout {
          grid-template-columns: 1fr;
        }

        .stat-grid {
          grid-template-columns: 1fr;
        }

        .header {
          flex-direction: column;
          align-items: flex-start;
          gap: var(--ic-space-sm, 0.5rem);
        }

        .budget-gauges {
          flex-wrap: wrap;
        }
      }
    `,
  ];

  /** API client (injected from app.ts). */
  @property({ attribute: false }) apiClient: ApiClient | null = null;

  /** RPC client for data fetching and actions (injected from app.ts). */
  @property({ attribute: false }) rpcClient: RpcClient | null = null;

  /** Event dispatcher for SSE subscriptions (injected from app.ts). */
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  private _sse: SseController | null = null;
  private _reloadDebounce: ReturnType<typeof setTimeout> | null = null;

  /** Agent ID from route params. */
  @property() agentId = "";

  @state() private _agent: AgentDetail | null = null;
  @state() private _billing: AgentBilling | null = null;
  @state() private _skills: DiscoveredSkill[] = [];
  @state() private _loadState: "loading" | "loaded" | "error" = "loading";
  @state() private _error = "";
  @state() private _actionPending = false;
  @state() private _heartbeatState: HeartbeatAgentStateDto | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // Note: _loadData() is NOT called here -- rpcClient is typically
    // null at this point. The updated() callback handles loading once
    // the client property is set.
    this._initSse();
  }

  override updated(changed: Map<string, unknown>): void {
    if ((changed.has("agentId") || changed.has("rpcClient")) && this.agentId && this.rpcClient) {
      this._loadData();
    }
    if (changed.has("eventDispatcher") && this.eventDispatcher && !this._sse) {
      this._initSse();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._reloadDebounce !== null) {
      clearTimeout(this._reloadDebounce);
      this._reloadDebounce = null;
    }
  }

  private _initSse(): void {
    if (!this.eventDispatcher || this._sse) return;
    this._sse = new SseController(this, this.eventDispatcher, {
      "observability:token_usage": () => { this._scheduleReload(); },
      "scheduler:heartbeat_delivered": () => { this._scheduleReload(); },
    });
  }

  private _scheduleReload(delayMs = 300): void {
    if (this._reloadDebounce !== null) clearTimeout(this._reloadDebounce);
    this._reloadDebounce = setTimeout(() => {
      this._reloadDebounce = null;
      void this._loadData();
    }, delayMs);
  }

  async _loadData(): Promise<void> {
    if (!this.rpcClient || !this.agentId) return;

    this._loadState = "loading";
    this._error = "";

    try {
      // Load primary agent data first to unblock the skeleton
      const raw = await this.rpcClient.call<{ agentId: string; config: Record<string, unknown>; suspended?: boolean }>(
        "agents.get", { agentId: this.agentId },
      );
      this._agent = this._mapToAgentDetail(raw);
      this._loadState = "loaded";

      // Enrich with billing, skills, and heartbeat in the background
      const rpc = this.rpcClient;
      Promise.allSettled([
        rpc.call<AgentBilling>("obs.billing.byAgent", { agentId: this.agentId }),
        rpc.call<{ skills: DiscoveredSkill[] }>("skills.list", { agentId: this.agentId })
          .then((r) => r.skills ?? []),
        rpc.call<{ agents: HeartbeatAgentStateDto[] }>("heartbeat.states", {})
          .then((r) => (r.agents ?? []).find(a => a.agentId === this.agentId) ?? null),
      ]).then(([billing, skills, heartbeat]) => {
        this._billing = billing.status === "fulfilled" ? billing.value : null;
        this._skills = skills.status === "fulfilled" && Array.isArray(skills.value) ? skills.value : [];
        this._heartbeatState = heartbeat.status === "fulfilled" ? heartbeat.value : null;
      });
    } catch (e) {
      this._error = e instanceof Error ? e.message : "Failed to load agent";
      this._loadState = "error";
    }
  }

  /** Map daemon's { agentId, config: PerAgentConfig } response to the AgentDetail shape used by templates. */
  private _mapToAgentDetail(raw: { agentId: string; config: Record<string, unknown>; suspended?: boolean }): AgentDetail {
    const c = raw.config;
    const cb = c.circuitBreaker as Record<string, unknown> | undefined;
    const cg = c.contextGuard as Record<string, unknown> | undefined;
    const sr = c.sdkRetry as Record<string, unknown> | undefined;
    const mf = c.modelFailover as Record<string, unknown> | undefined;
    const rag = c.rag as Record<string, unknown> | undefined;
    const sess = c.session as Record<string, unknown> | undefined;
    const rp = sess?.resetPolicy as Record<string, unknown> | undefined;
    const conc = c.concurrency as Record<string, unknown> | undefined;

    return {
      id: raw.agentId,
      name: (c.name as string) ?? raw.agentId,
      status: raw.suspended ? "suspended" : "active",
      model: (c.model as string) ?? "",
      provider: (c.provider as string) ?? "",
      maxSteps: c.maxSteps as number | undefined,
      temperature: c.temperature as number | undefined,
      thinkingLevel: c.thinkingLevel as string | undefined,
      maxTokens: c.maxTokens as number | undefined,
      maxContextChars: c.maxContextChars as number | undefined,
      budgets: c.budgets as AgentDetail["budgets"],
      circuitBreaker: cb ? {
        state: "closed",
        failures: 0,
        threshold: cb.failureThreshold as number | undefined,
        resetTimeoutMs: cb.resetTimeoutMs as number | undefined,
      } : undefined,
      safety: {
        contextGuard: cg ? {
          enabled: cg.enabled as boolean,
          warnPct: cg.warnPercent as number,
          blockPct: cg.blockPercent as number,
        } : undefined,
        sdkRetry: sr ? {
          enabled: sr.enabled as boolean,
          maxRetries: sr.maxRetries as number,
          baseDelayMs: sr.baseDelayMs as number,
        } : undefined,
        modelFailover: mf ? {
          fallbackCount: ((mf.fallbackModels as unknown[]) ?? []).length,
        } : undefined,
      },
      rag: rag ? {
        enabled: rag.enabled as boolean,
        maxResults: rag.maxResults as number | undefined,
        minScore: rag.minScore as number | undefined,
        trustLevels: rag.includeTrustLevels as string[] | undefined,
      } : undefined,
      sessionPolicy: rp ? {
        resetMode: rp.mode as string | undefined,
        idleTimeoutMs: rp.idleTimeoutMs as number | undefined,
        dailyResetHour: rp.dailyResetHour as number | undefined,
        timezone: rp.dailyResetTimezone as string | undefined,
      } : undefined,
      concurrency: conc ? {
        maxConcurrent: conc.maxConcurrentRuns as number | undefined,
        maxQueued: conc.maxQueuedPerSession as number | undefined,
        queueMode: "followup",
      } : undefined,
      routingBindings: c.routingBindings as AgentDetail["routingBindings"],
    };
  }

  private _navigate(path: string): void {
    this.dispatchEvent(
      new CustomEvent("navigate", { detail: path, bubbles: true, composed: true }),
    );
  }

  private async _handleSuspendResume(): Promise<void> {
    if (!this.rpcClient || !this._agent || this._actionPending) return;

    this._actionPending = true;
    const isSuspended = this._agent.status === "suspended";
    const method = isSuspended ? "agents.resume" : "agents.suspend";
    const label = isSuspended ? "resumed" : "suspended";

    try {
      await this.rpcClient.call(method, { agentId: this.agentId });
      IcToast.show(`Agent ${this.agentId} ${label}`, "success");
      await this._loadData();
    } catch (err) {
      IcToast.show(
        `Failed to ${isSuspended ? "resume" : "suspend"} agent: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    } finally {
      this._actionPending = false;
    }
  }

  private async _handleDelete(): Promise<void> {
    if (!this.rpcClient || this._actionPending) return;

    this._actionPending = true;
    try {
      await this.rpcClient.call("agents.delete", { agentId: this.agentId });
      IcToast.show(`Agent ${this.agentId} deleted`, "success");
      this._navigate("agents");
    } catch (err) {
      IcToast.show(
        `Failed to delete agent: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    } finally {
      this._actionPending = false;
    }
  }

  override render() {
    switch (this._loadState) {
      case "loading":
        return html`<ic-skeleton-view variant="detail"></ic-skeleton-view>`;
      case "error":
        return html`
          <div class="error-container">
            <div class="error-message">${this._error}</div>
            <button class="retry-btn" @click=${() => this._loadData()}>Retry</button>
          </div>
        `;
      case "loaded":
        return this._renderDetail();
    }
  }

  private _renderDetail() {
    if (!this._agent) return nothing;

    const agent = this._agent;
    const isSuspended = agent.status === "suspended";
    const toggleLabel = isSuspended ? "Resume" : "Suspend";

    return html`
      <div class="header">
        <div class="header-left">
          <ic-breadcrumb
            .items=${[
              { label: "Agents", route: "agents" },
              { label: agent.name ?? agent.id },
            ]}
            @navigate=${(e: CustomEvent<string>) => this._navigate(e.detail)}
          ></ic-breadcrumb>
          <div class="agent-title">
            <h1>${agent.name ?? agent.id}</h1>
            <ic-tag variant=${isSuspended ? "warning" : "success"}>${agent.status}</ic-tag>
          </div>
        </div>
        <div class="header-actions">
          <button
            class="btn btn--secondary"
            @click=${() => this._navigate(`agents/${this.agentId}/workspace`)}
          >Workspace</button>
          <button
            class="btn btn--primary"
            @click=${() => this._navigate(`agents/${this.agentId}/edit`)}
          >Edit</button>
          <button
            class="btn btn--secondary"
            ?disabled=${this._actionPending}
            @click=${() => this._handleSuspendResume()}
          >${toggleLabel}</button>
          <button
            class="btn btn--danger"
            ?disabled=${this._actionPending}
            @click=${() => this._requestDelete()}
          >Delete</button>
        </div>
      </div>

      <div class="detail-layout">
        <div class="left-column">
          ${this._renderIdentityCard()}
          ${this._renderStatsCard()}
          ${this._renderConfigCard()}
        </div>
        <div class="right-column">
          ${this._renderBudgetGaugesCard()}
          ${this._renderCircuitBreakerCard()}
          ${this._renderSkillsCard()}
          ${this._renderHeartbeatCard()}
        </div>
      </div>

      <ic-confirm-dialog
        ?open=${this._deleteRequested}
        title="Delete Agent"
        message=${`Delete agent "${this.agentId}"? This action cannot be undone.`}
        variant="danger"
        confirmLabel="Delete"
        @confirm=${() => this._handleDelete()}
        @cancel=${() => { this._deleteRequested = false; }}
      ></ic-confirm-dialog>
    `;
  }

  @state() private _deleteRequested = false;

  private _requestDelete(): void {
    this._deleteRequested = true;
  }

  // --- Left column cards ---

  private _renderIdentityCard() {
    const agent = this._agent!;

    const rows: Array<{ label: string; value: string | undefined; mono?: boolean }> = [
      { label: "Agent ID", value: agent.id, mono: true },
      { label: "Display Name", value: agent.name },
      { label: "Provider", value: agent.provider },
      { label: "Model", value: agent.model },
      { label: "Temperature", value: agent.temperature !== undefined ? String(agent.temperature) : "default" },
      { label: "Max Steps", value: agent.maxSteps !== undefined ? String(agent.maxSteps) : "default" },
      { label: "Max Tokens", value: agent.maxTokens !== undefined ? formatNumber(agent.maxTokens) : "default" },
      { label: "Thinking Level", value: agent.thinkingLevel ?? "default" },
    ];

    return html`
      <div class="card">
        <h3 class="card-title">Identity</h3>
        ${rows.map(
          (r) => html`
            <div class="identity-row">
              <span class="identity-label">${r.label}</span>
              <span class="identity-value ${r.mono ? "identity-value--mono" : ""}">${r.value ?? "-"}</span>
            </div>
          `,
        )}
      </div>
    `;
  }

  private _renderStatsCard() {
    const billing = this._billing;
    const messages = formatNumber(billing?.messagesToday ?? 0);
    const tokens = formatTokens(billing?.tokensToday ?? 0);
    const sessions = String(billing?.activeSessions ?? 0);
    const cost = formatCost(billing?.costToday ?? 0);

    return html`
      <div class="card">
        <h3 class="card-title">Stats</h3>
        <div class="stat-grid">
          <ic-stat-card label="Messages Today" value=${messages}></ic-stat-card>
          <ic-stat-card label="Tokens Today" value=${tokens}></ic-stat-card>
          <ic-stat-card label="Cost Today" value=${cost}></ic-stat-card>
          <ic-stat-card label="Active Sessions" value=${sessions}></ic-stat-card>
        </div>
      </div>
    `;
  }

  private _renderConfigCard() {
    const agent = this._agent!;
    const hasSession = agent.sessionPolicy && (agent.sessionPolicy.resetMode || agent.sessionPolicy.idleTimeoutMs);
    const hasConcurrency = agent.concurrency && (agent.concurrency.maxConcurrent || agent.concurrency.maxQueued);
    const hasSafety = agent.safety && (agent.safety.contextGuard || agent.safety.sdkRetry || agent.safety.modelFailover);

    if (!hasSession && !hasConcurrency && !hasSafety) return nothing;

    return html`
      <div class="card">
        <h3 class="card-title">Configuration</h3>

        ${hasSession ? html`
          <div class="config-group">
            <h4 class="config-group-title">Session Policy</h4>
            ${agent.sessionPolicy?.resetMode ? html`
              <div class="identity-row">
                <span class="identity-label">Reset Mode</span>
                <span class="identity-value">${agent.sessionPolicy.resetMode}</span>
              </div>
            ` : nothing}
            ${agent.sessionPolicy?.idleTimeoutMs ? html`
              <div class="identity-row">
                <span class="identity-label">Idle Timeout</span>
                <span class="identity-value">${formatNumber(agent.sessionPolicy.idleTimeoutMs)}ms</span>
              </div>
            ` : nothing}
            ${agent.sessionPolicy?.timezone ? html`
              <div class="identity-row">
                <span class="identity-label">Timezone</span>
                <span class="identity-value">${agent.sessionPolicy.timezone}</span>
              </div>
            ` : nothing}
          </div>
        ` : nothing}

        ${hasConcurrency ? html`
          <div class="config-group">
            <h4 class="config-group-title">Concurrency</h4>
            ${agent.concurrency?.maxConcurrent !== undefined ? html`
              <div class="identity-row">
                <span class="identity-label">Max Concurrent</span>
                <span class="identity-value">${agent.concurrency.maxConcurrent}</span>
              </div>
            ` : nothing}
            ${agent.concurrency?.maxQueued !== undefined ? html`
              <div class="identity-row">
                <span class="identity-label">Queue Mode</span>
                <span class="identity-value">${agent.concurrency.queueMode ?? "followup"}</span>
              </div>
            ` : nothing}
          </div>
        ` : nothing}

        ${hasSafety ? html`
          <div class="config-group">
            <h4 class="config-group-title">Safety</h4>
            ${agent.safety?.contextGuard ? html`
              <div class="identity-row">
                <span class="identity-label">Context Guard</span>
                <span class="identity-value">
                  ${agent.safety.contextGuard.enabled ? "enabled" : "disabled"}
                  (warn: ${agent.safety.contextGuard.warnPct}%, block: ${agent.safety.contextGuard.blockPct}%)
                </span>
              </div>
            ` : nothing}
            ${agent.safety?.sdkRetry ? html`
              <div class="identity-row">
                <span class="identity-label">SDK Retry</span>
                <span class="identity-value">
                  ${agent.safety.sdkRetry.enabled ? "enabled" : "disabled"}
                  (${agent.safety.sdkRetry.maxRetries} retries)
                </span>
              </div>
            ` : nothing}
            ${agent.safety?.modelFailover ? html`
              <div class="identity-row">
                <span class="identity-label">Model Failover</span>
                <span class="identity-value">${agent.safety.modelFailover.fallbackCount} fallback models</span>
              </div>
            ` : nothing}
          </div>
        ` : nothing}
      </div>
    `;
  }

  // --- Right column cards ---

  private _renderBudgetGaugesCard() {
    const agent = this._agent!;
    const billing = this._billing;
    const budgets = agent.budgets;

    const hasBudgets = budgets && (
      budgets.perExecution !== undefined ||
      budgets.perHour !== undefined ||
      budgets.perDay !== undefined
    );

    return html`
      <div class="card">
        <h3 class="card-title">Budget</h3>
        ${hasBudgets ? html`
          <div class="budget-gauges">
            ${budgets!.perExecution !== undefined ? html`
              <ic-metric-gauge
                .value=${this._budgetPct(billing?.budgetUsed?.perExecution?.used ?? 0, budgets!.perExecution!)}
                label="Per Exec"
              ></ic-metric-gauge>
            ` : nothing}
            ${budgets!.perHour !== undefined ? html`
              <ic-metric-gauge
                .value=${this._budgetPct(billing?.budgetUsed?.perHour?.used ?? 0, budgets!.perHour!)}
                label="Per Hour"
              ></ic-metric-gauge>
            ` : nothing}
            ${budgets!.perDay !== undefined ? html`
              <ic-metric-gauge
                .value=${this._budgetPct(billing?.budgetUsed?.perDay?.used ?? 0, budgets!.perDay!)}
                label="Per Day"
              ></ic-metric-gauge>
            ` : nothing}
          </div>
        ` : html`
          <p class="budget-empty">No budget set</p>
        `}
      </div>
    `;
  }

  private _budgetPct(used: number, total: number): number {
    if (total <= 0) return 0;
    return Math.min(100, Math.round((used / total) * 100));
  }

  private _renderCircuitBreakerCard() {
    const cb = this._agent?.circuitBreaker;
    if (!cb) return nothing;

    const variant = CB_STATE_VARIANT[cb.state] ?? "default";

    return html`
      <div class="card">
        <h3 class="card-title">Circuit Breaker</h3>
        <div class="circuit-breaker">
          <div class="cb-row">
            <span class="cb-label">State:</span>
            <ic-tag variant=${variant}>${cb.state}</ic-tag>
          </div>
          <div class="cb-row">
            <span class="cb-label">Failures:</span>
            <span>${cb.failures}</span>
          </div>
          ${cb.threshold !== undefined ? html`
            <div class="cb-row">
              <span class="cb-label">Threshold:</span>
              <span>${cb.threshold}</span>
            </div>
          ` : nothing}
          ${cb.resetTimeoutMs !== undefined ? html`
            <div class="cb-row">
              <span class="cb-label">Reset:</span>
              <span>${formatNumber(cb.resetTimeoutMs)}ms</span>
            </div>
          ` : nothing}
        </div>
      </div>
    `;
  }

  private _renderSkillsCard() {
    const skills = this._skills;
    const count = skills.length;

    return html`
      <div class="card">
        <h3 class="card-title">Skills (${count})</h3>
        ${count > 0
          ? html`
              <div class="skill-chips">
                ${skills.map((s) => {
                  const sourceLabel = s.source === "bundled" ? "built-in"
                    : s.source === "local" ? "prompt"
                    : s.source === "workspace" ? "mcp"
                    : "built-in";
                  const variant = s.source === "bundled" ? "info"
                    : s.source === "local" ? "success"
                    : "warning";
                  return html`<ic-tag variant=${variant} title=${s.description || s.name}>${s.name} (${sourceLabel})</ic-tag>`;
                })}
              </div>
            `
          : html`<p class="muted">No skills configured</p>`}
      </div>
    `;
  }

  private _renderHeartbeatCard() {
    const hb = this._heartbeatState;
    if (!hb) return nothing;

    const now = Date.now();
    const inBackoff = hb.backoffUntilMs > now;
    const hasErrors = hb.consecutiveErrors > 0;
    const isRunning = hb.tickStartedAtMs > 0;

    let statusLabel: string;
    let statusVariant: string;
    if (!hb.enabled) {
      statusLabel = "disabled";
      statusVariant = "default";
    } else if (inBackoff) {
      statusLabel = "backoff";
      statusVariant = "warning";
    } else if (hasErrors) {
      statusLabel = "error";
      statusVariant = "error";
    } else {
      statusLabel = "healthy";
      statusVariant = "success";
    }

    return html`
      <div class="card">
        <h3 class="card-title">Heartbeat</h3>
        <div class="heartbeat-info">
          <div class="hb-row">
            <span class="hb-label">Status:</span>
            <ic-tag variant=${statusVariant}>${statusLabel}</ic-tag>
            ${isRunning ? html`<span class="hb-running">running...</span>` : nothing}
          </div>
          <div class="hb-row">
            <span class="hb-label">Interval:</span>
            <span>${this._formatInterval(hb.intervalMs)}</span>
          </div>
          ${hb.lastRunMs > 0 ? html`
            <div class="hb-row">
              <span class="hb-label">Last run:</span>
              <ic-relative-time .timestamp=${hb.lastRunMs}></ic-relative-time>
            </div>
          ` : nothing}
          ${hb.nextDueMs > 0 ? html`
            <div class="hb-row">
              <span class="hb-label">Next due:</span>
              <ic-relative-time .timestamp=${hb.nextDueMs}></ic-relative-time>
            </div>
          ` : nothing}
          ${hasErrors ? html`
            <div class="hb-row">
              <span class="hb-label">Errors:</span>
              <span>${hb.consecutiveErrors} consecutive${hb.lastErrorKind ? ` (${hb.lastErrorKind})` : ""}</span>
            </div>
          ` : nothing}
        </div>
      </div>
    `;
  }

  private _formatInterval(ms: number): string {
    if (ms >= 3_600_000) return `Every ${Math.round(ms / 3_600_000)}h`;
    if (ms >= 60_000) return `Every ${Math.round(ms / 60_000)}m`;
    return `Every ${Math.round(ms / 1000)}s`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-agent-detail": IcAgentDetail;
  }
}
