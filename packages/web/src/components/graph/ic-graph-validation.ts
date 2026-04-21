// SPDX-License-Identifier: Apache-2.0
/**
 * Inline validation bar for the graph builder canvas area.
 *
 * Displays real-time DAG validation status at the bottom of the canvas:
 * error count, warning count, and expandable message list.
 * Clicking a message dispatches highlight-nodes for canvas highlighting.
 *
 * Displays real-time validation status with error/warning counts.
 * Clicking a message dispatches highlight-nodes event with nodeIds for canvas highlighting.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";
import type { ValidationResult, ValidationMessage } from "../../api/types/index.js";

@customElement("ic-graph-validation")
export class IcGraphValidation extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        z-index: 10;
        pointer-events: auto;
      }

      .validation-bar {
        background: var(--ic-surface);
        border-top: 1px solid var(--ic-border);
      }

      .status-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 6px 12px;
        min-height: 32px;
        cursor: default;
      }

      .status-icon {
        font-size: 14px;
        line-height: 1;
      }

      .status-icon.valid {
        color: #22c55e;
      }

      .status-icon.invalid {
        color: var(--ic-error);
      }

      .badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        border-radius: 9999px;
        font-size: var(--ic-text-xs);
        cursor: pointer;
        user-select: none;
      }

      .badge:hover {
        filter: brightness(1.2);
      }

      .badge-error {
        background: color-mix(in srgb, var(--ic-error) 15%, transparent);
        color: var(--ic-error);
      }

      .badge-warning {
        background: color-mix(in srgb, #eab308 15%, transparent);
        color: #eab308;
      }

      .valid-text {
        font-size: var(--ic-text-xs);
        color: #22c55e;
      }

      .message-list {
        max-height: 200px;
        overflow-y: auto;
        border-top: 1px solid var(--ic-border);
      }

      .message-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 12px;
        font-size: var(--ic-text-xs);
        cursor: pointer;
        color: var(--ic-text-muted);
      }

      .message-row:hover {
        background: var(--ic-surface-2);
      }

      .message-severity {
        flex-shrink: 0;
        width: 12px;
        text-align: center;
      }

      .message-severity.error {
        color: var(--ic-error);
      }

      .message-severity.warning {
        color: #eab308;
      }

      .message-text {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .message-nodes {
        flex-shrink: 0;
        font-family: var(--ic-font-mono);
        color: var(--ic-text-dim);
      }
    `,
  ];

  /** Validation result from the graph validation engine. */
  @property({ attribute: false })
  validationResult: ValidationResult | null = null;

  @state()
  private _expandErrors = false;

  @state()
  private _expandWarnings = false;

  // -- Event dispatchers ----------------------------------------------------

  private _onMessageClick(msg: ValidationMessage): void {
    if (msg.nodeIds && msg.nodeIds.length > 0) {
      this.dispatchEvent(
        new CustomEvent("highlight-nodes", {
          detail: { nodeIds: msg.nodeIds },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  // -- Render ---------------------------------------------------------------

  override render() {
    if (!this.validationResult) return nothing;

    const { valid, errors, warnings } = this.validationResult;
    const errorCount = errors.length;
    const warningCount = warnings.length;

    return html`
      <div class="validation-bar">
        <div class="status-row">
          ${errorCount > 0
            ? html`<span class="status-icon invalid">\u2716</span>`
            : html`<span class="status-icon valid">\u2714</span>`}
          ${errorCount > 0
            ? html`<span
                class="badge badge-error"
                @click=${() => { this._expandErrors = !this._expandErrors; }}
              >${errorCount} error${errorCount !== 1 ? "s" : ""}</span>`
            : nothing}
          ${warningCount > 0
            ? html`<span
                class="badge badge-warning"
                @click=${() => { this._expandWarnings = !this._expandWarnings; }}
              >${warningCount} warning${warningCount !== 1 ? "s" : ""}</span>`
            : nothing}
          ${valid && warningCount === 0
            ? html`<span class="valid-text">Valid</span>`
            : nothing}
        </div>
        ${this._expandErrors && errorCount > 0
          ? this._renderMessageList(errors)
          : nothing}
        ${this._expandWarnings && warningCount > 0
          ? this._renderMessageList(warnings)
          : nothing}
      </div>
    `;
  }

  private _renderMessageList(messages: ReadonlyArray<ValidationMessage>) {
    return html`
      <div class="message-list">
        ${messages.map(
          (msg) => html`
            <div class="message-row" @click=${() => this._onMessageClick(msg)}>
              <span class="message-severity ${msg.severity}">${msg.severity === "error" ? "\u2716" : "\u26A0"}</span>
              <span class="message-text">${msg.message}</span>
              ${msg.nodeIds && msg.nodeIds.length > 0
                ? html`<span class="message-nodes">${msg.nodeIds.join(", ")}</span>`
                : nothing}
            </div>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-graph-validation": IcGraphValidation;
  }
}
