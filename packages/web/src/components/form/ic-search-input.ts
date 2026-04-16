import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

/**
 * Debounced search input with clear button.
 *
 * Fires a `search` CustomEvent after the debounce delay elapses.
 * Enter key and the clear button bypass the debounce and fire immediately.
 *
 * @fires search - CustomEvent<string> with the current search value
 *
 * @example
 * ```html
 * <ic-search-input placeholder="Filter agents..." debounce="200" @search=${handler}></ic-search-input>
 * ```
 */
@customElement("ic-search-input")
export class IcSearchInput extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .container {
        position: relative;
        display: flex;
        align-items: center;
      }

      .search-icon {
        position: absolute;
        left: var(--ic-space-sm);
        color: var(--ic-text-dim);
        font-size: var(--ic-text-sm);
        pointer-events: none;
        line-height: 1;
      }

      input {
        width: 100%;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
        padding: var(--ic-space-sm) var(--ic-space-lg);
        padding-left: calc(var(--ic-space-sm) + 1.25rem);
        transition: border-color var(--ic-transition);
      }

      input::placeholder {
        color: var(--ic-text-dim);
      }

      input:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      input:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .clear-btn {
        position: absolute;
        right: var(--ic-space-sm);
        background: none;
        border: none;
        color: var(--ic-text-dim);
        cursor: pointer;
        padding: 2px;
        font-size: var(--ic-text-xs);
        line-height: 1;
        border-radius: var(--ic-radius-sm);
        transition: color var(--ic-transition);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .clear-btn:hover {
        color: var(--ic-text);
      }

      .clear-btn[hidden] {
        display: none;
      }
    `,
  ];

  /** Current search value. */
  @property() value = "";

  /** Placeholder text for the input. */
  @property() placeholder = "Search...";

  /** Debounce delay in milliseconds. */
  @property({ type: Number }) debounce = 300;

  /** Whether the input is disabled. */
  @property({ type: Boolean }) disabled = false;

  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._cancelDebounce();
  }

  private _cancelDebounce(): void {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  private _onInput(e: InputEvent): void {
    const input = e.target as HTMLInputElement;
    this.value = input.value;
    this._cancelDebounce();
    this._debounceTimer = setTimeout(() => {
      this._fireSearch();
    }, this.debounce);
  }

  private _onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      this._cancelDebounce();
      this._fireSearch();
    }
  }

  private _onClear(): void {
    this.value = "";
    this._cancelDebounce();
    this._fireSearch();
    // Re-focus the input after clearing
    const input = this.shadowRoot?.querySelector<HTMLInputElement>("input");
    input?.focus();
  }

  private _fireSearch(): void {
    this.dispatchEvent(
      new CustomEvent("search", { detail: this.value }),
    );
  }

  override render() {
    return html`
      <div class="container">
        <span class="search-icon" aria-hidden="true">\u{1F50D}</span>
        <input
          type="text"
          role="searchbox"
          aria-label="Search"
          .value=${this.value}
          placeholder=${this.placeholder}
          ?disabled=${this.disabled}
          @input=${this._onInput}
          @keydown=${this._onKeyDown}
        />
        <button
          class="clear-btn"
          aria-label="Clear search"
          ?hidden=${!this.value}
          @click=${this._onClear}
        >\u2715</button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-search-input": IcSearchInput;
  }
}
