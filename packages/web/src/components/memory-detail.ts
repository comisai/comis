import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { MemoryEntry } from "../api/types/index.js";
import "./data/ic-tag.js";

/**
 * Memory detail panel content showing full entry information.
 *
 * Displays: ID, score, full content, classification, agent, source,
 * tags, embedding status, timestamps, and a delete action button.
 *
 * Designed to be used as content inside an `<ic-detail-panel>`.
 *
 * @fires delete-requested - CustomEvent<string> with entry ID when delete is requested
 * @fires close - CustomEvent when close is requested
 */
@customElement("ic-memory-detail")
export class IcMemoryDetail extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .detail-section {
        margin-bottom: var(--ic-space-lg);
      }

      .detail-label {
        font-size: var(--ic-text-xs);
        font-weight: 600;
        color: var(--ic-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: var(--ic-space-xs);
      }

      .detail-value {
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        line-height: 1.5;
      }

      .detail-id {
        font-family: var(--ic-font-mono);
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
        background: var(--ic-bg);
        padding: var(--ic-space-xs) var(--ic-space-sm);
        border-radius: var(--ic-radius-sm);
        word-break: break-all;
      }

      .score-display {
        font-family: var(--ic-font-mono);
        font-size: var(--ic-text-2xl);
        font-weight: 700;
        color: var(--ic-warning);
      }

      .content-block {
        background: var(--ic-bg);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 16rem;
        overflow-y: auto;
      }

      .badges-row {
        display: flex;
        gap: var(--ic-space-sm);
        flex-wrap: wrap;
      }

      .tags-list {
        display: flex;
        gap: var(--ic-space-xs);
        flex-wrap: wrap;
      }

      .embedding-status {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        font-size: var(--ic-text-sm);
      }

      .embedding-icon {
        font-size: var(--ic-text-base);
      }

      .embedding-icon--yes {
        color: var(--ic-success);
      }

      .embedding-icon--no {
        color: var(--ic-text-dim);
      }

      .embedding-dims {
        color: var(--ic-text-muted);
        font-family: var(--ic-font-mono);
        font-size: var(--ic-text-xs);
      }

      .timestamp-value {
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
      }

      .delete-btn {
        width: 100%;
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: transparent;
        border: 1px solid var(--ic-error);
        border-radius: var(--ic-radius-md);
        color: var(--ic-error);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        transition: background var(--ic-transition), color var(--ic-transition);
      }

      .delete-btn:hover {
        background: var(--ic-error);
        color: var(--ic-text);
      }

      .empty-state {
        color: var(--ic-text-dim);
        font-size: var(--ic-text-sm);
        text-align: center;
        padding: var(--ic-space-xl);
      }
    `,
  ];

  /** The memory entry to display. */
  @property({ attribute: false }) entry: MemoryEntry | null = null;

  private _typeVariant(memoryType: string): string {
    const key = (memoryType ?? "").toLowerCase();
    if (key === "working" || key === "episodic") return "info";
    if (key === "semantic") return "success";
    if (key === "procedural") return "warning";
    return "default";
  }

  private _trustVariant(trustLevel: string): string {
    const key = (trustLevel ?? "").toLowerCase();
    if (key === "system") return "success";
    if (key === "learned") return "info";
    if (key === "external") return "warning";
    return "default";
  }

  private _formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  private _handleDelete(): void {
    if (!this.entry) return;
    this.dispatchEvent(
      new CustomEvent("delete-requested", {
        detail: this.entry.id,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _handleClose(): void {
    this.dispatchEvent(
      new CustomEvent("close", { bubbles: true, composed: true }),
    );
  }

  override render() {
    if (!this.entry) {
      return html`<div class="empty-state">No entry selected</div>`;
    }

    const entry = this.entry;

    return html`
      <!-- ID -->
      <div class="detail-section">
        <div class="detail-label">ID</div>
        <div class="detail-id">${entry.id}</div>
      </div>

      <!-- Score (only if present) -->
      ${entry.score !== undefined && entry.score !== null
        ? html`
            <div class="detail-section">
              <div class="detail-label">Relevance Score</div>
              <div class="score-display">${entry.score.toFixed(4)}</div>
            </div>
          `
        : nothing}

      <!-- Content -->
      <div class="detail-section">
        <div class="detail-label">Content</div>
        <div class="content-block">${entry.content}</div>
      </div>

      <!-- Classification -->
      <div class="detail-section">
        <div class="detail-label">Classification</div>
        <div class="badges-row">
          <ic-tag variant=${this._typeVariant(entry.memoryType)}>${entry.memoryType}</ic-tag>
          <ic-tag variant=${this._trustVariant(entry.trustLevel)}>${entry.trustLevel}</ic-tag>
        </div>
      </div>

      <!-- Agent -->
      <div class="detail-section">
        <div class="detail-label">Agent</div>
        <div class="detail-value">${entry.agentId}</div>
      </div>

      <!-- Source (if available) -->
      ${entry.source
        ? html`
            <div class="detail-section">
              <div class="detail-label">Source</div>
              <div class="detail-value">${entry.source}</div>
            </div>
          `
        : nothing}

      <!-- Tags (if present) -->
      ${entry.tags && entry.tags.length > 0
        ? html`
            <div class="detail-section">
              <div class="detail-label">Tags</div>
              <div class="tags-list">
                ${entry.tags.map(
                  (tag) => html`<ic-tag variant="default">${tag}</ic-tag>`,
                )}
              </div>
            </div>
          `
        : nothing}

      <!-- Embedding status -->
      <div class="detail-section">
        <div class="detail-label">Embedding</div>
        <div class="embedding-status">
          ${entry.hasEmbedding
            ? html`
                <span class="embedding-icon embedding-icon--yes">&#x2713;</span>
                <span>Indexed</span>
                ${entry.embeddingDims
                  ? html`<span class="embedding-dims">(${entry.embeddingDims} dims)</span>`
                  : nothing}
              `
            : html`
                <span class="embedding-icon embedding-icon--no">&#x2717;</span>
                <span>Not indexed</span>
              `}
        </div>
      </div>

      <!-- Created timestamp -->
      <div class="detail-section">
        <div class="detail-label">Created</div>
        <div class="timestamp-value">${this._formatTimestamp(entry.createdAt)}</div>
      </div>

      <!-- Updated timestamp (if exists) -->
      ${entry.updatedAt
        ? html`
            <div class="detail-section">
              <div class="detail-label">Updated</div>
              <div class="timestamp-value">${this._formatTimestamp(entry.updatedAt)}</div>
            </div>
          `
        : nothing}

      <!-- Delete button -->
      <div class="detail-section">
        <button class="delete-btn" @click=${this._handleDelete}>
          Delete Entry
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-memory-detail": IcMemoryDetail;
  }
}
