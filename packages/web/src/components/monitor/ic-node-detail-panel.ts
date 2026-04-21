// SPDX-License-Identifier: Apache-2.0
/**
 * Node detail panel for the execution monitor.
 *
 * 320px right-side panel displaying detailed execution information for a
 * selected node. Shows status, agent/model, run ID, timing, task text,
 * dependency status, output/error text, and steer control.
 *
 * Shows node detail, output display, and steer control.
 *
 * Events dispatched (all CustomEvent, bubbles: true, composed: true):
 * - close:  (no detail) -- when X button clicked
 * - steer:  { runId: string; message: string } -- when steer message sent
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { MonitorNodeState } from "../../api/types/index.js";

// ---------------------------------------------------------------------------
// Status color map (matches canvas node colors)
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  pending: "#6b7280",
  ready: "#a78bfa",
  running: "#06b6d4",
  completed: "#22c55e",
  failed: "#ef4444",
  skipped: "#9ca3af",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ms?: number): string {
  if (ms == null) return "--";
  return new Date(ms).toLocaleTimeString();
}

function formatElapsed(ms?: number): string {
  if (ms == null) return "--";
  const totalSec = ms / 1000;
  if (totalSec >= 60) {
    const min = Math.floor(totalSec / 60);
    const sec = Math.floor(totalSec % 60);
    return `${min}m ${sec.toString().padStart(2, "0")}s`;
  }
  return `${totalSec.toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("ic-node-detail-panel")
export class IcNodeDetailPanel extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
        width: 320px;
        border-left: 1px solid var(--ic-border);
        overflow-y: auto;
        background: var(--ic-surface);
        padding: 16px;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--ic-space-md, 12px);
      }

      .header h3 {
        margin: 0;
        font-size: var(--ic-text-sm, 14px);
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
        min-width: 0;
      }

      .close-btn {
        background: none;
        border: none;
        color: var(--ic-text-muted, #9ca3af);
        cursor: pointer;
        font-size: 18px;
        padding: 4px;
        line-height: 1;
        flex-shrink: 0;
      }
      .close-btn:hover {
        color: var(--ic-text);
      }

      .section-header {
        font-size: var(--ic-text-xs, 11px);
        color: var(--ic-text-dim, #6b7280);
        text-transform: uppercase;
        margin-top: var(--ic-space-md, 12px);
        margin-bottom: var(--ic-space-xs, 4px);
        letter-spacing: 0.05em;
        font-weight: 600;
      }

      .status-badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 9999px;
        font-size: var(--ic-text-xs, 11px);
        font-weight: 600;
        color: #fff;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }

      .retry-badge {
        display: inline-block;
        padding: 2px 6px;
        margin-left: 6px;
        border-radius: 9999px;
        font-size: 10px;
        font-weight: 600;
        color: #f97316;
        background: rgba(249, 115, 22, 0.15);
        text-transform: uppercase;
        letter-spacing: 0.03em;
        vertical-align: middle;
      }

      .field-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 3px 0;
        font-size: var(--ic-text-xs, 11px);
      }

      .field-label {
        color: var(--ic-text-dim, #6b7280);
      }

      .field-value {
        color: var(--ic-text);
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .field-value.mono {
        font-family: var(--ic-font-mono, monospace);
      }

      .task-box {
        background: var(--ic-surface-2, #1e1e2e);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-sm, 4px);
        padding: 8px;
        font-size: var(--ic-text-xs, 11px);
        max-height: 120px;
        overflow-y: auto;
        word-wrap: break-word;
        white-space: pre-wrap;
        line-height: 1.5;
      }

      .dep-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 0;
        font-size: var(--ic-text-xs, 11px);
      }

      .dep-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .dep-label {
        font-family: var(--ic-font-mono, monospace);
      }

      pre.output-block {
        font-family: var(--ic-font-mono, monospace);
        font-size: var(--ic-text-xs, 11px);
        white-space: pre-wrap;
        word-break: break-all;
        background: var(--ic-surface-2, #1e1e2e);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-sm, 4px);
        padding: 8px;
        margin: 4px 0;
        max-height: 200px;
        overflow-y: auto;
        line-height: 1.4;
      }

      pre.error-block {
        font-family: var(--ic-font-mono, monospace);
        font-size: var(--ic-text-xs, 11px);
        white-space: pre-wrap;
        word-break: break-all;
        background: var(--ic-surface-2, #1e1e2e);
        border: 1px solid var(--ic-error, #ef4444);
        border-radius: var(--ic-radius-sm, 4px);
        padding: 8px;
        margin: 4px 0;
        max-height: 200px;
        overflow-y: auto;
        color: var(--ic-error, #ef4444);
        line-height: 1.4;
      }

      .truncated-note {
        font-size: 10px;
        color: var(--ic-text-dim, #6b7280);
        font-style: italic;
        margin-top: 2px;
      }

      .view-full-btn,
      .steer-btn,
      .send-btn,
      .copy-btn,
      .modal-close-btn {
        background: var(--ic-surface-2, #1e1e2e);
        border: 1px solid var(--ic-border);
        color: var(--ic-text);
        padding: 4px 12px;
        border-radius: var(--ic-radius-sm, 4px);
        cursor: pointer;
        font-size: var(--ic-text-xs, 11px);
        margin-top: 4px;
      }
      .view-full-btn:hover,
      .steer-btn:hover,
      .send-btn:hover,
      .copy-btn:hover,
      .modal-close-btn:hover {
        background: var(--ic-border);
      }

      .steer-btn {
        background: var(--ic-accent, #3b82f6);
        border-color: var(--ic-accent, #3b82f6);
        color: #fff;
      }
      .steer-btn:hover {
        opacity: 0.9;
        background: var(--ic-accent, #3b82f6);
      }

      .send-btn {
        background: var(--ic-accent, #3b82f6);
        border-color: var(--ic-accent, #3b82f6);
        color: #fff;
      }
      .send-btn:hover {
        opacity: 0.9;
        background: var(--ic-accent, #3b82f6);
      }

      .steer-area {
        margin-top: 8px;
      }

      .steer-area textarea {
        width: 100%;
        min-height: 60px;
        background: var(--ic-surface-2, #1e1e2e);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-sm, 4px);
        color: var(--ic-text);
        padding: 8px;
        font-family: var(--ic-font-sans);
        font-size: var(--ic-text-xs, 11px);
        resize: vertical;
      }

      .steer-area .send-row {
        display: flex;
        justify-content: flex-end;
        margin-top: 4px;
      }

      /* Modal overlay */
      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.7);
        z-index: 100;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .modal-content {
        background: var(--ic-surface, #181825);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md, 8px);
        max-width: 640px;
        width: 90%;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        padding: 16px;
      }

      .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }

      .modal-header h4 {
        margin: 0;
        font-size: var(--ic-text-sm, 14px);
      }

      .modal-actions {
        display: flex;
        gap: 8px;
      }

      .modal-body {
        overflow-y: auto;
        flex: 1;
        min-height: 0;
      }

      .modal-body pre {
        font-family: var(--ic-font-mono, monospace);
        font-size: var(--ic-text-xs, 11px);
        white-space: pre-wrap;
        word-break: break-all;
        margin: 0;
        line-height: 1.4;
      }

      .empty-state {
        color: var(--ic-text-dim, #6b7280);
        font-size: var(--ic-text-xs, 11px);
        font-style: italic;
        padding: 8px 0;
      }
    `,
  ];

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  @property({ attribute: false }) node: MonitorNodeState | null = null;
  @property({ attribute: false }) allNodes: ReadonlyArray<MonitorNodeState> = [];

  @state() private _showFullOutput = false;
  @state() private _steerMode = false;
  @state() private _steerText = "";

  // ---------------------------------------------------------------------------
  // Event dispatchers
  // ---------------------------------------------------------------------------

  private _dispatchClose(): void {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  private _dispatchSteer(): void {
    const node = this.node;
    if (!node?.runId || !this._steerText.trim()) return;
    this.dispatchEvent(
      new CustomEvent("steer", {
        bubbles: true,
        composed: true,
        detail: { runId: node.runId, message: this._steerText.trim() },
      }),
    );
    this._steerMode = false;
    this._steerText = "";
  }

  // ---------------------------------------------------------------------------
  // Modal handlers
  // ---------------------------------------------------------------------------

  private _openFullOutput(): void {
    this._showFullOutput = true;
  }

  private _closeFullOutput(): void {
    this._showFullOutput = false;
  }

  private async _copyFullOutput(): Promise<void> {
    const text = this.node?.output ?? this.node?.error ?? "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API may not be available in all contexts
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  override render() {
    const node = this.node;
    if (!node) return nothing;

    return html`
      ${this._renderHeader(node)}
      ${this._renderStatus(node)}
      ${this._renderTiming(node)}
      ${this._renderTask(node)}
      ${this._renderDependencies(node)}
      ${this._renderOutput(node)}
      ${this._renderError(node)}
      ${this._renderSteer(node)}
      ${this._showFullOutput ? this._renderModal(node) : nothing}
    `;
  }

  private _renderHeader(node: MonitorNodeState) {
    return html`
      <div class="header">
        <h3 title=${node.id}>${node.id}</h3>
        <button class="close-btn" @click=${this._dispatchClose} title="Close">&times;</button>
      </div>
    `;
  }

  private _renderStatus(node: MonitorNodeState) {
    const color = STATUS_COLORS[node.status] ?? "#6b7280";
    const isRetrying = node.retryAttempt != null && node.retryAttempt > 0;
    return html`
      <div class="section-header">Status</div>
      <div style="margin-bottom: 6px">
        <span class="status-badge" style="background: ${color}">${node.status}</span>
        ${isRetrying
          ? html`<span class="retry-badge">(retrying)</span>`
          : nothing}
      </div>
      ${isRetrying
        ? html`<div class="field-row">
            <span class="field-label">Retry</span>
            <span class="field-value">Attempt ${node.retryAttempt}${node.retriesRemaining != null ? ` (${node.retriesRemaining} remaining)` : ""}</span>
          </div>`
        : nothing}
      ${node.agentId
        ? html`<div class="field-row">
            <span class="field-label">Agent</span>
            <span class="field-value">${node.agentId}</span>
          </div>`
        : nothing}
      ${node.modelId
        ? html`<div class="field-row">
            <span class="field-label">Model</span>
            <span class="field-value">${node.modelId}</span>
          </div>`
        : nothing}
      ${node.runId
        ? html`<div class="field-row">
            <span class="field-label">Run ID</span>
            <span class="field-value mono" title=${node.runId}>${node.runId}</span>
          </div>`
        : nothing}
    `;
  }

  private _renderTiming(node: MonitorNodeState) {
    return html`
      <div class="section-header">Timing</div>
      <div class="field-row">
        <span class="field-label">Started</span>
        <span class="field-value">${formatTimestamp(node.startedAt)}</span>
      </div>
      <div class="field-row">
        <span class="field-label">Completed</span>
        <span class="field-value">${formatTimestamp(node.completedAt)}</span>
      </div>
      <div class="field-row">
        <span class="field-label">Duration</span>
        <span class="field-value">${formatElapsed(node.durationMs)}</span>
      </div>
    `;
  }

  private _renderTask(node: MonitorNodeState) {
    return html`
      <div class="section-header">Task</div>
      <div class="task-box">${node.task}</div>
    `;
  }

  private _renderDependencies(node: MonitorNodeState) {
    if (!node.dependsOn.length) return nothing;

    return html`
      <div class="section-header">Dependencies</div>
      ${node.dependsOn.map((depId) => {
        const depNode = this.allNodes.find((n) => n.id === depId);
        const depStatus = depNode?.status ?? "pending";
        const color = STATUS_COLORS[depStatus] ?? "#6b7280";
        return html`
          <div class="dep-row">
            <span class="dep-dot" style="background: ${color}"></span>
            <span class="dep-label">${depId}</span>
          </div>
        `;
      })}
    `;
  }

  private _renderOutput(node: MonitorNodeState) {
    if (!node.output) return nothing;

    const truncated = node.output.length > 300;
    const display = truncated ? node.output.slice(0, 300) + "..." : node.output;
    const serverTruncated = node.output.endsWith("... [truncated]");

    return html`
      <div class="section-header">Output</div>
      <pre class="output-block">${display}</pre>
      ${serverTruncated
        ? html`<div class="truncated-note">Output may be truncated by server</div>`
        : nothing}
      <button class="view-full-btn" @click=${this._openFullOutput}>View Full Output</button>
    `;
  }

  private _renderError(node: MonitorNodeState) {
    if (!node.error) return nothing;
    return html`
      <div class="section-header">Error</div>
      <pre class="error-block">${node.error}</pre>
    `;
  }

  private _renderSteer(node: MonitorNodeState) {
    if (node.status !== "running" || !node.runId) return nothing;

    return html`
      <div class="section-header">Steer</div>
      ${this._steerMode
        ? html`
            <div class="steer-area">
              <textarea
                placeholder="Enter new instructions..."
                .value=${this._steerText}
                @input=${(e: InputEvent) => {
                  this._steerText = (e.target as HTMLTextAreaElement).value;
                }}
              ></textarea>
              <div class="send-row">
                <button class="send-btn" @click=${this._dispatchSteer}>Send</button>
              </div>
            </div>
          `
        : html`<button class="steer-btn" @click=${() => { this._steerMode = true; }}>Steer</button>`}
    `;
  }

  private _renderModal(node: MonitorNodeState) {
    const text = node.output ?? node.error ?? "";
    const title = node.output ? "Full Output" : "Error Details";

    return html`
      <div class="modal-backdrop" @click=${this._closeFullOutput}>
        <div class="modal-content" @click=${(e: Event) => e.stopPropagation()}>
          <div class="modal-header">
            <h4>${title} - ${node.id}</h4>
            <div class="modal-actions">
              <button class="copy-btn" @click=${this._copyFullOutput}>Copy</button>
              <button class="modal-close-btn" @click=${this._closeFullOutput}>Close</button>
            </div>
          </div>
          <div class="modal-body">
            <pre>${text}</pre>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-node-detail-panel": IcNodeDetailPanel;
  }
}
