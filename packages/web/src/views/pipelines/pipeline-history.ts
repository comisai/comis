/**
 * Pipeline run history list view.
 *
 * Displays a sortable grid-table of all past pipeline graph runs with
 * name, status badges, node count, relative dates, view/delete actions,
 * empty state with builder link, and loading skeleton.
 *
 * Data source: graph.runs RPC returning GraphRunSummary[] from disk.
 *
 * @module
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { RpcClient } from "../../api/rpc-client.js";
import type { GraphRunSummary } from "../../api/types/index.js";
import { IcToast } from "../../components/feedback/ic-toast.js";
import "../../components/nav/ic-breadcrumb.js";
import type { BreadcrumbItem } from "../../components/nav/ic-breadcrumb.js";
import "../../components/feedback/ic-confirm-dialog.js";
import "../../components/feedback/ic-toast.js";
import "../../components/feedback/ic-empty-state.js";
import "../../components/shell/ic-skeleton-view.js";
import "../../components/display/ic-icon.js";

/** Status-to-color mapping for status dots. */
const STATUS_COLORS: Record<string, string> = {
  completed: "#22c55e",
  failed: "#ef4444",
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

/** Sort field keys for the grid table */
type SortField = "name" | "status" | "nodeCount" | "date";
type SortDir = "asc" | "desc";

@customElement("ic-pipeline-history")
export class IcPipelineHistory extends LitElement {
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

      /* Grid-based table -- 5 columns */
      .grid-table {
        display: grid;
        grid-template-columns: minmax(180px, 2fr) 100px 70px 120px auto;
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

      .run-name {
        font-weight: 500;
        color: var(--ic-text, #f3f4f6);
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
    `,
  ];

  @property({ attribute: false }) rpcClient: RpcClient | null = null;

  private _rpcStatusUnsub: (() => void) | null = null;

  @state() private _runs: GraphRunSummary[] = [];
  @state() private _loading = true;
  @state() private _sortField: SortField = "date";
  @state() private _sortDir: SortDir = "desc";
  @state() private _deleteTarget: GraphRunSummary | null = null;

  private get _breadcrumbs(): BreadcrumbItem[] {
    return [
      { label: "Pipelines", route: "pipelines" },
      { label: "History" },
    ];
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
        this._loadRuns();
      } else {
        this._rpcStatusUnsub = this.rpcClient.onStatusChange((status) => {
          if (status === "connected") {
            this._rpcStatusUnsub = null;
            this._loadRuns();
          }
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  private async _loadRuns(): Promise<void> {
    this._loading = true;

    try {
      const result = (await this.rpcClient?.call("graph.runs", {})) as {
        runs?: GraphRunSummary[];
      } | undefined;
      this._runs = result?.runs ?? [];
    } catch {
      this._runs = [];
    }

    this._loading = false;
  }

  // ---------------------------------------------------------------------------
  // Sorting
  // ---------------------------------------------------------------------------

  private get _sorted(): GraphRunSummary[] {
    return [...this._runs].sort((a, b) => {
      let cmp = 0;
      switch (this._sortField) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "status":
          cmp = a.status.localeCompare(b.status);
          break;
        case "nodeCount":
          cmp = a.nodeCount - b.nodeCount;
          break;
        case "date":
          cmp = a.date.localeCompare(b.date);
          break;
      }
      return this._sortDir === "asc" ? cmp : -cmp;
    });
  }

  private _handleSort(field: SortField): void {
    if (this._sortField === field) {
      this._sortDir = this._sortDir === "asc" ? "desc" : "asc";
    } else {
      this._sortField = field;
      this._sortDir = field === "name" ? "asc" : "desc";
    }
  }

  private _sortArrow(field: SortField): string {
    if (this._sortField !== field) return "";
    return this._sortDir === "asc" ? "\u25B2" : "\u25BC";
  }

  private _sortArrowClass(field: SortField): string {
    return this._sortField === field
      ? "sort-arrow sort-arrow--active"
      : "sort-arrow";
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  private _navigateToDetail(run: GraphRunSummary): void {
    window.location.hash = `#/pipelines/history/${run.graphId}`;
  }

  // ---------------------------------------------------------------------------
  // Delete flow
  // ---------------------------------------------------------------------------

  private _handleDeleteClick(run: GraphRunSummary, e: Event): void {
    e.stopPropagation();
    this._deleteTarget = run;
  }

  private async _confirmDelete(): Promise<void> {
    if (!this._deleteTarget) return;

    const target = this._deleteTarget;
    this._deleteTarget = null;

    try {
      await this.rpcClient?.call("graph.deleteRun", { graphId: target.graphId });
      this._runs = this._runs.filter((r) => r.graphId !== target.graphId);
      IcToast.show(`Deleted "${target.name}"`, "success");
    } catch (err) {
      IcToast.show(
        `Failed to delete: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    }
  }

  private _cancelDelete(): void {
    this._deleteTarget = null;
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  private _renderStatusDot(status: string) {
    const color = STATUS_COLORS[status] ?? "#6b7280";
    const label = status.charAt(0).toUpperCase() + status.slice(1);

    return html`<span class="status-text">
      <span class="status-dot" style="--dot-color: ${color}"></span>
      ${label}
    </span>`;
  }

  /** Parse ISO date string to epoch ms for relative time display. */
  private _dateToRelative(dateStr: string): string {
    const ms = new Date(dateStr).getTime();
    return formatRelativeTime(ms);
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  override render() {
    return html`
      <ic-breadcrumb .items=${this._breadcrumbs}
        @navigate=${(e: CustomEvent<string>) => this.dispatchEvent(
          new CustomEvent("navigate", { detail: e.detail, bubbles: true, composed: true }),
        )}
      ></ic-breadcrumb>

      <div class="page-header" role="region" aria-label="Pipeline History">
        <h1 class="page-title">Pipeline History</h1>
      </div>

      ${this._renderContent()}
      ${this._deleteTarget
        ? html`
            <ic-confirm-dialog
              open
              variant="danger"
              title="Delete Run"
              message=${`Delete run "${this._deleteTarget.name}"? This cannot be undone.`}
              confirmLabel="Delete"
              @confirm=${this._confirmDelete}
              @cancel=${this._cancelDelete}
            ></ic-confirm-dialog>
          `
        : nothing}
    `;
  }

  private _renderContent() {
    if (this._loading) {
      return html`<ic-skeleton-view variant="list"></ic-skeleton-view>`;
    }

    if (this._runs.length === 0) {
      return html`
        <ic-empty-state
          icon="git-branch"
          message="No pipeline runs yet"
          description="Run a pipeline to see results here."
        >
          <button
            class="action-btn"
            style="padding: 8px 16px; width: auto; height: auto; border: 1px solid var(--ic-border, #374151); color: var(--ic-text, #f3f4f6);"
            @click=${() => { window.location.hash = "#/pipelines/new"; }}
          >
            New Pipeline
          </button>
        </ic-empty-state>
      `;
    }

    const sorted = this._sorted;

    return html`
      ${this._renderTable(sorted)}
      ${this._renderMobileList(sorted)}
    `;
  }

  private _renderTable(runs: GraphRunSummary[]) {
    return html`
      <div class="grid-table" role="table">
        <div class="grid-header" role="row">
          <div class="cell" role="columnheader" @click=${() => this._handleSort("name")}>
            Name
            <span class=${this._sortArrowClass("name")}>${this._sortArrow("name")}</span>
          </div>
          <div class="cell" role="columnheader" @click=${() => this._handleSort("status")}>
            Status
            <span class=${this._sortArrowClass("status")}>${this._sortArrow("status")}</span>
          </div>
          <div class="cell" role="columnheader" @click=${() => this._handleSort("nodeCount")}>
            Nodes
            <span class=${this._sortArrowClass("nodeCount")}>${this._sortArrow("nodeCount")}</span>
          </div>
          <div class="cell" role="columnheader" @click=${() => this._handleSort("date")}>
            Date
            <span class=${this._sortArrowClass("date")}>${this._sortArrow("date")}</span>
          </div>
          <div class="cell actions-header" role="columnheader">Actions</div>
        </div>
        ${runs.map((r) => this._renderRow(r))}
      </div>
    `;
  }

  private _renderRow(run: GraphRunSummary) {
    return html`
      <div class="grid-row" role="row" @click=${() => this._navigateToDetail(run)}>
        <div class="cell" role="cell">
          <span class="run-name">${run.name}</span>
        </div>
        <div class="cell" role="cell">
          ${this._renderStatusDot(run.status)}
        </div>
        <div class="cell" role="cell">${run.nodeCount}</div>
        <div class="cell dim-text" role="cell">${this._dateToRelative(run.date)}</div>
        <div class="cell actions-cell" role="cell">
          <button
            class="action-btn"
            aria-label="View ${run.name}"
            @click=${(e: Event) => { e.stopPropagation(); this._navigateToDetail(run); }}
          >
            <ic-icon name="eye" size="16px"></ic-icon>
          </button>
          <button
            class="action-btn action-btn--danger"
            aria-label="Delete ${run.name}"
            @click=${(e: Event) => this._handleDeleteClick(run, e)}
          >
            <ic-icon name="trash" size="16px"></ic-icon>
          </button>
        </div>
      </div>
    `;
  }

  private _renderMobileList(runs: GraphRunSummary[]) {
    return html`
      <div class="mobile-list">
        ${runs.map(
          (r) => html`
            <div class="mobile-card" @click=${() => this._navigateToDetail(r)}>
              <div class="card-header">
                <span class="card-label">${r.name}</span>
                ${this._renderStatusDot(r.status)}
              </div>
              <div class="card-meta">
                <span>${r.nodeCount} nodes</span>
                <span>${this._dateToRelative(r.date)}</span>
              </div>
              <div class="card-actions">
                <button
                  class="action-btn"
                  aria-label="View ${r.name}"
                  @click=${(e: Event) => { e.stopPropagation(); this._navigateToDetail(r); }}
                >
                  <ic-icon name="eye" size="16px"></ic-icon>
                </button>
                <button
                  class="action-btn action-btn--danger"
                  aria-label="Delete ${r.name}"
                  @click=${(e: Event) => this._handleDeleteClick(r, e)}
                >
                  <ic-icon name="trash" size="16px"></ic-icon>
                </button>
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
    "ic-pipeline-history": IcPipelineHistory;
  }
}
