// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

/**
 * Masked input with SecretRef format hint.
 *
 * Renders a password input with a toggle-visibility button and a hint
 * showing the expected SecretRef format (env:VAR_NAME or file:/path).
 *
 * @fires change - CustomEvent<string> with the input value
 *
 * @example
 * ```html
 * <ic-secret-input
 *   label="API Key"
 *   .value=${this._apiKey}
 *   @change=${(e) => this._apiKey = e.detail}
 * ></ic-secret-input>
 * ```
 */
@customElement("ic-secret-input")
export class IcSecretInput extends LitElement {
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
        font-weight: 500;
        color: var(--ic-text-muted);
      }

      .input-row {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
      }

      input {
        flex: 1;
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
        transition: border-color var(--ic-transition);
      }

      input:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      input::placeholder {
        color: var(--ic-text-dim);
      }

      input:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .toggle-btn {
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text-dim);
        cursor: pointer;
        padding: 0.5rem;
        font-size: var(--ic-text-sm);
        line-height: 1;
        flex-shrink: 0;
      }

      .toggle-btn:hover {
        color: var(--ic-text);
      }

      .hint {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        font-style: italic;
      }
    `,
  ];

  /** Label text displayed above the input. */
  @property() label = "";

  /** Current input value. */
  @property() value = "";

  /** Placeholder text. */
  @property() placeholder = "env:SECRET_NAME or file:/path";

  /** Whether the input is disabled. */
  @property({ type: Boolean }) disabled = false;

  @state() private _visible = false;

  private _onInput(e: Event): void {
    const val = (e.target as HTMLInputElement).value;
    this.dispatchEvent(
      new CustomEvent("change", { detail: val, bubbles: true, composed: true }),
    );
  }

  private _toggleVisibility(): void {
    this._visible = !this._visible;
  }

  override render() {
    return html`
      <div class="field-wrapper">
        ${this.label
          ? html`<label>${this.label}</label>`
          : nothing}
        <div class="input-row">
          <input
            type=${this._visible ? "text" : "password"}
            .value=${this.value}
            placeholder=${this.placeholder}
            ?disabled=${this.disabled}
            @input=${this._onInput}
          />
          <button
            class="toggle-btn"
            type="button"
            aria-label=${this._visible ? "Hide value" : "Show value"}
            @click=${this._toggleVisibility}
          >${this._visible ? "\u{1F648}" : "\u{1F441}"}</button>
        </div>
        <span class="hint">Format: env:VAR_NAME or file:/path/to/secret</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-secret-input": IcSecretInput;
  }
}
