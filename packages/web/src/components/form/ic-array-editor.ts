// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

/**
 * Array item editor with add/remove functionality.
 *
 * Renders a list of string items with individual remove buttons
 * and an input row for adding new items. Dispatches `change`
 * CustomEvent with the updated string array.
 *
 * @fires change - CustomEvent<string[]> with the updated items array
 *
 * @example
 * ```html
 * <ic-array-editor
 *   label="Allowed Origins"
 *   .items=${["http://localhost:3000", "https://example.com"]}
 *   placeholder="Add origin..."
 *   @change=${(e) => this._origins = e.detail}
 * ></ic-array-editor>
 * ```
 */
@customElement("ic-array-editor")
export class IcArrayEditor extends LitElement {
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

      .item-list {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
        margin-bottom: var(--ic-space-sm);
      }

      .item-row {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-xs) var(--ic-space-sm);
      }

      .item-text {
        flex: 1;
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        word-break: break-all;
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
        display: flex;
        gap: var(--ic-space-xs);
      }

      .add-input {
        flex: 1;
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
    `,
  ];

  /** Label text displayed above the editor. */
  @property() label = "";

  /** Current array of items. */
  @property({ type: Array }) items: string[] = [];

  /** Placeholder text for the add input. */
  @property() placeholder = "Add item...";

  @state() private _inputValue = "";

  private _addItem(): void {
    const trimmed = this._inputValue.trim();
    if (!trimmed) return;
    const newItems = [...this.items, trimmed];
    this._inputValue = "";
    this.dispatchEvent(
      new CustomEvent("change", { detail: newItems, bubbles: true, composed: true }),
    );
  }

  private _removeItem(index: number): void {
    const newItems = this.items.filter((_, i) => i !== index);
    this.dispatchEvent(
      new CustomEvent("change", { detail: newItems, bubbles: true, composed: true }),
    );
  }

  private _onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      this._addItem();
    }
  }

  override render() {
    return html`
      ${this.label
        ? html`<div class="editor-label">${this.label}</div>`
        : nothing}
      ${this.items.length > 0
        ? html`
            <div class="item-list">
              ${this.items.map(
                (item, idx) => html`
                  <div class="item-row">
                    <span class="item-text">${item}</span>
                    <button
                      class="remove-btn"
                      aria-label="Remove ${item}"
                      @click=${() => this._removeItem(idx)}
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
          placeholder=${this.placeholder}
          .value=${this._inputValue}
          @input=${(e: Event) => { this._inputValue = (e.target as HTMLInputElement).value; }}
          @keydown=${this._onKeyDown}
        />
        <button class="add-btn" @click=${() => this._addItem()}>Add</button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-array-editor": IcArrayEditor;
  }
}
