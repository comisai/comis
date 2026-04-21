// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
// Side-effect imports for sub-components
import "../display/ic-connection-dot.js";
import "../display/ic-icon.js";
import "./ic-tag.js";

/** Test result from models.test RPC. */
interface TestResult {
  status: string;
  modelsAvailable?: number;
  validatedModels?: number;
}

/**
 * Provider status card component.
 *
 * Displays an LLM provider's configuration and status with
 * test-connection, edit, and enable/disable toggle actions.
 *
 * @fires test-connection - Fired when the Test button is clicked
 * @fires edit-provider - Fired when the Edit button is clicked
 * @fires toggle-provider - CustomEvent<boolean> fired when enable/disable is toggled
 */
@customElement("ic-provider-card")
export class IcProviderCard extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--ic-space-sm);
      }

      .name {
        font-weight: 600;
        font-size: var(--ic-text-sm);
      }

      .url-row {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .status-row {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      .test-result {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--ic-space-xs) 0;
      }

      .test-result-line {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
      }

      .actions {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        margin-top: var(--ic-space-xs);
      }

      .btn {
        padding: 0.375rem 0.75rem;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-xs);
        font-family: inherit;
        cursor: pointer;
        border: none;
        white-space: nowrap;
      }

      .btn-test {
        background: var(--ic-accent);
        color: white;
      }

      .btn-test:hover:not(:disabled) {
        opacity: 0.9;
      }

      .btn-test:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-edit {
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        color: var(--ic-text-muted);
      }

      .btn-edit:hover {
        background: var(--ic-border);
      }

      .spinner-inline {
        display: inline-block;
        width: 12px;
        height: 12px;
        border: 2px solid var(--ic-border);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .spinner-inline {
          animation: none;
          opacity: 0.7;
        }
      }
    `,
  ];

  /** Provider display name. */
  @property() name = "";

  /** Provider type (anthropic, openai, ollama, etc.). */
  @property() type = "";

  /** API base URL. Shows "Default" if empty. */
  @property() baseUrl = "";

  /** Whether the provider is enabled. */
  @property({ type: Boolean }) enabled = false;

  /** Result from models.test, null when untested. */
  @property({ attribute: false }) testResult: TestResult | null = null;

  /** Whether a test is in progress. */
  @property({ type: Boolean }) testing = false;

  private _onTest(): void {
    this.dispatchEvent(new CustomEvent("test-connection"));
  }

  private _onEdit(): void {
    this.dispatchEvent(new CustomEvent("edit-provider"));
  }

  private _onToggle(e: Event): void {
    const checked = (e.target as HTMLInputElement).checked;
    this.dispatchEvent(
      new CustomEvent("toggle-provider", { detail: checked }),
    );
  }

  private _renderTestResult() {
    if (!this.testResult) return nothing;
    const r = this.testResult;
    return html`
      <div class="test-result">
        <div class="test-result-line">
          <ic-icon
            name=${r.status === "ok" ? "check" : "x"}
            size="12px"
            color=${r.status === "ok" ? "var(--ic-success)" : "var(--ic-error)"}
          ></ic-icon>
          <span>${r.status === "ok" ? "Connection OK" : `Status: ${r.status}`}</span>
        </div>
        ${r.modelsAvailable != null
          ? html`<div class="test-result-line">Models available: ${r.modelsAvailable}</div>`
          : nothing}
        ${r.validatedModels != null
          ? html`<div class="test-result-line">Validated: ${r.validatedModels}</div>`
          : nothing}
      </div>
    `;
  }

  override render() {
    return html`
      <div class="card">
        <div class="header">
          <span class="name">${this.name}</span>
          <ic-tag variant="info">${this.type}</ic-tag>
        </div>
        <div class="url-row">${this.baseUrl || "Default"}</div>
        <div class="status-row">
          <ic-connection-dot
            status=${this.enabled ? "connected" : "disconnected"}
            size="6px"
          ></ic-connection-dot>
          <span>${this.enabled ? "Enabled" : "Disabled"}</span>
          <input
            type="checkbox"
            .checked=${this.enabled}
            @change=${this._onToggle}
            aria-label="Toggle ${this.name}"
            style="margin-left: auto; accent-color: var(--ic-accent); cursor: pointer;"
          />
        </div>
        ${this._renderTestResult()}
        <div class="actions">
          <button
            class="btn btn-test"
            @click=${this._onTest}
            ?disabled=${this.testing}
            aria-label="Test connection for ${this.name}"
          >
            ${this.testing
              ? html`<span class="spinner-inline"></span>`
              : "Test"}
          </button>
          <button
            class="btn btn-edit"
            @click=${this._onEdit}
            aria-label="Edit ${this.name}"
          >
            Edit
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-provider-card": IcProviderCard;
  }
}
