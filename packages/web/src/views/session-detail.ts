// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { ApiClient } from "../api/api-client.js";
import type { RpcClient } from "../api/rpc-client.js";
import type {
  SessionInfo,
  SessionMessage,
  PipelineSnapshot,
  DagCompactionSnapshot,
} from "../api/types/index.js";
import { IcToast } from "../components/feedback/ic-toast.js";
import {
  parseSessionKeyString,
  formatSessionDisplayName,
  computeSessionStatus,
} from "../utils/session-key-parser.js";
import { cleanMessageContent } from "../utils/message-content.js";
import type { BudgetSegment } from "../components/data/ic-budget-segment-bar.js";
import type { WaterfallLayer } from "../components/data/ic-layer-waterfall.js";

// Side-effect imports to register child custom elements
import "../components/nav/ic-breadcrumb.js";
import "../components/data/ic-tag.js";
import "../components/data/ic-stat-card.js";
import "../components/data/ic-relative-time.js";
import "../components/data/ic-budget-segment-bar.js";
import "../components/data/ic-layer-waterfall.js";
import "../components/domain/ic-chat-message.js";
import "../components/domain/ic-tool-call.js";
import "../components/feedback/ic-loading.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/feedback/ic-confirm-dialog.js";
import "../components/feedback/ic-toast.js";
import "../components/feedback/ic-empty-state.js";

/** Active tab in the session detail view. */
type SessionTab = "conversation" | "context" | "metrics";

/**
 * Format a token count with K suffix for readability.
 */
function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
  }
  return String(tokens);
}

/**
 * Format a cost value as USD currency.
 */
function formatCost(cost: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cost);
}

/**
 * Session detail view showing conversation, context state, and metrics
 * in a 3-tab layout.
 *
 * Route: `#/sessions/:key`
 *
 * Features:
 * - Breadcrumb navigation back to session list
 * - Session info bar (agent, channel, messages, tokens)
 * - Action buttons: reset, compact, export, delete
 * - **Conversation tab:** Messages with ic-chat-message, expandable ic-tool-call cards,
 *   and compaction markers at context compaction boundaries
 * - **Context State tab:** Token budget segment bar, per-execution pipeline waterfall,
 *   lazy-loaded on first activation
 * - **Metrics tab:** Session-level cost, tokens, tool calls, health stats,
 *   lazy-loaded billing data on first activation
 * - Confirmation dialogs for destructive actions
 */
