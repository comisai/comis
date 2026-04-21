// SPDX-License-Identifier: Apache-2.0
/**
 * Variable prompt modal for pipeline execution.
 *
 * When a pipeline contains `${VAR_NAME}` placeholders in task texts,
 * this modal prompts the user for values before execution. Follows
 * the same modal pattern as ic-confirm-dialog and ic-template-picker:
 * fixed backdrop, centered dialog, focus trap, Escape to close,
 * backdrop click to close.
 *
 * @fires confirm - User clicked Run with all values filled.
 *   Detail: { values: Record<string, string> }
 * @fires cancel - User dismissed the modal.
 *
 * @example
 * ```html
 * <ic-variable-prompt
 *   ?open=${this._showVariablePrompt}
 *   .variables=${["TICKER", "BRAND"]}
 *   .pipelineLabel=${"My Pipeline"}
 *   @confirm=${this._onVariableConfirm}
 *   @cancel=${() => { this._showVariablePrompt = false; }}
 * ></ic-variable-prompt>
 * ```
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

@customElement("ic-variable-prompt")
export class IcVariablePrompt extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: contents;
      }

      .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .dialog {
        max-width: 28rem;
        width: calc(100% - var(--ic-space-lg) * 2);
        max-height: calc(100vh - var(--ic-space-lg) * 2);
        overflow-y: auto;
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-lg);
        box-shadow: var(--ic-shadow-lg);
      }

      .title {
        font-size: var(--ic-text-lg);
        font-weight: 600;
        color: var(--ic-text);
        margin: 0 0 var(--ic-space-md) 0;
      }

      .field {
        margin-bottom: var(--ic-space-md);
      }

      .field-label {
        display: block;
        font-size: var(--ic-text-sm);
        font-weight: 500;
        color: var(--ic-text-muted);
        margin-bottom: 4px;
      }

      .field-input {
        width: 100%;
        padding: 8px 12px;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        font-family: inherit;
      }

      .field-input:focus {
        border-color: var(--ic-accent);
        outline: none;
      }

      .field-input::placeholder {
        color: var(--ic-text-dim);
      }

      .buttons {
        display: flex;
        justify-content: flex-end;
        gap: var(--ic-space-sm);
        margin-top: var(--ic-space-lg);
      }

      button {
        padding: var(--ic-space-sm) var(--ic-space-md);
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        transition: background var(--ic-transition), border-color var(--ic-transition);
      }

      .cancel-btn {
        background: transparent;
        border: 1px solid var(--ic-border);
        color: var(--ic-text-muted);
      }

      .cancel-btn:hover {
        border-color: var(--ic-text-dim);
        color: var(--ic-text);
      }

      .run-btn {
        background: var(--ic-accent);
        border: 1px solid var(--ic-accent);
        color: #fff;
      }

      .run-btn:hover {
        background: var(--ic-accent-hover);
      }

      .run-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .run-btn:disabled:hover {
        background: var(--ic-accent);
      }
    `,
  ];

  // -------------------------------------------------------------------------
  // Properties
  // -------------------------------------------------------------------------

  /** Whether the modal is visible. */
  @property({ type: Boolean, reflect: true }) open = false;

  /** Variable names to prompt for. */
  @property({ type: Array }) variables: string[] = [];

  /** Pipeline label for the title. */
  @property() pipelineLabel = "";

  // -------------------------------------------------------------------------
  // Internal state
  // -------------------------------------------------------------------------

  @state() private _values: Record<string, string> = {};

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("open") && this.open) {
      // Reset values when modal opens
      this._values = {};
      for (const v of this.variables) {
        this._values[v] = "";
      }

      // Focus first input after render
      this.updateComplete.then(() => {
        const firstInput = this.shadowRoot?.querySelector<HTMLInputElement>(".field-input");
        firstInput?.focus();
      });
    }
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private _onBackdropClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).classList.contains("backdrop")) {
      this._fireCancel();
    }
  }

  private _onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      this._fireCancel();
      return;
    }

    // Focus trap: Tab/Shift+Tab cycle within dialog
    if (e.key === "Tab") {
      const focusable = this.shadowRoot?.querySelectorAll<HTMLElement>(
        "input:not([disabled]), button:not([disabled])",
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = this.shadowRoot?.activeElement;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  private _onInput(varName: string, e: InputEvent): void {
    const value = (e.target as HTMLInputElement).value;
    this._values = { ...this._values, [varName]: value };
  }

  private _fireConfirm(): void {
    // Trim all values before dispatching
    const trimmed: Record<string, string> = {};
    for (const [key, val] of Object.entries(this._values)) {
      trimmed[key] = val.trim();
    }
    this.dispatchEvent(
      new CustomEvent("confirm", {
        detail: { values: trimmed },
      }),
    );
  }

  private _fireCancel(): void {
    this.dispatchEvent(new CustomEvent("cancel"));
  }

  // -------------------------------------------------------------------------
  // Computed
  // -------------------------------------------------------------------------

  private get _allFilled(): boolean {
    return this.variables.every((v) => (this._values[v] ?? "").trim().length > 0);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  override render() {
    if (!this.open) return nothing;

    const title = this.pipelineLabel ? `Run: ${this.pipelineLabel}` : "Run Pipeline";

    return html`
      <div
        class="backdrop"
        @click=${this._onBackdropClick}
        @keydown=${this._onKeyDown}
      >
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="variable-prompt-title"
        >
          <h2 class="title" id="variable-prompt-title">${title}</h2>
          ${this.variables.map(
            (varName) => html`
              <div class="field">
                <label class="field-label">${varName}</label>
                <input
                  class="field-input"
                  type="text"
                  placeholder="Enter value..."
                  .value=${this._values[varName] ?? ""}
                  @input=${(e: InputEvent) => this._onInput(varName, e)}
                />
              </div>
            `,
          )}
          <div class="buttons">
            <button class="cancel-btn" @click=${this._fireCancel}>Cancel</button>
            <button
              class="run-btn"
              ?disabled=${!this._allFilled}
              @click=${this._fireConfirm}
            >
              Run
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-variable-prompt": IcVariablePrompt;
  }
}
