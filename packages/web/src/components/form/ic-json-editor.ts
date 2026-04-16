import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

/**
 * Key-value editor for Record<string, string> fields.
 *
 * Renders existing key-value pairs with remove buttons and provides
 * a bottom row for adding new pairs. Rejects empty or duplicate keys
 * with an inline error message.
 *
 * @fires change - CustomEvent<Record<string, string>> with the updated record
 *
 * @example
 * ```html
 * <ic-json-editor
 *   label="Permissions"
 *   .value=${{ read: "allow", write: "deny" }}
 *   @change=${(e) => this._permissions = e.detail}
 * ></ic-json-editor>
 * ```
 */
@customElement("ic-json-editor")
export class IcJsonEditor extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .editor-label {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-muted);
        margin-bottom: var(--ic-space-sm);
      }

      .pair-list {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
        margin-bottom: var(--ic-space-sm);
      }

      .pair-row {
        display: grid;
        grid-template-columns: 1fr 1fr auto;
        gap: var(--ic-space-xs);
        align-items: center;
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-xs) var(--ic-space-sm);
      }

      .pair-key,
      .pair-value {
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        word-break: break-all;
      }

      .pair-key {
        font-weight: 500;
      }

      .pair-value {
        color: var(--ic-text-muted);
      }

      .remove-btn {
        background: none;
        border: none;
        color: var(--ic-text-dim);
        cursor: pointer;
        padding: 2px 4px;
        font-size: var(--ic-text-xs);
        line-height: 1;
        border-radius: var(--ic-radius-sm);
      }

      .remove-btn:hover {
        color: var(--ic-error);
      }

      .add-row {
        display: grid;
        grid-template-columns: 1fr 1fr auto;
        gap: var(--ic-space-xs);
        align-items: center;
      }

      .add-input {
        padding: 0.375rem 0.5rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
      }

      .add-input:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .add-input::placeholder {
        color: var(--ic-text-dim);
      }

      .add-btn {
        padding: 0.375rem 0.75rem;
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        white-space: nowrap;
      }

      .add-btn:hover {
        opacity: 0.9;
      }

      .error-text {
        color: var(--ic-error);
        font-size: var(--ic-text-xs);
        margin-top: var(--ic-space-xs);
      }
    `,
  ];

  /** Label text displayed above the editor. */
  @property() label = "";

  /** Current key-value record. */
  @property({ type: Object }) value: Record<string, string> = {};

  @state() private _newKey = "";
  @state() private _newValue = "";
  @state() private _error = "";

  private _addPair(): void {
    const key = this._newKey.trim();
    const val = this._newValue.trim();

    if (!key) {
      this._error = "Key cannot be empty";
      return;
    }

    if (key in this.value) {
      this._error = `Key "${key}" already exists`;
      return;
    }

    this._error = "";
    const updated = { ...this.value, [key]: val };
    this._newKey = "";
    this._newValue = "";
    this.dispatchEvent(
      new CustomEvent("change", { detail: updated, bubbles: true, composed: true }),
    );
  }

  private _removePair(key: string): void {
    const updated = { ...this.value };
    delete updated[key];
    this.dispatchEvent(
      new CustomEvent("change", { detail: updated, bubbles: true, composed: true }),
    );
  }

  private _onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      this._addPair();
    }
  }

  override render() {
    const entries = Object.entries(this.value);

    return html`
      ${this.label
        ? html`<div class="editor-label">${this.label}</div>`
        : nothing}
      ${entries.length > 0
        ? html`
            <div class="pair-list">
              ${entries.map(
                ([key, val]) => html`
                  <div class="pair-row">
                    <span class="pair-key">${key}</span>
                    <span class="pair-value">${val}</span>
                    <button
                      class="remove-btn"
                      aria-label="Remove ${key}"
                      @click=${() => this._removePair(key)}
                    >\u2715</button>
                  </div>
                `,
              )}
            </div>
          `
        : nothing}
      <div class="add-row">
        <input
          class="add-input"
          type="text"
          placeholder="Key"
          .value=${this._newKey}
          @input=${(e: Event) => { this._newKey = (e.target as HTMLInputElement).value; }}
          @keydown=${this._onKeyDown}
        />
        <input
          class="add-input"
          type="text"
          placeholder="Value"
          .value=${this._newValue}
          @input=${(e: Event) => { this._newValue = (e.target as HTMLInputElement).value; }}
          @keydown=${this._onKeyDown}
        />
        <button class="add-btn" @click=${() => this._addPair()}>Add</button>
      </div>
      ${this._error
        ? html`<div class="error-text">${this._error}</div>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-json-editor": IcJsonEditor;
  }
}
