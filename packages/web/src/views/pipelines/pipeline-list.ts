import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { RpcClient } from "../../api/rpc-client.js";
import type { PipelineListEntry, PipelineNode, SavedGraphSummary } from "../../api/types/index.js";
import { IcToast } from "../../components/feedback/ic-toast.js";
import "../../components/nav/ic-breadcrumb.js";
import type { BreadcrumbItem } from "../../components/nav/ic-breadcrumb.js";
import "../../components/feedback/ic-confirm-dialog.js";
import "../../components/graph/ic-variable-prompt.js";
import "../../components/feedback/ic-toast.js";
import "../../components/feedback/ic-empty-state.js";
import { extractVariables, substituteVariables } from "../../utils/extract-variables.js";
import "../../components/feedback/ic-loading.js";
import "../../components/shell/ic-skeleton-view.js";
import "../../components/display/ic-icon.js";

/** Status-to-color mapping for status dots. */
const STATUS_COLORS: Record<string, string> = {
  draft: "#6b7280",
  running: "#06b6d4",
  completed: "#22c55e",
  failed: "#ef4444",
  cancelled: "#f97316",
};

/**
 * Format an epoch-ms timestamp as a relative time string.
 * Produces output like "3m ago", "2h ago", "5d ago", or an ISO date for older entries.
 */
