// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

/**
 * Slide-in panel from right edge with overlay backdrop.
 *
 * Used for showing detail views (memory entries, session details)
 * without navigating away from the current context.
 *
 * @fires close - Fired on backdrop click, close button click, or Escape key
 *
 * @example
 * ```html
 * <ic-detail-panel
 *   ?open=${this._panelOpen}
 *   panelTitle="Memory Detail"
 *   @close=${() => this._panelOpen = false}
 * >
 *   <p>Panel content here</p>
 *   <div slot="footer">
 *     <button>Save</button>
 *   </div>
 * </ic-detail-panel>
 * ```
 */
@customElement("ic-detail-panel")
export class IcDetailPanel extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: contents;
      }

      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 9998;
      }

      .panel {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        background: var(--ic-surface);
        border-left: 1px solid var(--ic-border);
        z-index: 9999;
        display: flex;
        flex-direction: column;
        box-shadow: var(--ic-shadow-lg);
        animation: slide-in var(--ic-transition-slow) ease-out;
      }

      @keyframes slide-in {
        from {
          transform: translateX(100%);
        }
        to {
          transform: translateX(0);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .panel {
          animation: none;
        }
      }

      .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--ic-space-md) var(--ic-space-lg);
        border-bottom: 1px solid var(--ic-border);
        flex-shrink: 0;
      }

      .panel-title {
        font-size: var(--ic-text-lg);
        font-weight: 600;
        color: var(--ic-text);
        margin: 0;
      }

      .close-btn {
        background: transparent;
        border: none;
        color: var(--ic-text-muted);
        cursor: pointer;
        padding: var(--ic-space-xs);
        border-radius: var(--ic-radius-sm);
        font-size: var(--ic-text-lg);
        font-family: inherit;
        line-height: 1;
        transition: color var(--ic-transition);
      }

      .close-btn:hover {
        color: var(--ic-text);
      }

      .panel-body {
        flex: 1;
        overflow-y: auto;
        padding: var(--ic-space-lg);
      }

      .panel-footer {
        border-top: 1px solid var(--ic-border);
        padding: var(--ic-space-md) var(--ic-space-lg);
        flex-shrink: 0;
      }

      /* Hide footer slot wrapper when no content slotted */
      .panel-footer:empty {
        display: none;
      }
    `,
  ];

  /** Whether the panel is visible. */
  @property({ type: Boolean, reflect: true }) open = false;

  /** Panel header title text. Uses panelTitle to avoid HTMLElement.title conflict. */
  @property() panelTitle = "Detail";

  /** Panel width CSS value. */
  @property() width = "min(32rem, 90vw)";

  private _boundKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("open")) {
      if (this.open) {
        this._boundKeyHandler = (e: KeyboardEvent) => this._handleKeyDown(e);
        document.addEventListener("keydown", this._boundKeyHandler);
        // Focus close button when opened
        this.updateComplete.then(() => {
          const closeBtn = this.shadowRoot?.querySelector<HTMLElement>(".close-btn");
          closeBtn?.focus();
        });
      } else if (this._boundKeyHandler) {
        document.removeEventListener("keydown", this._boundKeyHandler);
        this._boundKeyHandler = null;
      }
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._boundKeyHandler) {
      document.removeEventListener("keydown", this._boundKeyHandler);
      this._boundKeyHandler = null;
    }
  }

  private _handleKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this._fireClose();
    }
  }

  private _handleOverlayClick(): void {
    this._fireClose();
  }

  private _fireClose(): void {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true }));
  }

  override render() {
    if (!this.open) return nothing;

    return html`
      <div class="overlay" @click=${this._handleOverlayClick}></div>
      <div
        class="panel"
        role="complementary"
        aria-label=${this.panelTitle}
        style="width: ${this.width}"
      >
        <div class="panel-header">
          <h2 class="panel-title">${this.panelTitle}</h2>
          <button
            class="close-btn"
            @click=${this._fireClose}
            aria-label="Close panel"
          >
            &#x2715;
          </button>
        </div>
        <div class="panel-body">
          <slot></slot>
        </div>
        <div class="panel-footer">
          <slot name="footer"></slot>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-detail-panel": IcDetailPanel;
  }
}
