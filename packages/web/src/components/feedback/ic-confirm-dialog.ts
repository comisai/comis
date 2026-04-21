// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

/**
 * Modal confirmation dialog.
 *
 * Shows a centered modal with title, message, and confirm/cancel buttons.
 * Supports a "danger" variant that renders the confirm button in red.
 * Traps focus while open and handles Escape key and backdrop clicks.
 *
 * @fires confirm - User clicked the confirm button
 * @fires cancel - User clicked cancel, pressed Escape, or clicked the backdrop
 *
 * @example
 * ```html
 * <ic-confirm-dialog
 *   open
 *   title="Delete Agent"
 *   message="Are you sure you want to delete this agent?"
 *   variant="danger"
 *   confirmLabel="Delete"
 *   @confirm=${handler}
 *   @cancel=${handler}
 * ></ic-confirm-dialog>
 * ```
 */
@customElement("ic-confirm-dialog")
export class IcConfirmDialog extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: contents;
      }

      .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .dialog {
        max-width: 28rem;
        width: calc(100% - var(--ic-space-lg) * 2);
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-lg);
        box-shadow: var(--ic-shadow-lg);
      }

      .title {
        font-size: var(--ic-text-lg);
        font-weight: 600;
        color: var(--ic-text);
        margin: 0;
      }

      .message {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        margin-top: var(--ic-space-md);
        line-height: 1.5;
      }

      .buttons {
        display: flex;
        justify-content: flex-end;
        gap: var(--ic-space-sm);
        margin-top: var(--ic-space-lg);
      }

      button {
        padding: var(--ic-space-sm) var(--ic-space-md);
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        transition: background var(--ic-transition), border-color var(--ic-transition);
      }

      .cancel-btn {
        background: transparent;
        border: 1px solid var(--ic-border);
        color: var(--ic-text-muted);
      }

      .cancel-btn:hover {
        border-color: var(--ic-text-dim);
        color: var(--ic-text);
      }

      .confirm-btn {
        background: var(--ic-accent);
        border: 1px solid var(--ic-accent);
        color: #fff;
      }

      .confirm-btn:hover {
        background: var(--ic-accent-hover);
      }

      .confirm-btn--danger {
        background: var(--ic-error);
        border-color: var(--ic-error);
      }

      .confirm-btn--danger:hover {
        background: #dc2626;
        border-color: #dc2626;
      }
    `,
  ];

  /** Whether the dialog is visible. */
  @property({ type: Boolean, reflect: true }) open = false;

  /** Dialog heading. */
  @property() title = "Confirm";

  /** Confirmation message body. */
  @property() message = "";

  /** Confirm button text. */
  @property() confirmLabel = "Confirm";

  /** Cancel button text. */
  @property() cancelLabel = "Cancel";

  /** Visual variant: "default" or "danger" (red confirm button). */
  @property() variant = "default";

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("open") && this.open) {
      // Focus the first focusable element when dialog opens
      this.updateComplete.then(() => {
        const cancelBtn = this.shadowRoot?.querySelector<HTMLElement>(".cancel-btn");
        cancelBtn?.focus();
      });
    }
  }

  private _onBackdropClick(e: MouseEvent): void {
    // Only fire when clicking the backdrop itself, not the dialog content
    if ((e.target as HTMLElement).classList.contains("backdrop")) {
      this._fireCancel();
    }
  }

  private _onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this._fireCancel();
    }

    // Focus trap: Tab/Shift+Tab cycle within dialog buttons
    if (e.key === "Tab") {
      const focusable = this.shadowRoot?.querySelectorAll<HTMLElement>(
        'button:not([disabled])',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === this) {
        // Check shadow root active element
        const active = this.shadowRoot?.activeElement;
        if (active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!e.shiftKey) {
        const active = this.shadowRoot?.activeElement;
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  private _fireConfirm(): void {
    this.dispatchEvent(new CustomEvent("confirm"));
  }

  private _fireCancel(): void {
    this.dispatchEvent(new CustomEvent("cancel"));
  }

  override render() {
    if (!this.open) return nothing;

    const confirmClass =
      this.variant === "danger" ? "confirm-btn confirm-btn--danger" : "confirm-btn";

    return html`
      <div
        class="backdrop"
        @click=${this._onBackdropClick}
        @keydown=${this._onKeyDown}
      >
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dialog-title"
        >
          <h2 class="title" id="dialog-title">${this.title}</h2>
          <p class="message">${this.message}</p>
          <div class="buttons">
            <button class="cancel-btn" @click=${this._fireCancel}>
              ${this.cancelLabel}
            </button>
            <button class=${confirmClass} @click=${this._fireConfirm}>
              ${this.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-confirm-dialog": IcConfirmDialog;
  }
}
