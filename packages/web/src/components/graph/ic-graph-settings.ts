/**
 * Sticky top settings bar for the graph builder.
 *
 * Renders graph-level settings: label, failure policy, timeout, budget fields,
 * plus Validate and Run action buttons. Dispatches events upward for the
 * pipeline builder to handle.
 *
 * Renders label, failure policy, timeout, and budget fields.
 * Validate button dispatches validate event.
 * Run button is disabled when validation errors exist.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";
import type { GraphSettings } from "../../api/types/index.js";

@customElement("ic-graph-settings")
export class IcGraphSettings extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .settings-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        padding: 8px 12px;
        min-height: 48px;
        background: var(--ic-surface);
        border-bottom: 1px solid var(--ic-border);
      }

      .field {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .field label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
        white-space: nowrap;
      }

      .field input,
      .field select {
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-sm);
        padding: 4px 8px;
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        font-family: inherit;
      }

      .field input:focus,
      .field select:focus {
        border-color: var(--ic-accent);
        outline: none;
      }

      .field-label-input {
        width: 160px;
      }

      .field-number {
        width: 80px;
      }

      .field-cost {
        width: 90px;
      }

      .spacer {
        flex: 1;
      }

      .btn-validate {
        padding: 4px 14px;
        background: var(--ic-accent);
        color: var(--ic-text);
        border: none;
        border-radius: var(--ic-radius-sm);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        white-space: nowrap;
      }

      .btn-validate:hover {
        filter: brightness(1.1);
      }

      .btn-validate:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-save {
        padding: 4px 14px;
        background: var(--ic-surface-2);
        color: var(--ic-text-muted);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-sm);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        white-space: nowrap;
      }
      .btn-save:hover:not(:disabled) {
        background: var(--ic-accent);
        color: var(--ic-text);
        border-color: var(--ic-accent);
      }
      .btn-save:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-run {
        padding: 4px 14px;
        background: #22c55e;
        color: #fff;
        border: none;
        border-radius: var(--ic-radius-sm);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        white-space: nowrap;
      }

      .btn-run:hover:not(:disabled) {
        filter: brightness(1.1);
      }

      .btn-run:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .validate-result {
        width: 100%;
        padding: 4px 12px;
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
      }

      .validate-result.is-error {
        color: var(--ic-error);
      }
    `,
  ];

  /** Current graph settings. */
  @property({ attribute: false })
  settings: GraphSettings = { label: "Untitled Pipeline", onFailure: "fail-fast" };

  /** Whether validation errors exist (disables Run button). */
  @property({ type: Boolean })
  hasErrors = false;

  /** Whether the graph has unsaved changes (controls Save Draft disabled state). */
  @property({ type: Boolean })
  isDirty = false;

  /** Result text from the Validate RPC call. */
  @property()
  validateResult = "";

  @state()
  private _validating = false;

  // -- Event dispatchers ----------------------------------------------------

  private _dispatchSettingsChange(partial: Partial<GraphSettings>): void {
    this.dispatchEvent(
      new CustomEvent("settings-change", {
        detail: partial,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onLabelChange(e: Event): void {
    const value = (e.target as HTMLInputElement).value;
    this._dispatchSettingsChange({ label: value });
  }

  private _onPolicyChange(e: Event): void {
    const value = (e.target as HTMLSelectElement).value as "fail-fast" | "continue";
    this._dispatchSettingsChange({ onFailure: value });
  }

  private _onTimeoutChange(e: Event): void {
    const raw = (e.target as HTMLInputElement).value;
    const ms = raw ? parseInt(raw, 10) : undefined;
    this._dispatchSettingsChange({ timeoutMs: ms && ms > 0 ? ms : undefined });
  }

  private _onMaxTokensChange(e: Event): void {
    const raw = (e.target as HTMLInputElement).value;
    const val = raw ? parseInt(raw, 10) : undefined;
    const current = this.settings.budget ?? {};
    this._dispatchSettingsChange({
      budget: { ...current, maxTokens: val && val > 0 ? val : undefined },
    });
  }

  private _onMaxCostChange(e: Event): void {
    const raw = (e.target as HTMLInputElement).value;
    const val = raw ? parseFloat(raw) : undefined;
    const current = this.settings.budget ?? {};
    this._dispatchSettingsChange({
      budget: { ...current, maxCost: val && val > 0 ? val : undefined },
    });
  }

  private _onValidate(): void {
    this.dispatchEvent(
      new CustomEvent("validate", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onSaveDraft(): void {
    this.dispatchEvent(
      new CustomEvent("save-draft", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onRun(): void {
    this.dispatchEvent(
      new CustomEvent("run", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  // -- Render ---------------------------------------------------------------

  override render() {
    const isError = this.validateResult.startsWith("Error:");

    return html`
      <div class="settings-bar">
        <div class="field">
          <label>Label:</label>
          <input
            class="field-label-input"
            type="text"
            placeholder="Pipeline label"
            .value=${this.settings.label}
            @input=${this._onLabelChange}
          />
        </div>
        <div class="field">
          <label>Policy:</label>
          <select .value=${this.settings.onFailure} @change=${this._onPolicyChange}>
            <option value="fail-fast" ?selected=${this.settings.onFailure === "fail-fast"}>fail-fast</option>
            <option value="continue" ?selected=${this.settings.onFailure === "continue"}>continue</option>
          </select>
        </div>
        <div class="field">
          <label>Timeout:</label>
          <input
            class="field-number"
            type="number"
            min="0"
            placeholder="ms"
            .value=${this.settings.timeoutMs != null ? String(this.settings.timeoutMs) : ""}
            @input=${this._onTimeoutChange}
          />
        </div>
        <div class="field">
          <label>Max Tokens:</label>
          <input
            class="field-number"
            type="number"
            min="0"
            placeholder="0"
            .value=${this.settings.budget?.maxTokens != null ? String(this.settings.budget.maxTokens) : ""}
            @input=${this._onMaxTokensChange}
          />
        </div>
        <div class="field">
          <label>Max Cost:</label>
          <input
            class="field-cost"
            type="number"
            min="0"
            step="0.01"
            placeholder="$0.00"
            .value=${this.settings.budget?.maxCost != null ? String(this.settings.budget.maxCost) : ""}
            @input=${this._onMaxCostChange}
          />
        </div>
        <div class="spacer"></div>
        <button
          class="btn-validate"
          ?disabled=${this._validating}
          @click=${this._onValidate}
        >
          ${this._validating ? "Validating..." : "Validate"}
        </button>
        <button
          class="btn-save"
          ?disabled=${!this.isDirty}
          @click=${this._onSaveDraft}
        >
          Save Draft
        </button>
        <button
          class="btn-run"
          ?disabled=${this.hasErrors}
          title=${this.hasErrors ? "Fix validation errors before running" : "Run pipeline"}
          @click=${this._onRun}
        >
          Run
        </button>
      </div>
      ${this.validateResult
        ? html`<div class="validate-result ${isError ? "is-error" : ""}">${this.validateResult}</div>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-graph-settings": IcGraphSettings;
  }
}
