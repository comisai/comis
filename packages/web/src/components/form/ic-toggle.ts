import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

/**
 * Boolean toggle switch component.
 *
 * Renders a styled toggle switch with an associated label.
 * Supports keyboard interaction (Space/Enter) and dispatches
 * `change` CustomEvent with a boolean detail.
 *
 * @fires change - CustomEvent<boolean> with the new checked state
 *
 * @example
 * ```html
 * <ic-toggle label="Enable feature" .checked=${true} @change=${handler}></ic-toggle>
 * ```
 */
@customElement("ic-toggle")
export class IcToggle extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-sm);
      }

      .toggle-label {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        cursor: pointer;
        user-select: none;
      }

      .toggle-label[data-disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .track {
        position: relative;
        width: 36px;
        height: 20px;
        border-radius: 10px;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        cursor: pointer;
        transition: background var(--ic-transition), border-color var(--ic-transition);
        flex-shrink: 0;
      }

      .track[data-checked] {
        background: var(--ic-accent);
        border-color: var(--ic-accent);
      }

      .track[data-disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .track:focus-visible {
        outline: 2px solid var(--ic-accent);
        outline-offset: 2px;
      }

      .thumb {
        position: absolute;
        top: 1px;
        left: 1px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--ic-text);
        transition: transform var(--ic-transition);
      }

      .track[data-checked] .thumb {
        transform: translateX(16px);
      }
    `,
  ];

  /** Label text displayed next to the toggle. */
  @property() label = "";

  /** Whether the toggle is checked (on). */
  @property({ type: Boolean }) checked = false;

  /** Whether the toggle is disabled. */
  @property({ type: Boolean }) disabled = false;

  private _toggle(): void {
    if (this.disabled) return;
    this.checked = !this.checked;
    this.dispatchEvent(
      new CustomEvent("change", { detail: this.checked, bubbles: true, composed: true }),
    );
  }

  private _onKeyDown(e: KeyboardEvent): void {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      this._toggle();
    }
  }

  override render() {
    return html`
      ${this.label
        ? html`<span class="toggle-label" ?data-disabled=${this.disabled} @click=${() => this._toggle()}>${this.label}</span>`
        : nothing}
      <div
        class="track"
        role="switch"
        tabindex=${this.disabled ? -1 : 0}
        aria-checked=${this.checked ? "true" : "false"}
        aria-label=${this.label || nothing}
        ?data-checked=${this.checked}
        ?data-disabled=${this.disabled}
        @click=${() => this._toggle()}
        @keydown=${this._onKeyDown}
      >
        <div class="thumb"></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-toggle": IcToggle;
  }
}