@customElement("ic-session-detail")
export class IcSessionDetail extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .breadcrumb-area {
        margin-bottom: var(--ic-space-md);
      }

      .session-info {
        display: flex;
        align-items: center;
        gap: var(--ic-space-lg);
        flex-wrap: wrap;
        padding: var(--ic-space-md) var(--ic-space-lg);
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg);
        margin-bottom: var(--ic-space-md);
      }

      .info-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .info-label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .info-value {
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        font-weight: 500;
      }

      .actions-bar {
        display: flex;
        gap: var(--ic-space-sm);
        margin-bottom: var(--ic-space-md);
        flex-wrap: wrap;
      }

      .btn {
        padding: var(--ic-space-xs) var(--ic-space-md);
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        transition: background var(--ic-transition),
          border-color var(--ic-transition);
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

      /* Tab bar */
      .tab-bar {
        display: flex;
        gap: 0;
        border-bottom: 1px solid var(--ic-border);
        margin-bottom: var(--ic-space-lg);
      }

      .tab {
        padding: var(--ic-space-sm) var(--ic-space-lg);
        background: transparent;
        border: none;
        border-bottom: 2px solid transparent;
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        font-weight: 500;
        cursor: pointer;
        transition: color var(--ic-transition),
          border-color var(--ic-transition);
      }

      .tab:hover {
        color: var(--ic-text);
      }

      .tab--active {
        color: var(--ic-accent);
        border-bottom-color: var(--ic-accent);
      }

      /* Tab content sections */
      .tab-content {
        display: none;
      }

      .tab-content--active {
        display: block;
      }

      /* Conversation */
      .conversation {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-md);
        max-height: 60vh;
        overflow-y: auto;
        padding: var(--ic-space-md);
        background: var(--ic-bg);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg);
      }

      /* Compaction marker */
      .compaction-marker {
        display: flex;
        align-items: center;
        gap: var(--ic-space-md);
        padding: var(--ic-space-xs) 0;
      }

      .compaction-marker hr {
        flex: 1;
        border: none;
        border-top: 1px dashed var(--ic-border);
        margin: 0;
      }

      .compaction-marker span {
        color: var(--ic-text-dim);
        font-size: var(--ic-text-xs);
        font-style: italic;
        white-space: nowrap;
      }

      /* Context State tab */
      .context-summary {
        display: flex;
        gap: var(--ic-space-md);
        flex-wrap: wrap;
        margin-bottom: var(--ic-space-md);
      }

      .context-badge {
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

      .context-badge .badge-value {
        font-weight: 600;
        color: var(--ic-text);
        font-family: var(--ic-font-mono, ui-monospace, monospace);
      }

      .cache-badge {
        padding: 2px var(--ic-space-sm);
        border-radius: var(--ic-radius-sm);
        font-size: var(--ic-text-xs);
        font-weight: 600;
      }

      .cache-badge--hit {
        background: color-mix(in srgb, var(--ic-success) 20%, transparent);
        color: var(--ic-success);
      }

      .cache-badge--miss {
        background: color-mix(in srgb, var(--ic-warning) 20%, transparent);
        color: var(--ic-warning);
      }

      .budget-section {
        margin-bottom: var(--ic-space-lg);
      }

      .budget-section-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text);
        margin-bottom: var(--ic-space-sm);
      }

      /* Execution list */
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
        width: 100%;
        color: inherit;
        font-family: inherit;
        text-align: left;
      }

      .execution-row:hover {
        background: var(--ic-surface-2, #1f2937);
      }

      .execution-row.selected {
        border-color: var(--ic-accent);
        background: rgba(59, 130, 246, 0.1);
      }

      .exec-time {
        color: var(--ic-text-dim);
        min-width: 6rem;
      }

      .exec-duration {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        color: var(--ic-text-dim);
      }

      .exec-tokens {
        color: var(--ic-text-dim);
        flex: 1;
      }

      .waterfall-card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-lg);
      }

      /* Metrics tab */
      .metrics-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
        gap: var(--ic-space-md);
        margin-bottom: var(--ic-space-lg);
      }

      .metrics-section-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: var(--ic-space-sm);
      }

      .status-badge {
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs);
        padding: 2px var(--ic-space-sm);
        border-radius: var(--ic-radius-sm);
        font-size: var(--ic-text-xs);
        font-weight: 600;
      }

      .status-badge--active {
        background: color-mix(in srgb, var(--ic-success) 20%, transparent);
        color: var(--ic-success);
      }

      .status-badge--idle {
        background: color-mix(in srgb, var(--ic-warning) 20%, transparent);
        color: var(--ic-warning);
      }

      .status-badge--expired {
        background: color-mix(in srgb, var(--ic-text-dim) 20%, transparent);
        color: var(--ic-text-dim);
      }

      /* Loading & error */
      .loading-container {
        display: flex;
        justify-content: center;
        padding: var(--ic-space-2xl);
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
    `,
  ];

  /** API client for data fetching and actions. */
  @property({ attribute: false }) apiClient: ApiClient | null = null;

  /** RPC client for obs.context.pipeline and billing RPC calls. */
  @property({ attribute: false }) rpcClient: RpcClient | null = null;

  /** Session key from route params. */
  @property() sessionKey = "";

  @state() private _session: SessionInfo | null = null;
  @state() private _messages: SessionMessage[] = [];
  @state() private _loading = false;
  @state() private _error = "";
  @state() private _showConfirm = false;
  @state() private _confirmAction = "";

  // Tab state
  @state() private _activeTab: SessionTab = "conversation";
  @state() private _contextLoaded = false;
  @state() private _metricsLoaded = false;
  @state() private _pipelineSnapshots: PipelineSnapshot[] = [];
  @state() private _dagCompactions: DagCompactionSnapshot[] = [];
  @state() private _selectedSnapshot: PipelineSnapshot | null = null;

  // Metrics state
  @state() private _sessionBilling: {
    totalTokens: number;
    totalCost: number;
    callCount: number;
  } | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // Note: _loadSession() is NOT called here -- apiClient is typically
    // null at this point. The updated() callback handles loading once
    // the client property is set.
  }

  override updated(changed: Map<string, unknown>): void {
    if (
      (changed.has("apiClient") || changed.has("sessionKey")) &&
      this.apiClient &&
      this.sessionKey
    ) {
      this._loadSession();
    }
  }

  private async _loadSession(): Promise<void> {
    if (!this.apiClient || !this.sessionKey) return;
    this._loading = true;
    this._error = "";
    try {
      const result = await this.apiClient.getSessionDetail(this.sessionKey);
      this._session = result.session;
      this._messages = result.messages;
    } catch {
      this._error = "Failed to load session. Please try again.";
    } finally {
      this._loading = false;
    }
  }

  /* ---- Tab switching ---- */

  private _switchTab(tab: SessionTab): void {
    this._activeTab = tab;
    if (tab === "context" && !this._contextLoaded) {
      this._loadContextData();
    }
    if (tab === "metrics" && !this._metricsLoaded) {
      this._loadMetricsData();
    }
  }

  /* ---- Context State data loading ---- */

  private async _loadContextData(): Promise<void> {
    if (!this.rpcClient || !this._session) return;

    try {
      const agentId = this._session.agentId;
      const [pipelineResult, dagResult] = await Promise.all([
        this.rpcClient.call<PipelineSnapshot[]>("obs.context.pipeline", {
          agentId,
          limit: 100,
        }),
        this.rpcClient.call<DagCompactionSnapshot[]>("obs.context.dag", {
          agentId,
          limit: 50,
        }),
      ]);

      // Client-side filter by sessionKey
      const snapshots = Array.isArray(pipelineResult) ? pipelineResult : [];
      this._pipelineSnapshots = snapshots.filter(
        (s) => s.sessionKey === this.sessionKey,
      );

      const dags = Array.isArray(dagResult) ? dagResult : [];
      this._dagCompactions = dags.filter(
        (d) => d.sessionKey === this.sessionKey,
      );

      // Auto-select latest
      if (this._pipelineSnapshots.length > 0) {
        this._selectedSnapshot = this._pipelineSnapshots[0]!;
      }

      this._contextLoaded = true;
    } catch {
      // Silently fail -- empty state shown
      this._contextLoaded = true;
    }
  }

  /* ---- Metrics data loading ---- */

  private async _loadMetricsData(): Promise<void> {
    if (!this.rpcClient) {
      this._metricsLoaded = true;
      return;
    }

    try {
      const result = await this.rpcClient.call<{
        totalTokens: number;
        totalCost: number;
        callCount: number;
      }>("obs.billing.bySession", { sessionKey: this.sessionKey });
      this._sessionBilling = result ?? null;
    } catch {
      // Billing data optional, graceful fallback
      this._sessionBilling = null;
    }
    this._metricsLoaded = true;
  }

  /* ---- Navigation & actions ---- */

  private _handleBreadcrumbNavigate(e: CustomEvent<string>): void {
    window.location.hash = `#/${e.detail}`;
  }

  private _showActionConfirm(action: string): void {
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
        await this.apiClient.resetSession(this.sessionKey);
        IcToast.show("Session reset", "success");
        await this._loadSession();
      } else if (this._confirmAction === "compact") {
        await this.apiClient.compactSession(this.sessionKey);
        IcToast.show("Session compacted", "success");
        await this._loadSession();
      } else if (this._confirmAction === "delete") {
        await this.apiClient.deleteSession(this.sessionKey);
        IcToast.show("Session deleted", "success");
        window.location.hash = "#/sessions";
      }
    } catch {
      IcToast.show("Operation failed. Please try again.", "error");
    }
    this._confirmAction = "";
  }

  private async _handleExport(): Promise<void> {
    if (!this.apiClient) return;

    try {
      const data = await this.apiClient.exportSession(this.sessionKey);
      const blob = new Blob([data], { type: "application/jsonl" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `session-${this.sessionKey}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
      IcToast.show("Session exported", "success");
    } catch {
      IcToast.show("Export failed. Please try again.", "error");
    }
  }

  /* ---- Helpers ---- */

  private _truncateKey(key: string): string {
    if (key.length > 20) return key.slice(0, 16) + "...";
    return key;
  }

  private _getBreadcrumbLabel(): string {
    const parsed = parseSessionKeyString(this.sessionKey);
    if (parsed) return formatSessionDisplayName(parsed);
    return this._truncateKey(this.sessionKey);
  }

  private _isCompactionBoundary(msg: SessionMessage): boolean {
    if (msg.role !== "system") return false;
    const lower = msg.content.toLowerCase();
    return (
      lower.includes("compacted") ||
      lower.includes("summary") ||
      lower.includes("[compacted]")
    );
  }

  private _getConfirmProps(): {
    title: string;
    message: string;
    variant: string;
    label: string;
  } {
    switch (this._confirmAction) {
      case "delete":
        return {
          title: "Delete Session",
          message:
            "Are you sure you want to delete this session? This action cannot be undone.",
          variant: "danger",
          label: "Delete",
        };
      case "compact":
        return {
          title: "Compact Session",
          message:
            "Are you sure you want to compact this session? Older messages will be summarized.",
          variant: "default",
          label: "Compact",
        };
      default:
        return {
          title: "Reset Session",
          message:
            "Are you sure you want to reset this session? All conversation history will be cleared.",
          variant: "default",
          label: "Reset",
        };
    }
  }

  /* ---- Render: Conversation tab ---- */

  private _renderConversation() {
    return html`
      <div class="conversation">
        ${this._messages.map((msg) => {
          // Compaction marker
          if (this._isCompactionBoundary(msg)) {
            return html`
              <div class="compaction-marker" data-testid="compaction-marker">
                <hr />
                <span>Context was compacted here</span>
                <hr />
              </div>
            `;
          }

          // Tool call card
          if (msg.role === "tool") {
            let parsedOutput: unknown = msg.content;
            try {
              parsedOutput = JSON.parse(msg.content);
            } catch {
              // Use raw content
            }
            return html`
              <ic-tool-call
                .toolName=${msg.toolName ?? "tool"}
                .output=${parsedOutput}
                .status=${"success"}
                .expanded=${false}
              ></ic-tool-call>
            `;
          }

          // User/Assistant/System messages via ic-chat-message
          return html`
            <ic-chat-message
              .role=${msg.role}
              .content=${cleanMessageContent(msg.content, msg.role)}
              .timestamp=${msg.timestamp}
              .showActions=${false}
            ></ic-chat-message>
          `;
        })}
      </div>
    `;
  }

  /* ---- Render: Context State tab ---- */

  private _renderContextState() {
    if (!this._contextLoaded) {
      return html`<div class="loading-container"><ic-loading size="md"></ic-loading></div>`;
    }

    if (this._pipelineSnapshots.length === 0) {
      return html`<ic-empty-state
        icon="activity"
        message="No pipeline data for this session"
      ></ic-empty-state>`;
    }

    const latest = this._pipelineSnapshots[0]!;

    // Budget segments
    const system = Math.max(
      0,
      latest.tokensLoaded - latest.tokensEvicted,
    );
    const segments: BudgetSegment[] = [
      { label: "System", tokens: system, color: "var(--ic-accent)" },
      { label: "Evicted", tokens: latest.tokensEvicted, color: "var(--ic-error)" },
      { label: "Masked", tokens: latest.tokensMasked, color: "var(--ic-warning)" },
      {
        label: "Available",
        tokens: Math.max(
          0,
          Math.round((1 - latest.budgetUtilization) * (system + latest.tokensEvicted + latest.tokensMasked)),
        ),
        color: "var(--ic-surface-2, #1f2937)",
      },
    ].filter((s) => s.tokens > 0);

    return html`
      <!-- Latest snapshot summary -->
      <div class="context-summary">
        <div class="context-badge">
          Budget <span class="badge-value">${Math.round(latest.budgetUtilization * 100)}%</span>
        </div>
        <span class="cache-badge ${latest.cacheHitTokens > 0 ? "cache-badge--hit" : "cache-badge--miss"}">
          ${latest.cacheHitTokens > 0 ? "Cache HIT" : "Cache MISS"}
        </span>
        <div class="context-badge">
          Loaded <span class="badge-value">${formatTokens(latest.tokensLoaded)}</span>
        </div>
        <div class="context-badge">
          Evicted <span class="badge-value">${formatTokens(latest.tokensEvicted)}</span>
        </div>
        <div class="context-badge">
          Duration <span class="badge-value">${latest.durationMs}ms</span>
        </div>
      </div>

      <!-- Budget segment bar -->
      <div class="budget-section">
        <div class="budget-section-title">Token Budget</div>
        <ic-budget-segment-bar .segments=${segments}></ic-budget-segment-bar>
      </div>

      <!-- Execution list -->
      <div class="budget-section-title">Pipeline Executions</div>
      <div class="execution-list">
        ${this._pipelineSnapshots.map(
          (snap) => html`
            <button
              class="execution-row ${this._selectedSnapshot === snap ? "selected" : ""}"
              @click=${() => {
                this._selectedSnapshot = snap;
              }}
            >
              <span class="exec-time">${new Date(snap.timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <span class="exec-duration">${snap.durationMs}ms</span>
              <span class="cache-badge ${snap.cacheHitTokens > 0 ? "cache-badge--hit" : "cache-badge--miss"}">
                ${snap.cacheHitTokens > 0 ? "HIT" : "MISS"}
              </span>
              <span class="exec-tokens">${formatTokens(snap.tokensLoaded)} loaded</span>
            </button>
          `,
        )}
      </div>

      <!-- Waterfall for selected snapshot -->
      ${this._selectedSnapshot && this._selectedSnapshot.layers.length > 0
        ? html`
            <div class="waterfall-card">
              <ic-layer-waterfall
                .layers=${this._selectedSnapshot.layers.map(
                  (l): WaterfallLayer => ({
                    name: l.name,
                    durationMs: l.durationMs,
                    messagesIn: l.messagesIn,
                    messagesOut: l.messagesOut,
                  }),
                )}
                .totalDurationMs=${this._selectedSnapshot.durationMs}
              ></ic-layer-waterfall>
            </div>
          `
        : nothing}
    `;
  }

  /* ---- Render: Metrics tab ---- */

  private _renderMetrics() {
    if (!this._session) return nothing;

    const session = this._session;
    const status = computeSessionStatus(session.lastActiveAt);

    return html`
      <!-- Cost & Usage -->
      <div class="metrics-section-title">Cost & Usage</div>
      <div class="metrics-grid">
        <ic-stat-card
          label="Total Cost"
          value=${this._sessionBilling ? formatCost(this._sessionBilling.totalCost) : "--"}
        ></ic-stat-card>
        <ic-stat-card
          label="Total Tokens"
          value=${formatTokens(session.totalTokens)}
        ></ic-stat-card>
        <ic-stat-card
          label="Input Tokens"
          value=${formatTokens(session.inputTokens)}
        ></ic-stat-card>
        <ic-stat-card
          label="Output Tokens"
          value=${formatTokens(session.outputTokens)}
        ></ic-stat-card>
      </div>

      <!-- Activity -->
      <div class="metrics-section-title">Activity</div>
      <div class="metrics-grid">
        <ic-stat-card
          label="Tool Calls"
          value=${String(session.toolCalls)}
        ></ic-stat-card>
        <ic-stat-card
          label="Compactions"
          value=${String(session.compactions)}
        ></ic-stat-card>
        <ic-stat-card
          label="Resets"
          value=${String(session.resetCount)}
        ></ic-stat-card>
        <ic-stat-card
          label="API Calls"
          value=${this._sessionBilling ? String(this._sessionBilling.callCount) : "--"}
        ></ic-stat-card>
      </div>

      <!-- Session Health -->
      <div class="metrics-section-title">Session Health</div>
      <div class="metrics-grid">
        <ic-stat-card
          label="Created"
          value=${new Date(session.createdAt).toLocaleDateString()}
        ></ic-stat-card>
        <ic-stat-card
          label="Last Active"
          value=${new Date(session.lastActiveAt).toLocaleString()}
        ></ic-stat-card>
        <ic-stat-card label="Status" .value=${""}>
        </ic-stat-card>
      </div>
      <div style="margin-top: calc(-1 * var(--ic-space-md));">
        <span class="status-badge status-badge--${status}" data-testid="session-status">${status}</span>
      </div>
    `;
  }

  /* ---- Main render ---- */

  override render() {
    const breadcrumbItems = [
      { label: "Sessions", route: "sessions" },
      { label: this._getBreadcrumbLabel() },
    ];

    if (this._loading) {
      return html`
        <div class="breadcrumb-area">
          <ic-breadcrumb
            .items=${breadcrumbItems}
            @navigate=${this._handleBreadcrumbNavigate}
          ></ic-breadcrumb>
        </div>
        <ic-skeleton-view variant="detail"></ic-skeleton-view>
      `;
    }

    if (this._error) {
      return html`
        <div class="breadcrumb-area">
          <ic-breadcrumb
            .items=${breadcrumbItems}
            @navigate=${this._handleBreadcrumbNavigate}
          ></ic-breadcrumb>
        </div>
        <div class="error-container">
          <div class="error-message">${this._error}</div>
          <button class="retry-btn" @click=${() => this._loadSession()}>
            Retry
          </button>
        </div>
      `;
    }

    if (!this._session) {
      return html`
        <div class="breadcrumb-area">
          <ic-breadcrumb
            .items=${breadcrumbItems}
            @navigate=${this._handleBreadcrumbNavigate}
          ></ic-breadcrumb>
        </div>
        <div class="error-container">
          <div class="error-message">Session not found</div>
        </div>
      `;
    }

    const session = this._session;
    const confirmProps = this._getConfirmProps();

    return html`
      <div class="breadcrumb-area">
        <ic-breadcrumb
          .items=${breadcrumbItems}
          @navigate=${this._handleBreadcrumbNavigate}
        ></ic-breadcrumb>
      </div>

      <div class="session-info">
        <div class="info-item">
          <span class="info-label">Agent</span>
          <span class="info-value">${session.agentId}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Channel</span>
          <span class="info-value"
            ><ic-tag variant=${session.channelType}
              >${session.channelType}</ic-tag
            ></span
          >
        </div>
        <div class="info-item">
          <span class="info-label">Messages</span>
          <span class="info-value">${session.messageCount}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Tokens</span>
          <span class="info-value">${formatTokens(session.totalTokens)}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Created</span>
          <span class="info-value"
            >${new Date(session.createdAt).toLocaleDateString()}</span
          >
        </div>
        ${session.label
          ? html`
              <div class="info-item">
                <span class="info-label">Label</span>
                <span class="info-value">${session.label}</span>
              </div>
            `
          : nothing}
      </div>

      <div class="actions-bar">
        <button
          class="btn btn-ghost"
          @click=${() => this._showActionConfirm("reset")}
        >
          Reset
        </button>
        <button
          class="btn btn-ghost"
          @click=${() => this._showActionConfirm("compact")}
        >
          Compact
        </button>
        <button class="btn btn-ghost" @click=${this._handleExport}>
          Export JSONL
        </button>
        <button
          class="btn btn-danger"
          @click=${() => this._showActionConfirm("delete")}
        >
          Delete
        </button>
      </div>

      <!-- Tab bar -->
      <div class="tab-bar" role="tablist">
        <button
          class="tab ${this._activeTab === "conversation" ? "tab--active" : ""}"
          role="tab"
          aria-selected=${this._activeTab === "conversation"}
          @click=${() => this._switchTab("conversation")}
        >
          Conversation
        </button>
        <button
          class="tab ${this._activeTab === "context" ? "tab--active" : ""}"
          role="tab"
          aria-selected=${this._activeTab === "context"}
          @click=${() => this._switchTab("context")}
        >
          Context State
        </button>
        <button
          class="tab ${this._activeTab === "metrics" ? "tab--active" : ""}"
          role="tab"
          aria-selected=${this._activeTab === "metrics"}
          @click=${() => this._switchTab("metrics")}
        >
          Metrics
        </button>
      </div>

      <!-- Tab content: use display:none to preserve scroll position -->
      <div
        class="tab-content ${this._activeTab === "conversation" ? "tab-content--active" : ""}"
      >
        ${this._renderConversation()}
      </div>
      <div
        class="tab-content ${this._activeTab === "context" ? "tab-content--active" : ""}"
      >
        ${this._renderContextState()}
      </div>
      <div
        class="tab-content ${this._activeTab === "metrics" ? "tab-content--active" : ""}"
      >
        ${this._renderMetrics()}
      </div>

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
    "ic-session-detail": IcSessionDetail;
  }
}
