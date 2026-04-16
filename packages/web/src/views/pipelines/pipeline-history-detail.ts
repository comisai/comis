/**
 * Pipeline run history detail view.
 *
 * Displays the full detail of a single pipeline graph run including
 * breadcrumb navigation, metadata header, node accordion with
 * markdown-rendered outputs, expandable artifacts, and delete action.
 *
 * Data source: graph.runDetail RPC returning GraphRunDetail from disk.
 *
 * @module
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { RpcClient } from "../../api/rpc-client.js";
import type { GraphRunDetail } from "../../api/types/index.js";
import { renderMarkdown, sanitizeHtml } from "../../components/domain/ic-chat-message.js";
import { IcToast } from "../../components/feedback/ic-toast.js";
import "../../components/nav/ic-breadcrumb.js";
import type { BreadcrumbItem } from "../../components/nav/ic-breadcrumb.js";
import "../../components/feedback/ic-confirm-dialog.js";
import "../../components/feedback/ic-toast.js";
import "../../components/shell/ic-skeleton-view.js";
import "../../components/display/ic-icon.js";
// Side-effect import for code blocks rendered by renderMarkdown
import "../../components/domain/ic-code-block.js";

/** Status-to-color mapping for status dots. */
const STATUS_COLORS: Record<string, string> = {
  completed: "#22c55e",
  failed: "#ef4444",
};

