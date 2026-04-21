// SPDX-License-Identifier: Apache-2.0
/**
 * Context DAG browser view.
 *
 * Displays a list of DAG conversations, an expandable summary tree
 * for a selected conversation, FTS5 search within conversations,
 * and node inspection via a detail panel.
 *
 * Operator can navigate DAG conversations as a tree, search across
 * content, and inspect nodes.
 *
 * @module
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { DagConversation, DagTreeNode } from "../api/types/memory-types.js";

// Side-effect imports for sub-components
import "../components/feedback/ic-loading.js";
import "../components/feedback/ic-empty-state.js";
import "../components/form/ic-search-input.js";
import "../components/data/ic-tag.js";
import "../components/data/ic-relative-time.js";
import "../components/layout/ic-detail-panel.js";

type LoadState = "loading" | "loaded" | "error";

/** Search result item from context.searchByConversation RPC. */
interface SearchResult {
  readonly id: string;
  readonly type: "message" | "summary";
  readonly content: string;
  readonly rank?: number;
}

/** Inspected node detail from context.inspect RPC. */
interface InspectedNode {
  readonly type: string;
  readonly summaryId?: string;
  readonly content: string;
  readonly depth?: number;
  readonly kind?: string;
  readonly tokenCount?: number;
  readonly parentIds?: string[];
  readonly childIds?: string[];
  readonly sourceMessageCount?: number;
}

/**
 * Context DAG browser operator view.
 *
 * Two-column layout: left panel lists conversations and shows the tree;
 * right panel slides in for node inspection. Search bar performs
 * server-side FTS5 search within the selected conversation.
 */
