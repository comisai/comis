import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { TimeRangePreset } from "../../api/types/index.js";

export type { TimeRangePreset };

/** Default time range presets. */
const DEFAULT_PRESETS: TimeRangePreset[] = [
  { label: "Today", sinceMs: 86_400_000 },
  { label: "7d", sinceMs: 604_800_000 },
  { label: "30d", sinceMs: 2_592_000_000 },
  { label: "Custom", sinceMs: 0 },
];

/**
 * Date range selector with preset buttons and custom date inputs.
 *
 * Renders a row of pill-shaped preset buttons (Today, 7d, 30d, Custom).
 * When "Custom" is selected, two date input fields appear below. Each
 * selection dispatches a `time-range-change` CustomEvent with sinceMs
 * and label.
 *
 * @fires time-range-change - Dispatched when a preset or custom range is selected. `detail` contains `{ sinceMs, label }`.
 *
 * @example
 * ```html
 * <ic-time-range-picker
 *   selected="7d"
 *   @time-range-change=${(e) => console.log(e.detail)}
 * ></ic-time-range-picker>
 * ```
 */
@customElement("ic-time-range-picker")
export class IcTimeRangePicker extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .presets {
        display: flex;
        flex-wrap: wrap;
        gap: var(--ic-space-xs);
      }

      .preset {
        border-radius: 9999px;
        padding: 0.25rem 0.75rem;
        font-size: var(--ic-text-xs);
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
        line-height: 1.5;
      }

      .preset--active {
        background: var(--ic-accent);
        color: var(--ic-bg, #0f172a);
        border: 1px solid var(--ic-accent);
      }

      .preset--inactive {
        background: transparent;
        color: var(--ic-text-dim);
        border: 1px solid var(--ic-border);
      }

      .preset--inactive:hover {
        border-color: var(--ic-text-dim);
      }

      .custom-dates {
        display: flex;
        gap: var(--ic-space-sm);
        margin-top: var(--ic-space-sm);
        align-items: center;
      }

      .date-label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      .date-input {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        color: var(--ic-text);
        border-radius: var(--ic-radius-sm, 4px);
        padding: 0.25rem 0.5rem;
        font-size: var(--ic-text-xs);
        font-family: inherit;
      }

      .date-input:focus {
        outline: 2px solid var(--ic-accent);
        outline-offset: 1px;
      }
    `,
  ];

  /** Currently active preset label. */
  @property({ type: String }) selected = "7d";

  /** Available presets. */
  @property({ attribute: false }) presets: TimeRangePreset[] = DEFAULT_PRESETS;

  @state() private _customFrom = "";
  @state() private _customTo = "";

  private _onPresetClick(preset: TimeRangePreset): void {
    this.selected = preset.label;

    if (preset.label === "Custom") {
      // Wait for user to fill in dates before dispatching
      return;
    }

    this.dispatchEvent(
      new CustomEvent("time-range-change", {
        detail: { sinceMs: preset.sinceMs, label: preset.label },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onCustomDateChange(): void {
    if (!this._customFrom || !this._customTo) return;

    const fromMs = new Date(this._customFrom).getTime();
    const sinceMs = Date.now() - fromMs;

    this.dispatchEvent(
      new CustomEvent("time-range-change", {
        detail: { sinceMs, label: "Custom" },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    return html`
      <div class="presets">
        ${this.presets.map(
          (preset) => html`
            <button
              class="preset ${this.selected === preset.label ? "preset--active" : "preset--inactive"}"
              @click=${() => this._onPresetClick(preset)}
            >
              ${preset.label}
            </button>
          `,
        )}
      </div>
      ${this.selected === "Custom"
        ? html`
            <div class="custom-dates">
              <span class="date-label">From</span>
              <input
                type="date"
                class="date-input"
                .value=${this._customFrom}
                @change=${(e: Event) => {
                  this._customFrom = (e.target as HTMLInputElement).value;
                  this._onCustomDateChange();
                }}
              />
              <span class="date-label">To</span>
              <input
                type="date"
                class="date-input"
                .value=${this._customTo}
                @change=${(e: Event) => {
                  this._customTo = (e.target as HTMLInputElement).value;
                  this._onCustomDateChange();
                }}
              />
            </div>
          `
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-time-range-picker": IcTimeRangePicker;
  }
}
