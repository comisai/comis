// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

/** Option definition for a filter chip. */
export interface FilterChipOption {
  readonly value: string;
  readonly label: string;
  readonly color?: string;
}

/**
 * Toggle chip group for multi-select filtering.
 *
 * Renders an "All" chip plus one chip per option. Clicking chips
 * toggles selection and dispatches a `filter-change` event with
 * the updated selected set.
 *
 * @fires filter-change - Dispatched when selection changes. `detail.selected` contains the Set of selected values.
 *
 * @example
 * ```html
 * <ic-filter-chips
 *   .options=${[
 *     { value: "telegram", label: "Telegram", color: "var(--ic-telegram)" },
 *     { value: "discord", label: "Discord", color: "var(--ic-discord)" },
 *   ]}
 *   .selected=${new Set(["telegram"])}
 *   @filter-change=${(e) => console.log(e.detail.selected)}
 * ></ic-filter-chips>
 * ```
 */
@customElement("ic-filter-chips")
export class IcFilterChips extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--ic-space-xs);
      }

      .chip {
        border-radius: 9999px;
        padding: 0.25rem 0.75rem;
        font-size: var(--ic-text-xs);
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
        line-height: 1.5;
      }

      .chip--unselected {
        background: transparent;
        color: var(--ic-text-dim);
        border: 1px solid var(--ic-border);
      }

      .chip--unselected:hover {
        border-color: var(--ic-text-dim);
      }
    `,
  ];

  /** Available filter options. */
  @property({ attribute: false }) options: FilterChipOption[] = [];

  /** Currently selected values. */
  @property({ attribute: false }) selected: Set<string> = new Set();

  private _toggleChip(value: string): void {
    const next = new Set(this.selected);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    this.selected = next;
    this.dispatchEvent(
      new CustomEvent("filter-change", {
        detail: { selected: next },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _toggleAll(): void {
    const allSelected = this.options.every((o) => this.selected.has(o.value));
    const next = allSelected ? new Set<string>() : new Set(this.options.map((o) => o.value));
    this.selected = next;
    this.dispatchEvent(
      new CustomEvent("filter-change", {
        detail: { selected: next },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _renderChip(
    label: string,
    isSelected: boolean,
    onClick: () => void,
    chipColor?: string,
  ) {
    if (isSelected) {
      const color = chipColor ?? "var(--ic-accent)";
      return html`
        <button
          class="chip"
          style="background: ${color}33; color: ${color}; border: 1px solid ${color};"
          @click=${onClick}
        >
          ${label}
        </button>
      `;
    }

    return html`
      <button class="chip chip--unselected" @click=${onClick}>
        ${label}
      </button>
    `;
  }

  override render() {
    const allSelected =
      this.options.length > 0 && this.options.every((o) => this.selected.has(o.value));

    return html`
      <div class="chips">
        ${this._renderChip("All", allSelected, () => this._toggleAll())}
        ${this.options.map((opt) =>
          this._renderChip(
            opt.label,
            this.selected.has(opt.value),
            () => this._toggleChip(opt.value),
            opt.color,
          ),
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-filter-chips": IcFilterChips;
  }
}