@customElement("ic-context-dag-browser")
export class IcContextDagBrowser extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--ic-space-md);
      }

      .header-title {
        font-size: var(--ic-text-lg);
        font-weight: 600;
        color: var(--ic-text);
      }

      .header-stats {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-dim);
      }

      .layout {
        display: grid;
        grid-template-columns: 320px 1fr;
        gap: var(--ic-space-md);
        min-height: 400px;
      }

      .layout.no-tree {
        grid-template-columns: 1fr;
      }

      /* Conversation list panel */
      .conv-panel {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm);
        overflow-y: auto;
        max-height: 80vh;
      }

      .conv-panel-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: var(--ic-space-xs) var(--ic-space-sm);
        margin-bottom: var(--ic-space-xs);
      }

      .conv-card {
        display: block;
        width: 100%;
        padding: var(--ic-space-sm);
        background: none;
        border: 1px solid transparent;
        border-radius: var(--ic-radius-sm);
        cursor: pointer;
        text-align: left;
        color: var(--ic-text-muted);
        font-family: inherit;
        font-size: var(--ic-text-sm);
        transition: background var(--ic-transition), border-color var(--ic-transition);
      }

      .conv-card:hover {
        background: var(--ic-surface-2);
      }

      .conv-card.selected {
        background: rgba(59, 130, 246, 0.1);
        border-color: var(--ic-accent);
        color: var(--ic-text);
      }

      .conv-agent {
        font-weight: 500;
        color: var(--ic-text);
        margin-bottom: 2px;
      }

      .conv-session {
        font-size: 11px;
        color: var(--ic-text-dim);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .conv-meta {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
        margin-top: 4px;
        font-size: 11px;
        color: var(--ic-text-dim);
      }

      /* Tree panel */
      .tree-panel {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
        overflow-y: auto;
        max-height: 80vh;
      }

      .tree-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--ic-space-sm);
      }

      .tree-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text);
      }

      .tree-msg-count {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      .search-section {
        margin-bottom: var(--ic-space-sm);
      }

      /* Tree nodes */
      .tree-node {
        display: flex;
        align-items: flex-start;
        gap: var(--ic-space-xs);
        padding: 4px var(--ic-space-xs);
        border-radius: var(--ic-radius-sm);
        cursor: pointer;
        transition: background var(--ic-transition);
      }

      .tree-node:hover {
        background: var(--ic-surface-2);
      }

      .tree-node.inspected {
        background: rgba(59, 130, 246, 0.08);
      }

      .tree-chevron {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        font-size: 10px;
        color: var(--ic-text-dim);
        flex-shrink: 0;
        margin-top: 2px;
        cursor: pointer;
        transition: transform var(--ic-transition);
      }

      .tree-chevron.expanded {
        transform: rotate(90deg);
      }

      .tree-chevron.leaf {
        visibility: hidden;
      }

      .tree-content {
        flex: 1;
        min-width: 0;
      }

      .tree-node-header {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
        font-size: var(--ic-text-sm);
      }

      .tree-preview {
        font-size: 12px;
        color: var(--ic-text-dim);
        margin-top: 2px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tree-node-meta {
        font-size: 11px;
        color: var(--ic-text-dim);
      }

      /* Search results */
      .search-results {
        margin-top: var(--ic-space-sm);
      }

      .search-result {
        display: flex;
        align-items: flex-start;
        gap: var(--ic-space-xs);
        padding: var(--ic-space-xs) var(--ic-space-sm);
        border-radius: var(--ic-radius-sm);
        cursor: pointer;
        transition: background var(--ic-transition);
      }

      .search-result:hover {
        background: var(--ic-surface-2);
      }

      .search-result-content {
        flex: 1;
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }

      .search-rank {
        font-size: 11px;
        color: var(--ic-text-dim);
        flex-shrink: 0;
      }

      /* Detail panel content */
      .detail-section {
        margin-bottom: var(--ic-space-md);
      }

      .detail-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--ic-text-dim);
        margin-bottom: var(--ic-space-xs);
      }

      .detail-value {
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
      }

      .detail-content {
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 400px;
        overflow-y: auto;
        background: var(--ic-surface-2);
        border-radius: var(--ic-radius-sm);
        padding: var(--ic-space-sm);
      }

      .detail-meta-grid {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 4px var(--ic-space-sm);
        font-size: var(--ic-text-sm);
      }

      .detail-meta-key {
        color: var(--ic-text-dim);
        font-weight: 500;
      }

      .detail-meta-val {
        color: var(--ic-text);
      }

      .error-msg {
        color: var(--ic-error);
        font-size: var(--ic-text-sm);
        padding: var(--ic-space-md);
      }
    `,
  ];

  /** RPC client for backend communication. */
  @property({ attribute: false }) rpcClient: RpcClient | null = null;

  @state() private _loadState: LoadState = "loading";
  @state() private _conversations: DagConversation[] = [];
  @state() private _selectedConvId: string | null = null;
  @state() private _treeNodes: DagTreeNode[] = [];
  @state() private _treeMessageCount = 0;
  @state() private _expanded: Set<string> = new Set();
  @state() private _searchQuery = "";
  @state() private _searchResults: SearchResult[] = [];
  @state() private _inspectedNode: InspectedNode | null = null;
  @state() private _detailOpen = false;
  @state() private _treeLoading = false;
  @state() private _searchLoading = false;
  @state() private _errorMsg = "";

  private _searchTimeout: ReturnType<typeof setTimeout> | null = null;
  private _rpcClientInitialized = false;

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("rpcClient") && this.rpcClient && !this._rpcClientInitialized) {
      this._rpcClientInitialized = true;
      this._loadConversations();
    }
  }

  private async _loadConversations(): Promise<void> {
    if (!this.rpcClient) return;
    this._loadState = "loading";
    try {
      const res = await this.rpcClient.call("context.conversations", { limit: 100, offset: 0 }) as { conversations: DagConversation[]; total: number };
      this._conversations = res.conversations;
      this._loadState = "loaded";
    } catch (e) {
      this._errorMsg = (e as Error).message;
      this._loadState = "error";
    }
  }

  private async _selectConversation(convId: string): Promise<void> {
    if (this._selectedConvId === convId) return;
    this._selectedConvId = convId;
    this._treeNodes = [];
    this._searchQuery = "";
    this._searchResults = [];
    this._expanded = new Set();
    this._inspectedNode = null;
    this._detailOpen = false;
    await this._loadTree(convId);
  }

  private async _loadTree(convId: string): Promise<void> {
    if (!this.rpcClient) return;
    this._treeLoading = true;
    try {
      const res = await this.rpcClient.call("context.tree", { conversation_id: convId }) as { conversationId: string; nodes: DagTreeNode[]; messageCount: number };
      this._treeNodes = res.nodes;
      this._treeMessageCount = res.messageCount;
    } catch (e) {
      this._errorMsg = (e as Error).message;
    } finally {
      this._treeLoading = false;
    }
  }

  private _toggleNode(nodeId: string): void {
    const next = new Set(this._expanded);
    if (next.has(nodeId)) {
      next.delete(nodeId);
    } else {
      next.add(nodeId);
    }
    this._expanded = next;
  }

  private async _inspectNode(summaryId: string): Promise<void> {
    if (!this.rpcClient) return;
    try {
      const res = await this.rpcClient.call("context.inspect", { id: summaryId }) as InspectedNode;
      this._inspectedNode = res;
      this._detailOpen = true;
    } catch (e) {
      this._errorMsg = (e as Error).message;
    }
  }

  private _handleSearch(e: CustomEvent<string>): void {
    const query = e.detail;
    this._searchQuery = query;
    if (this._searchTimeout) {
      clearTimeout(this._searchTimeout);
    }
    if (!query) {
      this._searchResults = [];
      return;
    }
    this._searchTimeout = setTimeout(() => this._executeSearch(query), 300);
  }

  private async _executeSearch(query: string): Promise<void> {
    if (!this.rpcClient || !this._selectedConvId) return;
    this._searchLoading = true;
    try {
      const res = await this.rpcClient.call("context.searchByConversation", {
        conversation_id: this._selectedConvId,
        query,
        limit: 50,
      }) as { results: SearchResult[] };
      this._searchResults = res.results;
    } catch (e) {
      this._errorMsg = (e as Error).message;
    } finally {
      this._searchLoading = false;
    }
  }

  private _handleSearchResultClick(result: SearchResult): void {
    if (result.type === "summary") {
      this._inspectNode(result.id);
    } else {
      // Message result: show content in detail panel
      this._inspectedNode = {
        type: "message",
        content: result.content,
      };
      this._detailOpen = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  private _renderConversationList() {
    if (this._conversations.length === 0) {
      return html`<ic-empty-state message="No conversations found"></ic-empty-state>`;
    }

    return html`
      <div class="conv-panel-title">Conversations</div>
      ${this._conversations.map((conv) => html`
        <button
          class="conv-card ${this._selectedConvId === conv.conversation_id ? "selected" : ""}"
          @click=${() => this._selectConversation(conv.conversation_id)}
        >
          <div class="conv-agent">${conv.agent_id}</div>
          <div class="conv-session">${conv.session_key.length > 40 ? conv.session_key.slice(0, 40) + "..." : conv.session_key}</div>
          ${conv.title ? html`<div class="conv-session">${conv.title}</div>` : nothing}
          <div class="conv-meta">
            <ic-relative-time .timestamp=${new Date(conv.updated_at).getTime()}></ic-relative-time>
          </div>
        </button>
      `)}
    `;
  }

  private _getRootNodes(): DagTreeNode[] {
    return this._treeNodes.filter((n) => n.parentIds.length === 0 || n.depth === 0);
  }

  private _renderNode(node: DagTreeNode): unknown {
    const hasChildren = node.childIds.length > 0;
    const isExpanded = this._expanded.has(node.summaryId);
    const isInspected = this._inspectedNode?.summaryId === node.summaryId;
    const children = hasChildren && isExpanded
      ? this._treeNodes.filter((n) => node.childIds.includes(n.summaryId))
      : [];

    return html`
      <div style="padding-left: ${node.depth * 16}px">
        <div
          class="tree-node ${isInspected ? "inspected" : ""}"
          @click=${() => this._inspectNode(node.summaryId)}
        >
          <span
            class="tree-chevron ${hasChildren ? (isExpanded ? "expanded" : "") : "leaf"}"
            @click=${(e: Event) => { e.stopPropagation(); if (hasChildren) this._toggleNode(node.summaryId); }}
          >${hasChildren ? "\u25B6" : ""}</span>
          <div class="tree-content">
            <div class="tree-node-header">
              <ic-tag .label=${node.kind}></ic-tag>
              <span class="tree-node-meta">d${node.depth} | ${node.tokenCount}t</span>
            </div>
            <div class="tree-preview">${node.contentPreview.slice(0, 100)}</div>
          </div>
        </div>
        ${children.map((child) => this._renderNode(child))}
      </div>
    `;
  }

  private _renderTree() {
    if (this._treeLoading) {
      return html`<ic-loading></ic-loading>`;
    }
    if (this._treeNodes.length === 0) {
      return html`<ic-empty-state message="No summaries in this conversation"></ic-empty-state>`;
    }

    const roots = this._getRootNodes();
    return html`${roots.map((node) => this._renderNode(node))}`;
  }

  private _renderSearchResults() {
    if (this._searchLoading) {
      return html`<ic-loading></ic-loading>`;
    }
    if (this._searchResults.length === 0) {
      return html`<ic-empty-state message="No results found"></ic-empty-state>`;
    }

    return html`
      <div class="search-results">
        ${this._searchResults.map((r) => html`
          <div class="search-result" @click=${() => this._handleSearchResultClick(r)}>
            <ic-tag .label=${r.type}></ic-tag>
            <div class="search-result-content">${r.content.slice(0, 150)}</div>
            ${r.rank != null ? html`<span class="search-rank">${r.rank.toFixed(2)}</span>` : nothing}
          </div>
        `)}
      </div>
    `;
  }

  private _renderDetailPanel() {
    if (!this._inspectedNode) return nothing;
    const node = this._inspectedNode;

    return html`
      <ic-detail-panel
        ?open=${this._detailOpen}
        panelTitle="${node.type === "summary" ? "Summary Detail" : "Message Detail"}"
        @close=${() => { this._detailOpen = false; }}
      >
        <div class="detail-section">
          <div class="detail-label">Content</div>
          <div class="detail-content">${node.content}</div>
        </div>

        ${node.type === "summary" ? html`
          <div class="detail-section">
            <div class="detail-label">Metadata</div>
            <div class="detail-meta-grid">
              ${node.summaryId ? html`<span class="detail-meta-key">ID</span><span class="detail-meta-val">${node.summaryId}</span>` : nothing}
              ${node.kind ? html`<span class="detail-meta-key">Kind</span><span class="detail-meta-val">${node.kind}</span>` : nothing}
              ${node.depth != null ? html`<span class="detail-meta-key">Depth</span><span class="detail-meta-val">${node.depth}</span>` : nothing}
              ${node.tokenCount != null ? html`<span class="detail-meta-key">Tokens</span><span class="detail-meta-val">${node.tokenCount}</span>` : nothing}
              ${node.sourceMessageCount != null ? html`<span class="detail-meta-key">Source Messages</span><span class="detail-meta-val">${node.sourceMessageCount}</span>` : nothing}
              ${node.parentIds ? html`<span class="detail-meta-key">Parents</span><span class="detail-meta-val">${node.parentIds.length > 0 ? node.parentIds.join(", ") : "none"}</span>` : nothing}
              ${node.childIds ? html`<span class="detail-meta-key">Children</span><span class="detail-meta-val">${node.childIds.length > 0 ? node.childIds.join(", ") : "none"}</span>` : nothing}
            </div>
          </div>
        ` : nothing}
      </ic-detail-panel>
    `;
  }

  override render() {
    if (this._loadState === "loading") {
      return html`<ic-loading></ic-loading>`;
    }
    if (this._loadState === "error") {
      return html`<div class="error-msg">Failed to load conversations: ${this._errorMsg}</div>`;
    }

    const hasSelection = this._selectedConvId !== null;

    return html`
      <div class="header-row">
        <span class="header-title">Context DAG Browser</span>
        <span class="header-stats">${this._conversations.length} conversations</span>
      </div>

      <div class="layout ${hasSelection ? "" : "no-tree"}">
        <div class="conv-panel">
          ${this._renderConversationList()}
        </div>

        ${hasSelection ? html`
          <div class="tree-panel">
            <div class="tree-header">
              <span class="tree-title">Summary Tree</span>
              <span class="tree-msg-count">${this._treeMessageCount} messages</span>
            </div>

            <div class="search-section">
              <ic-search-input
                placeholder="Search messages & summaries..."
                debounce="300"
                @search=${this._handleSearch}
              ></ic-search-input>
            </div>

            ${this._searchQuery ? this._renderSearchResults() : this._renderTree()}
          </div>
        ` : nothing}
      </div>

      ${this._renderDetailPanel()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-context-dag-browser": IcContextDagBrowser;
  }
}
