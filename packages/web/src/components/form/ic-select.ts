import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

/**
 * Styled dropdown select component.
 *
 * Wraps a native `<select>` in a styled container with an associated label.
 * Dispatches `change` CustomEvent with the selected value as detail.
 *
 * @fires change - CustomEvent<string> with the selected value
 *
 * @example
 * ```html
 * <ic-select
 *   label="Profile"
 *   .value=${"full"}
 *   .options=${[{ value: "full", label: "Full" }, { value: "minimal", label: "Minimal" }]}
 *   @change=${(e) => console.log(e.detail)}
 * ></ic-select>
 * ```
 */
@customElement("ic-select")
export class IcSelect extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .select-wrapper {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
      }

      label {
        font-size: var(--ic-text-sm);
        font-weight: 500;
        color: var(--ic-text-muted);
      }

      select {
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
        cursor: pointer;
        appearance: auto;
        transition: border-color var(--ic-transition);
      }

      select:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      select:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ];

  /** Label text displayed above the select. */
  @property() label = "";

  /** Currently selected value. */
  @property() value = "";

  /** Dropdown options. */
  @property({ type: Array }) options: Array<{ value: string; label: string }> = [];

  /** Whether the select is disabled. */
  @property({ type: Boolean }) disabled = false;

  private _onChange(e: Event): void {
    const selected = (e.target as HTMLSelectElement).value;
    this.dispatchEvent(
      new CustomEvent("change", { detail: selected, bubbles: true, composed: true }),
    );
  }

  override render() {
    return html`
      <div class="select-wrapper">
        ${this.label
          ? html`<label>${this.label}</label>`
          : nothing}
        <select
          .value=${this.value}
          ?disabled=${this.disabled}
          aria-label=${this.label || nothing}
          @change=${this._onChange}
        >
          ${this.options.map(
            (opt) => html`<option value=${opt.value} ?selected=${opt.value === this.value}>${opt.label}</option>`,
          )}
        </select>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-select": IcSelect;
  }
}