/**
 * Format an epoch-ms timestamp as a relative time string.
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

/** Clean up a nodeId into a display-friendly name: replace underscores with spaces, title case. */
function formatNodeName(nodeId: string): string {
  return nodeId
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Suppress unused import warning -- sanitizeHtml used indirectly via renderMarkdown
void sanitizeHtml;

@customElement("ic-pipeline-history-detail")
export class IcPipelineHistoryDetail extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      /* Metadata header */
      .meta-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        padding: var(--ic-space-md, 0.75rem) var(--ic-space-lg, 1.5rem);
        background: var(--ic-surface, #111827);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        margin-bottom: var(--ic-space-lg, 1.5rem);
      }

      .meta-info {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs, 0.25rem);
      }

      .meta-name {
        font-size: var(--ic-text-xl, 1.25rem);
        font-weight: 700;
        color: var(--ic-text, #f3f4f6);
        margin: 0;
      }

      .meta-details {
        display: flex;
        gap: var(--ic-space-lg, 1.5rem);
        font-size: var(--ic-text-sm, 0.875rem);
        color: var(--ic-text-dim, #6b7280);
      }

      .meta-detail {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      /* Status dot */
      .status-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--dot-color, #6b7280);
        margin-right: 4px;
        vertical-align: middle;
        flex-shrink: 0;
      }

      .status-text {
        display: inline-flex;
        align-items: center;
      }

      /* Delete button */
      .delete-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs, 0.25rem);
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        background: transparent;
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-sm, 0.25rem);
        color: var(--ic-text-dim, #6b7280);
        font-size: var(--ic-text-sm, 0.875rem);
        font-family: inherit;
        cursor: pointer;
        transition: color var(--ic-transition, 150ms ease),
          border-color var(--ic-transition, 150ms ease);
      }

      .delete-btn:hover {
        color: var(--ic-error, #f87171);
        border-color: var(--ic-error, #f87171);
      }

      /* Node accordion */
      .node-accordion {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm, 0.5rem);
      }

      .node-section {
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        overflow: hidden;
      }

      .node-section summary {
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        font-weight: 600;
        font-size: var(--ic-text-sm, 0.875rem);
        color: var(--ic-text, #f3f4f6);
        cursor: pointer;
        user-select: none;
        background: var(--ic-surface, #111827);
        border-bottom: 1px solid transparent;
        transition: background var(--ic-transition, 150ms ease);
      }

      .node-section summary:hover {
        background: var(--ic-surface-2, #1f2937);
      }

      .node-section[open] summary {
        border-bottom-color: var(--ic-border, #374151);
      }

      .node-content {
        padding: var(--ic-space-md, 0.75rem) var(--ic-space-lg, 1.5rem);
        border-left: 3px solid var(--ic-accent, #3b82f6);
        margin-left: var(--ic-space-sm, 0.5rem);
      }

      /* Markdown rendering styles */
      .node-content h3, .node-content h4, .node-content h5, .node-content h6 {
        color: var(--ic-text, #f3f4f6);
        margin-top: var(--ic-space-md, 0.75rem);
        margin-bottom: var(--ic-space-xs, 0.25rem);
      }

      .node-content p {
        margin: var(--ic-space-xs, 0.25rem) 0;
        line-height: 1.6;
      }

      .node-content ul, .node-content ol {
        padding-left: var(--ic-space-lg, 1.5rem);
        margin: var(--ic-space-xs, 0.25rem) 0;
      }

      .node-content li {
        margin: 2px 0;
      }

      .node-content code.inline-code {
        background: var(--ic-surface-2, #1f2937);
        padding: 1px 4px;
        border-radius: 3px;
        font-size: 0.85em;
        font-family: var(--ic-font-mono, monospace);
      }

      .node-content table {
        width: 100%;
        border-collapse: collapse;
        margin: var(--ic-space-sm, 0.5rem) 0;
        font-size: var(--ic-text-sm, 0.875rem);
      }

      .node-content th, .node-content td {
        padding: 4px 8px;
        border: 1px solid var(--ic-border, #374151);
        text-align: left;
      }

      .node-content th {
        background: var(--ic-surface-2, #1f2937);
        font-weight: 600;
      }

      .node-content a {
        color: var(--ic-accent, #3b82f6);
        text-decoration: underline;
      }

      .node-content blockquote {
        border-left: 3px solid var(--ic-border, #374151);
        padding-left: var(--ic-space-md, 0.75rem);
        color: var(--ic-text-dim, #6b7280);
        margin: var(--ic-space-sm, 0.5rem) 0;
      }

      /* Artifact sub-sections */
      .artifact-section {
        margin-top: var(--ic-space-sm, 0.5rem);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-sm, 0.25rem);
      }

      .artifact-section summary {
        padding: var(--ic-space-xs, 0.25rem) var(--ic-space-sm, 0.5rem);
        font-size: var(--ic-text-xs, 0.75rem);
        font-weight: 500;
        color: var(--ic-text-dim, #6b7280);
        cursor: pointer;
        background: var(--ic-bg, #0d1117);
      }

      .artifact-section summary:hover {
        color: var(--ic-text-muted, #9ca3af);
      }

      .artifact-content {
        padding: var(--ic-space-sm, 0.5rem);
        font-size: var(--ic-text-sm, 0.875rem);
      }

      /* No output placeholder */
      .no-output {
        color: var(--ic-text-dim, #6b7280);
        font-style: italic;
        font-size: var(--ic-text-sm, 0.875rem);
      }

      /* Not found state */
      .not-found {
        text-align: center;
        padding: var(--ic-space-xl, 2rem);
        color: var(--ic-text-dim, #6b7280);
      }

      .not-found a {
        color: var(--ic-accent, #3b82f6);
        text-decoration: underline;
      }
    `,
  ];

  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property({ type: String }) graphId = "";

  private _rpcStatusUnsub: (() => void) | null = null;

  @state() private _detail: GraphRunDetail | null = null;
  @state() private _loading = true;
  @state() private _error = false;
  @state() private _showDeleteConfirm = false;

  private get _breadcrumbs(): BreadcrumbItem[] {
    return [
      { label: "Pipelines", route: "pipelines" },
      { label: "History", route: "pipelines/history" },
      { label: this._detail?.name ?? this.graphId },
    ];
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._rpcStatusUnsub?.();
    this._rpcStatusUnsub = null;
  }

  override updated(changed: Map<string, unknown>): void {
    if ((changed.has("rpcClient") || changed.has("graphId")) && this.rpcClient && this.graphId) {
      this._rpcStatusUnsub?.();
      if (this.rpcClient.status === "connected") {
        this._loadDetail();
      } else {
        this._rpcStatusUnsub = this.rpcClient.onStatusChange((status) => {
          if (status === "connected") {
            this._rpcStatusUnsub = null;
            this._loadDetail();
          }
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  private async _loadDetail(): Promise<void> {
    this._loading = true;
    this._error = false;

    try {
      const result = (await this.rpcClient?.call("graph.runDetail", {
        graphId: this.graphId,
      })) as GraphRunDetail | undefined;

      if (result) {
        this._detail = result;
      } else {
        this._error = true;
      }
    } catch {
      this._error = true;
    }

    this._loading = false;
  }

  // ---------------------------------------------------------------------------
  // Delete flow
  // ---------------------------------------------------------------------------

  private async _confirmDelete(): Promise<void> {
    this._showDeleteConfirm = false;

    try {
      await this.rpcClient?.call("graph.deleteRun", { graphId: this.graphId });
      IcToast.show("Run deleted", "success");
      window.location.hash = "#/pipelines/history";
    } catch (err) {
      IcToast.show(
        `Failed to delete: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  override render() {
    return html`
      <ic-breadcrumb .items=${this._breadcrumbs}
        @navigate=${(e: CustomEvent<string>) => this.dispatchEvent(
          new CustomEvent("navigate", { detail: e.detail, bubbles: true, composed: true }),
        )}
      ></ic-breadcrumb>

      ${this._renderContent()}

      <ic-confirm-dialog
        ?open=${this._showDeleteConfirm}
        variant="danger"
        title="Delete Run"
        message=${`Delete run "${this._detail?.name ?? this.graphId}"? This cannot be undone.`}
        confirmLabel="Delete"
        @confirm=${this._confirmDelete}
        @cancel=${() => { this._showDeleteConfirm = false; }}
      ></ic-confirm-dialog>
    `;
  }

  private _renderContent() {
    if (this._loading) {
      return html`<ic-skeleton-view variant="detail"></ic-skeleton-view>`;
    }

    if (this._error || !this._detail) {
      return html`
        <div class="not-found">
          <p>Run not found.</p>
          <a href="#/pipelines/history">Back to History</a>
        </div>
      `;
    }

    const d = this._detail;
    const dateMs = new Date(d.date).getTime();
    const color = STATUS_COLORS[d.status] ?? "#6b7280";
    const statusLabel = d.status.charAt(0).toUpperCase() + d.status.slice(1);

    return html`
      <div class="meta-header">
        <div class="meta-info">
          <h2 class="meta-name">${d.name}</h2>
          <div class="meta-details">
            <span class="meta-detail">
              <span class="status-text">
                <span class="status-dot" style="--dot-color: ${color}"></span>
                ${statusLabel}
              </span>
            </span>
            <span class="meta-detail">${formatRelativeTime(dateMs)}</span>
            <span class="meta-detail">${d.nodes.length} nodes</span>
          </div>
        </div>
        <button
          class="delete-btn"
          @click=${() => { this._showDeleteConfirm = true; }}
        >
          <ic-icon name="trash" size="14px"></ic-icon>
          Delete Run
        </button>
      </div>

      <div class="node-accordion">
        ${d.nodes.map((node, idx) => html`
          <details class="node-section" ?open=${idx === 0}>
            <summary>${formatNodeName(node.nodeId)}</summary>
            <div class="node-content">
              ${node.output
                ? unsafeHTML(renderMarkdown(node.output))
                : html`<p class="no-output">No output</p>`}
              ${node.artifacts.length > 0
                ? node.artifacts.map((a) => html`
                    <details class="artifact-section">
                      <summary>${a.filename}</summary>
                      <div class="artifact-content">
                        ${unsafeHTML(renderMarkdown(a.content))}
                      </div>
                    </details>
                  `)
                : nothing}
            </div>
          </details>
        `)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-pipeline-history-detail": IcPipelineHistoryDetail;
  }
}
