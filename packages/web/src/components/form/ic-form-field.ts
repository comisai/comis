// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

/**
 * Label + input + validation error component.
 *
 * Renders a form field with a label, an input or select element,
 * and an optional inline validation error message.
 *
 * @fires field-change - Fires with the new value on input/change
 *
 * @example
 * ```html
 * <ic-form-field
 *   label="Email"
 *   type="email"
 *   value=${this._email}
 *   error=${this._emailError}
 *   required
 *   @field-change=${(e) => this._email = e.detail}
 * ></ic-form-field>
 * ```
 */
@customElement("ic-form-field")
export class IcFormField extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .field-wrapper {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
      }

      label {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        font-weight: 500;
      }

      .required-indicator {
        color: var(--ic-error);
        margin-left: 2px;
      }

      input,
      select {
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm) var(--ic-space-md);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        transition: border-color var(--ic-transition);
        width: 100%;
      }

      input::placeholder {
        color: var(--ic-text-dim);
      }

      input:focus,
      select:focus {
        border-color: var(--ic-accent);
        outline: none;
      }

      input.has-error,
      select.has-error {
        border-color: var(--ic-error);
      }

      input:disabled,
      select:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      select {
        appearance: auto;
        cursor: pointer;
      }

      .error-message {
        font-size: var(--ic-text-xs);
        color: var(--ic-error);
      }
    `,
  ];

  /** Field label text */
  @property() label = "";

  /** Input type (text, email, number, date, select) */
  @property() type = "text";

  /** Current value */
  @property() value = "";

  /** Placeholder text */
  @property() placeholder = "";

  /** Validation error message (empty = no error) */
  @property() error = "";

  /** Whether the field is required */
  @property({ type: Boolean }) required = false;

  /** Whether the field is disabled */
  @property({ type: Boolean }) disabled = false;

  /** Options for type="select" */
  @property({ type: Array }) options: Array<{ value: string; label: string }> = [];

  private _handleInput(e: Event): void {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    this.dispatchEvent(
      new CustomEvent("field-change", {
        detail: target.value,
        bubbles: true,
      }),
    );
  }

  override render() {
    const hasError = this.error.length > 0;
    const errorId = `error-${this.label.toLowerCase().replace(/\s+/g, "-")}`;

    return html`
      <div class="field-wrapper">
        <label>
          ${this.label}
          ${this.required
            ? html`<span class="required-indicator" aria-hidden="true">*</span>`
            : nothing}
        </label>
        ${this.type === "select" ? this._renderSelect(hasError, errorId) : this._renderInput(hasError, errorId)}
        ${hasError
          ? html`<span class="error-message" id=${errorId} role="alert">${this.error}</span>`
          : nothing}
      </div>
    `;
  }

  private _renderInput(hasError: boolean, errorId: string) {
    return html`
      <input
        type=${this.type}
        .value=${this.value}
        placeholder=${this.placeholder || nothing}
        ?required=${this.required}
        ?disabled=${this.disabled}
        class=${hasError ? "has-error" : ""}
        aria-invalid=${hasError ? "true" : "false"}
        aria-describedby=${hasError ? errorId : nothing}
        @input=${this._handleInput}
      />
    `;
  }

  private _renderSelect(hasError: boolean, errorId: string) {
    return html`
      <select
        .value=${this.value}
        ?required=${this.required}
        ?disabled=${this.disabled}
        class=${hasError ? "has-error" : ""}
        aria-invalid=${hasError ? "true" : "false"}
        aria-describedby=${hasError ? errorId : nothing}
        @change=${this._handleInput}
      >
        ${this.options.map(
          (opt) => html`
            <option value=${opt.value} ?selected=${opt.value === this.value}>
              ${opt.label}
            </option>
          `,
        )}
      </select>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-form-field": IcFormField;
  }
}
