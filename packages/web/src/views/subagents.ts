// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { ApiClient } from "../api/api-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { SseController } from "../state/sse-controller.js";
import { IcToast } from "../components/feedback/ic-toast.js";
import type { SubAgentRunDto } from "../api/types/agent-types.js";

// Side-effect imports for sub-components
import "../components/feedback/ic-loading.js";
import "../components/feedback/ic-empty-state.js";
import "../components/feedback/ic-confirm-dialog.js";
import "../components/data/ic-tag.js";
import "../components/data/ic-relative-time.js";
import "../components/shell/ic-skeleton-view.js";

type LoadState = "loading" | "loaded" | "error";

/**
 * Sub-agent management view.
 *
 * Displays a list of recent sub-agent runs with status badges, token/cost
 * usage, and a kill action for running/queued agents. SSE lifecycle events
 * trigger automatic list refresh via debounced reload.
 *
 * Fires no external events -- all actions are handled via RPC.
 */
@customElement("ic-subagents-view")
export class IcSubagentsView extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .run-list {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm);
      }

      .run-card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
      }

      .run-header {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        margin-bottom: var(--ic-space-xs);
        flex-wrap: wrap;
      }

      .run-agent-id {
        font-weight: 600;
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
      }

      .run-task {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        margin-bottom: var(--ic-space-xs);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100%;
      }

      .run-meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--ic-space-sm) var(--ic-space-md);
        font-size: 0.75rem;
        color: var(--ic-text-dim);
        margin-top: var(--ic-space-xs);
      }

      .run-meta-item {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .run-meta-label {
        color: var(--ic-text-dim);
      }

      .run-meta-value {
        color: var(--ic-text-muted);
        font-variant-numeric: tabular-nums;
      }

      .run-error {
        margin-top: var(--ic-space-xs);
        padding: var(--ic-space-xs) var(--ic-space-sm);
        background: rgba(248, 113, 113, 0.1);
        border-radius: var(--ic-radius-sm);
        font-size: 0.75rem;
        color: var(--ic-error);
      }

      .run-actions {
        margin-top: var(--ic-space-sm);
        display: flex;
        gap: var(--ic-space-sm);
      }

      .kill-btn {
        padding: 4px 12px;
        font-size: 0.75rem;
        font-weight: 500;
        border: 1px solid var(--ic-error);
        border-radius: var(--ic-radius-sm);
        background: transparent;
        color: var(--ic-error);
        cursor: pointer;
        font-family: inherit;
        transition: background var(--ic-transition), color var(--ic-transition);
      }

      .kill-btn:hover {
        background: var(--ic-error);
        color: white;
      }

      .error-message {
        text-align: center;
        padding: 2rem;
        color: var(--ic-text-dim);
      }

      .retry-btn {
        margin-top: var(--ic-space-sm);
        padding: 6px 16px;
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-sm);
        cursor: pointer;
        font-family: inherit;
        font-size: var(--ic-text-sm);
      }

      .retry-btn:hover {
        background: var(--ic-accent-hover);
      }
    `,
  ];

  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property({ attribute: false }) apiClient: ApiClient | null = null;
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  @state() private _loadState: LoadState = "loading";
  @state() private _runs: SubAgentRunDto[] = [];
  @state() private _confirmKillRunId: string | null = null;

  private _sse: SseController | null = null;
  private _reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  private _rpcStatusUnsub: (() => void) | null = null;

  /* ---- Lifecycle ---- */

  override connectedCallback(): void {
    super.connectedCallback();
    this._initSse();
  }

  private _initSse(): void {
    if (!this.eventDispatcher || this._sse) return;
    const handler = (): void => { this._scheduleReload(); };
    this._sse = new SseController(this, this.eventDispatcher, {
      "session:sub_agent_spawned": handler,
      "session:sub_agent_completed": handler,
      "session:sub_agent_archived": handler,
      "session:sub_agent_spawn_rejected": handler,
      "session:sub_agent_spawn_started": handler,
      "session:sub_agent_spawn_queued": handler,
      "session:sub_agent_lifecycle_ended": handler,
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
      void this._loadData();
    } else {
      this._rpcStatusUnsub = this.rpcClient.onStatusChange((status) => {
        if (status === "connected") {
          void this._loadData();
        }
      });
    }
  }

  private async _loadData(): Promise<void> {
    if (!this.rpcClient) return;
    try {
      const resp = await this.rpcClient.call("subagent.list", { recentMinutes: 60 }) as {
        runs: SubAgentRunDto[];
        total: number;
      };
      this._runs = resp.runs ?? [];
      this._loadState = "loaded";
    } catch {
      this._loadState = "error";
    }
  }

  /* ---- Actions ---- */

  private _requestKill(runId: string): void {
    this._confirmKillRunId = runId;
  }

  private async _confirmKill(): Promise<void> {
    const runId = this._confirmKillRunId;
    this._confirmKillRunId = null;
    if (!runId || !this.rpcClient) return;
    try {
      await this.rpcClient.call("subagent.kill", { target: runId });
      IcToast.show("Sub-agent kill signal sent", "success");
      void this._loadData();
    } catch {
      IcToast.show("Failed to kill sub-agent", "error");
    }
  }

  private _cancelKill(): void {
    this._confirmKillRunId = null;
  }

  /* ---- Render helpers ---- */

  private _truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) + "\u2026" : text;
  }

  private _statusColor(status: string): string {
    switch (status) {
      case "running": return "blue";
      case "completed": return "green";
      case "failed": return "red";
      case "queued": return "yellow";
      default: return "default";
    }
  }

  private _formatDuration(start: number, end: number): string {
    const ms = end - start;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  }

  private _renderRun(run: SubAgentRunDto) {
    const canKill = run.status === "running" || run.status === "queued";

    return html`
      <div class="run-card">
        <div class="run-header">
          <ic-tag color=${this._statusColor(run.status)}>${run.status}</ic-tag>
          <span class="run-agent-id">${run.agentId}</span>
        </div>
        <div class="run-task" title=${run.task}>${this._truncate(run.task, 80)}</div>
        <div class="run-meta">
          <span class="run-meta-item">
            <span class="run-meta-label">Started:</span>
            <ic-relative-time .timestamp=${run.startedAt}></ic-relative-time>
          </span>
          ${run.completedAt ? html`
            <span class="run-meta-item">
              <span class="run-meta-label">Duration:</span>
              <span class="run-meta-value">${this._formatDuration(run.startedAt, run.completedAt)}</span>
            </span>
          ` : nothing}
          <span class="run-meta-item">
            <span class="run-meta-label">Depth:</span>
            <span class="run-meta-value">${run.depth}</span>
          </span>
          ${run.result ? html`
            <span class="run-meta-item">
              <span class="run-meta-label">Tokens:</span>
              <span class="run-meta-value">${run.result.tokensUsed.total.toLocaleString()}</span>
            </span>
            <span class="run-meta-item">
              <span class="run-meta-label">Cost:</span>
              <span class="run-meta-value">$${run.result.cost.total.toFixed(4)}</span>
            </span>
            <span class="run-meta-item">
              <span class="run-meta-label">Steps:</span>
              <span class="run-meta-value">${run.result.stepsExecuted}</span>
            </span>
          ` : nothing}
        </div>
        ${run.error ? html`
          <div class="run-error">${run.error}</div>
        ` : nothing}
        ${canKill ? html`
          <div class="run-actions">
            <button class="kill-btn" @click=${() => this._requestKill(run.runId)}>Kill</button>
          </div>
        ` : nothing}
      </div>
    `;
  }

  override render() {
    return html`
      ${this._loadState === "loading" ? html`
        <ic-skeleton-view variant="dashboard"></ic-skeleton-view>
      ` : this._loadState === "error" ? html`
        <div class="error-message">
          Failed to load sub-agent data
          <br />
          <button class="retry-btn" @click=${() => void this._loadData()}>Retry</button>
        </div>
      ` : this._runs.length === 0 ? html`
        <ic-empty-state message="No sub-agent runs in the last 60 minutes"></ic-empty-state>
      ` : html`
        <div class="run-list">
          ${this._runs.map((run) => this._renderRun(run))}
        </div>
      `}

      <ic-confirm-dialog
        ?open=${this._confirmKillRunId !== null}
        title="Kill Sub-Agent"
        message="This will terminate the running sub-agent. The parent session will receive an error result."
        confirmLabel="Kill"
        variant="danger"
        @confirm=${this._confirmKill}
        @cancel=${this._cancelKill}
      ></ic-confirm-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-subagents-view": IcSubagentsView;
  }
}