function formatRelativeTime(epochMs: number | undefined): string {
  if (!epochMs) return "Never";

  const diff = Date.now() - epochMs;
  if (diff < 0) return "just now";

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Pipeline list view showing all server-saved and executed graphs
 * in a unified searchable data table with row actions.
 *
 * Data sources: server-saved named graphs (graph.list RPC) and executed graphs
 * (graph.status RPC). Merges both into a PipelineListEntry array.
 *
 * @fires navigate - Dispatched when user clicks a row or action button, with route path as detail
 */
@customElement("ic-pipeline-list")
export class IcPipelineList extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .page-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--ic-space-lg, 1.5rem);
      }

      .page-title {
        font-size: var(--ic-text-2xl, 1.5rem);
        font-weight: 700;
        margin: 0;
      }

      .create-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs, 0.25rem);
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        background: var(--ic-accent, #3b82f6);
        color: #fff;
        border: none;
        border-radius: var(--ic-radius-md, 0.5rem);
        font-size: var(--ic-text-sm, 0.875rem);
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        transition: background var(--ic-transition, 150ms ease);
      }

      .create-btn:hover {
        background: var(--ic-accent-hover, #2563eb);
      }

      .history-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs, 0.25rem);
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        background: transparent;
        color: var(--ic-text-dim, #6b7280);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        font-size: var(--ic-text-sm, 0.875rem);
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        transition: color var(--ic-transition, 150ms ease),
          border-color var(--ic-transition, 150ms ease);
      }

      .history-btn:hover {
        color: var(--ic-text, #f3f4f6);
        border-color: var(--ic-text-dim, #6b7280);
      }

      /* Search bar */
      .search-bar {
        margin-bottom: var(--ic-space-md, 0.75rem);
      }

      .search-input {
        width: 100%;
        max-width: 320px;
        padding: 8px 12px;
        background: var(--ic-surface-2, #1f2937);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        color: var(--ic-text, #f3f4f6);
        font-size: var(--ic-text-sm, 0.875rem);
        font-family: inherit;
      }

      .search-input:focus {
        border-color: var(--ic-accent, #3b82f6);
        outline: none;
      }

      .search-input::placeholder {
        color: var(--ic-text-dim, #6b7280);
      }

      /* Grid-based table - 6 columns */
      .grid-table {
        display: grid;
        grid-template-columns: minmax(140px, 2fr) 70px 70px 110px 120px auto;
        width: 100%;
      }

      .grid-header {
        display: contents;
      }

      .grid-header .cell {
        font-size: var(--ic-text-xs, 0.75rem);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--ic-text-dim, #6b7280);
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        border-bottom: 1px solid var(--ic-border, #374151);
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
      }

      .grid-header .cell:hover {
        color: var(--ic-text-muted, #9ca3af);
      }

      .grid-header .cell.actions-header {
        cursor: default;
        text-align: right;
      }

      .grid-header .cell.actions-header:hover {
        color: var(--ic-text-dim, #6b7280);
      }

      .sort-arrow {
        display: inline-block;
        margin-left: 4px;
        font-size: 0.625rem;
        opacity: 0.5;
      }

      .sort-arrow--active {
        opacity: 1;
        color: var(--ic-accent, #3b82f6);
      }

      .grid-row {
        display: contents;
        cursor: pointer;
      }

      .grid-row .cell {
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        border-bottom: 1px solid var(--ic-border, #374151);
        font-size: var(--ic-text-sm, 0.875rem);
        display: flex;
        align-items: center;
        transition: background var(--ic-transition, 150ms ease);
      }

      .grid-row:hover .cell {
        background: var(--ic-surface-2, #1f2937);
      }

      .grid-row .cell.actions-cell {
        justify-content: flex-end;
        white-space: nowrap;
      }

      .pipeline-label {
        font-weight: 500;
        color: var(--ic-text, #f3f4f6);
      }

      .pipeline-label--draft {
        font-weight: 600;
      }

      /* Status dot */
      .status-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--dot-color, #6b7280);
        margin-right: 6px;
        vertical-align: middle;
        flex-shrink: 0;
      }

      .status-dot--running {
        animation: pulse 1.5s ease-in-out infinite;
      }

      @keyframes pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.4;
        }
      }

      .status-text {
        display: inline-flex;
        align-items: center;
      }

      /* Action buttons */
      .action-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        background: transparent;
        border: 1px solid transparent;
        border-radius: var(--ic-radius-sm, 0.25rem);
        color: var(--ic-text-dim, #6b7280);
        cursor: pointer;
        transition: background var(--ic-transition, 150ms ease),
          color var(--ic-transition, 150ms ease),
          border-color var(--ic-transition, 150ms ease);
      }

      .action-btn:hover {
        background: var(--ic-surface-2, #1f2937);
        color: var(--ic-text, #f3f4f6);
        border-color: var(--ic-border, #374151);
      }

      .action-btn--danger:hover {
        color: var(--ic-error, #f87171);
        border-color: var(--ic-error, #f87171);
      }

      .action-btn--run:hover {
        color: var(--ic-success, #22c55e);
        border-color: var(--ic-success, #22c55e);
      }

      .dim-text {
        color: var(--ic-text-dim, #6b7280);
      }

      /* Mobile responsive cards */
      .mobile-list {
        display: none;
      }

      @media (max-width: 767px) {
        .grid-table {
          display: none;
        }
        .mobile-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .mobile-card {
          background: var(--ic-surface, #111827);
          border: 1px solid var(--ic-border, #374151);
          border-radius: var(--ic-radius-md, 0.5rem);
          padding: 12px;
          cursor: pointer;
          transition: border-color var(--ic-transition, 150ms ease);
        }
        .mobile-card:hover {
          border-color: var(--ic-accent, #3b82f6);
        }
        .card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .card-label {
          font-weight: 600;
          font-size: var(--ic-text-sm, 0.875rem);
          color: var(--ic-text, #f3f4f6);
        }
        .card-meta {
          display: flex;
          gap: 12px;
          font-size: var(--ic-text-xs, 0.75rem);
          color: var(--ic-text-dim, #6b7280);
          margin-bottom: 8px;
        }
        .card-actions {
          display: flex;
          gap: 4px;
          justify-content: flex-end;
        }
      }

      .no-results {
        text-align: center;
        padding: var(--ic-space-xl, 2rem);
        color: var(--ic-text-dim, #6b7280);
        font-size: var(--ic-text-sm, 0.875rem);
      }
    `,
  ];

  @property({ attribute: false }) rpcClient: RpcClient | null = null;

  private _rpcStatusUnsub: (() => void) | null = null;

  @state() private _pipelines: PipelineListEntry[] = [];
  @state() private _searchQuery = "";
  @state() private _loading = true;
  @state() private _deleteTarget: PipelineListEntry | null = null;
  @state() private _sortKey = "savedAt";
  @state() private _sortAsc = false;
  @state() private _showVariablePrompt = false;
  @state() private _variableNames: string[] = [];
  @state() private _pendingExecuteData: {
    nodes: Array<{ nodeId: string; id?: string; task: string; agentId?: string; dependsOn: string[]; maxSteps?: number; timeoutMs?: number; barrierMode?: string }>;
    settings: { label: string; onFailure: string; timeoutMs?: number; budget?: { maxTokens?: number; maxCost?: number } };
  } | null = null;

  private get _breadcrumbs(): BreadcrumbItem[] {
    return [{ label: "Pipelines" }];
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // Note: _loadPipelines() is NOT called here -- rpcClient is typically
    // null or not yet connected at this point. The updated() callback
    // handles loading once rpcClient is set and connected.
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._rpcStatusUnsub?.();
    this._rpcStatusUnsub = null;
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("rpcClient") && this.rpcClient) {
      this._rpcStatusUnsub?.();
      if (this.rpcClient.status === "connected") {
        this._loadPipelines();
      } else {
        this._rpcStatusUnsub = this.rpcClient.onStatusChange((status) => {
          if (status === "connected") {
            this._rpcStatusUnsub = null;
            this._loadPipelines();
          }
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  private async _loadPipelines(): Promise<void> {
    this._loading = true;

    let savedEntries: PipelineListEntry[] = [];
    let executedEntries: PipelineListEntry[] = [];

    if (this.rpcClient) {
      // Fire both independent RPC calls in parallel
      const [savedResult, executedResult] = await Promise.allSettled([
        this.rpcClient.call("graph.list", { limit: 100 }) as Promise<{
          entries?: SavedGraphSummary[];
          total?: number;
        }>,
        this.rpcClient.call("graph.status", {}) as Promise<{
          graphs?: Array<{
            graphId: string;
            label?: string;
            status: string;
            startedAt?: number;
            completedAt?: number;
          }>;
        }>,
      ]);

      // Source 1: server-saved named graphs
      if (savedResult.status === "fulfilled" && savedResult.value?.entries) {
        savedEntries = savedResult.value.entries.map((g) => ({
          id: g.id,
          label: g.label,
          source: "saved" as const,
          nodeCount: g.nodeCount,
          agentCount: 0,
          savedAt: g.updatedAt,
          status: "draft" as const,
        }));
      }

      // Source 2: executed graphs from daemon
      if (executedResult.status === "fulfilled" && executedResult.value?.graphs) {
        executedEntries = executedResult.value.graphs.map((g) => ({
          id: g.graphId,
          label: g.label ?? g.graphId,
          source: "executed" as const,
          nodeCount: 0,
          agentCount: 0,
          lastRun: g.startedAt,
          status: g.status as PipelineListEntry["status"],
          graphId: g.graphId,
        }));
      }
    }

    // Merge two sources: saved (server) as base, executed (runtime) augments/appends
    const merged = [...savedEntries];

    // Augment with execution data (match by label, case-insensitive)
    for (const exec of executedEntries) {
      const matchIdx = merged.findIndex(
        (d) => d.label.toLowerCase() === exec.label.toLowerCase(),
      );
      if (matchIdx >= 0) {
        const existing = merged[matchIdx];
        merged[matchIdx] = {
          ...existing,
          lastRun: exec.lastRun,
          status: exec.status,
          graphId: exec.graphId,
        };
      } else {
        merged.push(exec);
      }
    }

    this._pipelines = merged;
    this._loading = false;
  }

  // ---------------------------------------------------------------------------
  // Filtering / sorting
  // ---------------------------------------------------------------------------

  private get _filtered(): PipelineListEntry[] {
    let list = this._pipelines;
    if (this._searchQuery) {
      const q = this._searchQuery.toLowerCase();
      list = list.filter((p) => p.label.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      const aVal = (a as unknown as Record<string, unknown>)[this._sortKey];
      const bVal = (b as unknown as Record<string, unknown>)[this._sortKey];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return this._sortAsc ? cmp : -cmp;
    });
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  private _navigate(path: string): void {
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: path,
        bubbles: true,
        composed: true,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Sort helpers
  // ---------------------------------------------------------------------------

  private _handleSort(field: string): void {
    if (this._sortKey === field) {
      this._sortAsc = !this._sortAsc;
    } else {
      this._sortKey = field;
      this._sortAsc = field === "label"; // alphabetical ascending by default for label
    }
  }

  private _sortArrow(field: string): string {
    if (this._sortKey !== field) return "";
    return this._sortAsc ? "\u25B2" : "\u25BC";
  }

  private _sortArrowClass(field: string): string {
    return this._sortKey === field
      ? "sort-arrow sort-arrow--active"
      : "sort-arrow";
  }

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  private _handleRowClick(pipeline: PipelineListEntry): void {
    if (pipeline.source === "executed" && pipeline.graphId) {
      this._navigate(`pipelines/${pipeline.graphId}`);
    } else {
      // "saved" navigates to edit view, "executed" navigates to monitor
      this._navigate(`pipelines/${pipeline.id}/edit`);
    }
  }

  private _handleEdit(pipeline: PipelineListEntry, e: Event): void {
    e.stopPropagation();
    this._navigate(`pipelines/${pipeline.id}/edit`);
  }

  private async _handleQuickExecute(
    pipeline: PipelineListEntry,
    e: Event,
  ): Promise<void> {
    e.stopPropagation();
    if (!this.rpcClient) {
      IcToast.show("Not connected to daemon", "error");
      return;
    }

    // Load graph data from server
    // eslint-disable-next-line no-useless-assignment
    let graphData: { nodes: Array<{ nodeId: string; id?: string; task: string; agentId?: string; dependsOn: string[]; maxSteps?: number; timeoutMs?: number; barrierMode?: string }>; settings: { label: string; onFailure: string; timeoutMs?: number; budget?: { maxTokens?: number; maxCost?: number } } } | null = null;

    try {
      const serverGraph = (await this.rpcClient.call("graph.load", { id: pipeline.id })) as {
        nodes: Array<{ nodeId: string; id?: string; task: string; agentId?: string; dependsOn: string[]; maxSteps?: number; timeoutMs?: number; barrierMode?: string }>;
        settings: { label: string; onFailure: string; timeoutMs?: number; budget?: { maxTokens?: number; maxCost?: number } };
      };
      graphData = serverGraph;
    } catch {
      IcToast.show("Could not load pipeline from server", "error");
      return;
    }

    if (!graphData) return;

    // Check for ${VAR} user-variable placeholders before executing
    const taskTexts = graphData.nodes.map((n) => n.task);
    const vars = extractVariables(taskTexts);
    if (vars.length > 0) {
      this._pendingExecuteData = graphData;
      this._variableNames = vars;
      this._showVariablePrompt = true;
      return;
    }

    // No variables -- execute directly
    await this._executeGraphPayload(graphData, graphData.nodes.map((n) => n.task));
  }

  /** Handle variable prompt confirmation from quick-execute. */
  private async _onVariableConfirm(
    e: CustomEvent<{ values: Record<string, string> }>,
  ): Promise<void> {
    this._showVariablePrompt = false;
    const graphData = this._pendingExecuteData;
    this._pendingExecuteData = null;
    if (!graphData || !this.rpcClient) return;

    const substitutedTasks = graphData.nodes.map((n) =>
      substituteVariables(n.task, e.detail.values),
    );

    await this._executeGraphPayload(graphData, substitutedTasks);
  }

  /** Build payload and call graph.execute RPC with the given task texts. */
  private async _executeGraphPayload(
    graphData: NonNullable<typeof this._pendingExecuteData>,
    taskTexts: string[],
  ): Promise<void> {
    if (!this.rpcClient) return;

    try {
      const payload: Record<string, unknown> = {
        nodes: graphData.nodes.map((n, i) => ({
          nodeId: n.nodeId ?? n.id!,
          task: taskTexts[i],
          agentId: n.agentId,
          dependsOn: n.dependsOn,
          maxSteps: n.maxSteps,
          timeoutMs: n.timeoutMs,
          barrierMode: n.barrierMode,
          model: (n as Record<string, unknown>).modelId as string | undefined,
          retries: (n as Record<string, unknown>).retries as number | undefined,
          type_id: (n as Record<string, unknown>).typeId as string | undefined,
          type_config: (n as Record<string, unknown>).typeConfig as Record<string, unknown> | undefined,
          context_mode: (n as Record<string, unknown>).contextMode as PipelineNode["contextMode"] | undefined,
        })),
        label: graphData.settings.label,
        onFailure: graphData.settings.onFailure,
        timeoutMs: graphData.settings.timeoutMs,
        budget: graphData.settings.budget,
      };

      // Approval-gate nodes require a channel context for announcements.
      // When running from the web UI, resolve the first available channel.
      const hasApprovalGate = graphData.nodes.some(
        (n) => (n as Record<string, unknown>).typeId === "approval-gate",
      );
      if (hasApprovalGate) {
        try {
          const channelData = await this.rpcClient.call<{ channels: Array<{ channelId: string; channelType: string }> }>("obs.channels.all");
          const channels = Array.isArray(channelData) ? channelData : channelData?.channels ?? [];
          if (channels.length > 0) {
            payload._callerChannelType = channels[0]!.channelType;
            payload._callerChannelId = channels[0]!.channelId;
          }
        } catch { /* best-effort - server will reject if still missing */ }
      }

      const result = (await this.rpcClient.call("graph.execute", payload)) as {
        graphId?: string;
      };

      if (result?.graphId) {
        IcToast.show("Pipeline started", "success");
        this._navigate(`pipelines/${result.graphId}`);
      } else {
        IcToast.show("Pipeline started", "success");
        await this._loadPipelines();
      }
    } catch (err) {
      IcToast.show(
        `Failed to execute: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    }
  }

  private async _handleDuplicate(pipeline: PipelineListEntry, e: Event): Promise<void> {
    e.stopPropagation();

    if (!this.rpcClient) {
      IcToast.show("Not connected to daemon", "error");
      return;
    }

    let nodes: import("../../api/types/index.js").PipelineNode[];
    let edges: import("../../api/types/index.js").PipelineEdge[];
    let settings: import("../../api/types/index.js").GraphSettings;

    try {
      const serverGraph = (await this.rpcClient.call("graph.load", { id: pipeline.id })) as {
        nodes: import("../../api/types/index.js").PipelineNode[];
        edges: import("../../api/types/index.js").PipelineEdge[];
        settings: import("../../api/types/index.js").GraphSettings;
      };
      nodes = serverGraph.nodes;
      edges = serverGraph.edges;
      settings = serverGraph.settings;
    } catch {
      IcToast.show("Could not load pipeline from server", "error");
      return;
    }

    const newId = crypto.randomUUID();
    const newLabel = `${settings.label} (copy)`;
    const newSettings = { ...settings, label: newLabel };

    try {
      await this.rpcClient.call("graph.save", {
        id: newId,
        label: newLabel,
        nodes,
        edges,
        settings: newSettings,
      });
      IcToast.show(`Duplicated as "${newLabel}"`, "success");
      this._loadPipelines();
    } catch (err) {
      IcToast.show(
        `Failed to duplicate: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    }
  }

  private _handleDeleteClick(pipeline: PipelineListEntry, e: Event): void {
    e.stopPropagation();
    this._deleteTarget = pipeline;
  }

  private async _confirmDelete(): Promise<void> {
    if (!this._deleteTarget) return;

    const target = this._deleteTarget;
    this._deleteTarget = null;

    try {
      await this.rpcClient?.call("graph.delete", { id: target.id });
      IcToast.show(`Deleted "${target.label}"`, "success");
    } catch (err) {
      IcToast.show(
        `Failed to delete: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    }
    this._loadPipelines();
  }

  private _cancelDelete(): void {
    this._deleteTarget = null;
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  private _renderStatusDot(status?: string) {
    const color = STATUS_COLORS[status ?? "draft"] ?? STATUS_COLORS.draft;
    const label =
      (status ?? "draft").charAt(0).toUpperCase() +
      (status ?? "draft").slice(1);
    const isRunning = status === "running";

    return html`<span class="status-text">
      <span
        class="status-dot ${isRunning ? "status-dot--running" : ""}"
        style="--dot-color: ${color}"
      ></span>
      ${label}
    </span>`;
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  override render() {
    return html`
      <ic-breadcrumb .items=${this._breadcrumbs}></ic-breadcrumb>

      <div class="page-header" role="region" aria-label="Pipelines">
        <h1 class="page-title">Pipelines</h1>
        <div style="display: flex; gap: 8px; align-items: center;">
          <button
            class="history-btn"
            @click=${() => this._navigate("pipelines/history")}
          >
            <ic-icon name="list" size="16px"></ic-icon>
            History
          </button>
          <button
            class="create-btn"
            @click=${() => this._navigate("pipelines/new")}
          >
            <ic-icon name="plus" size="16px"></ic-icon>
            New Pipeline
          </button>
        </div>
      </div>

      ${this._renderContent()}
      ${this._deleteTarget
        ? html`
            <ic-confirm-dialog
              open
              variant="danger"
              title="Delete Pipeline"
              message=${`Are you sure you want to delete "${this._deleteTarget.label}"? This cannot be undone.`}
              confirmLabel="Delete"
              @confirm=${this._confirmDelete}
              @cancel=${this._cancelDelete}
            ></ic-confirm-dialog>
          `
        : nothing}
      <ic-variable-prompt
        ?open=${this._showVariablePrompt}
        .variables=${this._variableNames}
        .pipelineLabel=${this._pendingExecuteData?.settings.label ?? ""}
        @confirm=${this._onVariableConfirm}
        @cancel=${() => { this._showVariablePrompt = false; this._pendingExecuteData = null; }}
      ></ic-variable-prompt>
    `;
  }

  private _renderContent() {
    if (this._loading) {
      return html`<ic-skeleton-view variant="list"></ic-skeleton-view>`;
    }

    if (this._pipelines.length === 0) {
      return html`
        <ic-empty-state
          icon="git-branch"
          message="No pipelines created"
          description="Build an execution graph to orchestrate multi-agent workflows."
        >
          <button
            class="create-btn"
            @click=${() => this._navigate("pipelines/new")}
          >
            <ic-icon name="plus" size="16px"></ic-icon>
            New Pipeline
          </button>
        </ic-empty-state>
      `;
    }

    const filtered = this._filtered;

    return html`
      <div class="search-bar">
        <input
          class="search-input"
          type="search"
          placeholder="Search pipelines..."
          .value=${this._searchQuery}
          @input=${(e: Event) => {
            this._searchQuery = (e.target as HTMLInputElement).value;
          }}
        />
      </div>

      ${filtered.length === 0
        ? html`<div class="no-results">No pipelines match your search.</div>`
        : html`
            ${this._renderTable(filtered)} ${this._renderMobileList(filtered)}
          `}
    `;
  }

  private _renderTable(pipelines: PipelineListEntry[]) {
    return html`
      <div class="grid-table" role="table">
        <div class="grid-header" role="row">
          <div
            class="cell"
            role="columnheader"
            @click=${() => this._handleSort("label")}
          >
            Name
            <span class=${this._sortArrowClass("label")}
              >${this._sortArrow("label")}</span
            >
          </div>
          <div
            class="cell"
            role="columnheader"
            @click=${() => this._handleSort("nodeCount")}
          >
            Nodes
            <span class=${this._sortArrowClass("nodeCount")}
              >${this._sortArrow("nodeCount")}</span
            >
          </div>
          <div
            class="cell"
            role="columnheader"
            @click=${() => this._handleSort("agentCount")}
          >
            Agents
            <span class=${this._sortArrowClass("agentCount")}
              >${this._sortArrow("agentCount")}</span
            >
          </div>
          <div
            class="cell"
            role="columnheader"
            @click=${() => this._handleSort("status")}
          >
            Status
            <span class=${this._sortArrowClass("status")}
              >${this._sortArrow("status")}</span
            >
          </div>
          <div
            class="cell"
            role="columnheader"
            @click=${() => this._handleSort("savedAt")}
          >
            Last Run
            <span class=${this._sortArrowClass("savedAt")}
              >${this._sortArrow("savedAt")}</span
            >
          </div>
          <div class="cell actions-header" role="columnheader">Actions</div>
        </div>
        ${pipelines.map((p) => this._renderRow(p))}
      </div>
    `;
  }

  private _renderRow(pipeline: PipelineListEntry) {
    const lastRunDisplay = formatRelativeTime(
      pipeline.lastRun ?? pipeline.savedAt,
    );
    const labelClass = "pipeline-label";

    return html`
      <div
        class="grid-row"
        role="row"
        @click=${() => this._handleRowClick(pipeline)}
      >
        <div class="cell" role="cell">
          <span class=${labelClass}>${pipeline.label}</span>
        </div>
        <div class="cell" role="cell">${pipeline.nodeCount}</div>
        <div class="cell" role="cell">${pipeline.agentCount}</div>
        <div class="cell" role="cell">
          ${this._renderStatusDot(pipeline.status)}
        </div>
        <div class="cell dim-text" role="cell">${lastRunDisplay}</div>
        <div class="cell actions-cell" role="cell">
          <button
            class="action-btn"
            aria-label="Edit ${pipeline.label}"
            @click=${(e: Event) => this._handleEdit(pipeline, e)}
          >
            <ic-icon name="edit" size="16px"></ic-icon>
          </button>
          ${pipeline.source === "saved"
            ? html`
                <button
                  class="action-btn action-btn--run"
                  aria-label="Run ${pipeline.label}"
                  @click=${(e: Event) => this._handleQuickExecute(pipeline, e)}
                >
                  <ic-icon name="play" size="16px"></ic-icon>
                </button>
                <button
                  class="action-btn"
                  aria-label="Duplicate ${pipeline.label}"
                  @click=${(e: Event) => this._handleDuplicate(pipeline, e)}
                >
                  <ic-icon name="copy" size="16px"></ic-icon>
                </button>
                <button
                  class="action-btn action-btn--danger"
                  aria-label="Delete ${pipeline.label}"
                  @click=${(e: Event) =>
                    this._handleDeleteClick(pipeline, e)}
                >
                  <ic-icon name="trash" size="16px"></ic-icon>
                </button>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  private _renderMobileList(pipelines: PipelineListEntry[]) {
    return html`
      <div class="mobile-list">
        ${pipelines.map(
          (p) => html`
            <div
              class="mobile-card"
              @click=${() => this._handleRowClick(p)}
            >
              <div class="card-header">
                <span class="card-label">${p.label}</span>
                ${this._renderStatusDot(p.status)}
              </div>
              <div class="card-meta">
                <span>${p.nodeCount} nodes</span>
                <span>${p.agentCount} agents</span>
                <span>${formatRelativeTime(p.lastRun ?? p.savedAt)}</span>
              </div>
              <div class="card-actions">
                <button
                  class="action-btn"
                  aria-label="Edit ${p.label}"
                  @click=${(e: Event) => this._handleEdit(p, e)}
                >
                  <ic-icon name="edit" size="16px"></ic-icon>
                </button>
                ${p.source === "saved"
                  ? html`
                      <button
                        class="action-btn action-btn--run"
                        aria-label="Run ${p.label}"
                        @click=${(e: Event) =>
                          this._handleQuickExecute(p, e)}
                      >
                        <ic-icon name="play" size="16px"></ic-icon>
                      </button>
                      <button
                        class="action-btn action-btn--danger"
                        aria-label="Delete ${p.label}"
                        @click=${(e: Event) =>
                          this._handleDeleteClick(p, e)}
                      >
                        <ic-icon name="trash" size="16px"></ic-icon>
                      </button>
                    `
                  : nothing}
              </div>
            </div>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-pipeline-list": IcPipelineList;
  }
}
