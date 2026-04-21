// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

/** Represents a single toast notification. */
interface ToastItem {
  id: number;
  message: string;
  variant: "success" | "error" | "warning" | "info";
  duration: number;
}

/** Variant-to-CSS-variable mapping for border colors. */
const VARIANT_COLORS: Record<string, string> = {
  success: "var(--ic-success)",
  error: "var(--ic-error)",
  warning: "var(--ic-warning)",
  info: "var(--ic-info)",
};

/** Maximum visible toasts. Oldest dismissed on overflow. */
const MAX_TOASTS = 5;

let nextId = 0;

/**
 * Singleton toast notification manager.
 *
 * Shows stacked notification toasts at the bottom-right of the viewport.
 * Toasts auto-dismiss after a configurable duration.
 *
 * Usage via static method:
 * ```ts
 * IcToast.show("Saved successfully", "success");
 * ```
 *
 * Usage via CustomEvent:
 * ```ts
 * document.dispatchEvent(new CustomEvent("ic-toast", {
 *   detail: { message: "Error occurred", variant: "error" }
 * }));
 * ```
 */
@customElement("ic-toast")
export class IcToast extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        position: fixed;
        bottom: var(--ic-space-lg);
        right: var(--ic-space-lg);
        z-index: 10000;
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm);
        pointer-events: none;
      }

      .toast {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm) var(--ic-space-md);
        min-width: 16rem;
        max-width: 24rem;
        box-shadow: var(--ic-shadow-lg);
        pointer-events: auto;
        animation: toast-enter var(--ic-transition-slow) ease forwards;
      }

      .toast--exiting {
        animation: toast-exit var(--ic-transition) ease forwards;
      }

      @keyframes toast-enter {
        from {
          opacity: 0;
          transform: translateX(1rem);
        }
        to {
          opacity: 1;
          transform: translateX(0);
        }
      }

      @keyframes toast-exit {
        from {
          opacity: 1;
        }
        to {
          opacity: 0;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .toast,
        .toast--exiting {
          animation: none;
        }
      }

      .toast__border {
        width: 4px;
        align-self: stretch;
        border-radius: 2px;
        flex-shrink: 0;
      }

      .toast__message {
        flex: 1;
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
      }

      .toast__close {
        background: none;
        border: none;
        color: var(--ic-text-dim);
        cursor: pointer;
        padding: var(--ic-space-xs);
        font-size: var(--ic-text-sm);
        line-height: 1;
        flex-shrink: 0;
        border-radius: var(--ic-radius-sm);
        transition: color var(--ic-transition);
      }

      .toast__close:hover {
        color: var(--ic-text);
      }
    `,
  ];

  /** Internal singleton reference for the static show() method. */
  private static _instance: IcToast | null = null;

  @state() private _toasts: ToastItem[] = [];

  /** Map of toast ID to dismiss timeout handle. */
  private _timers = new Map<number, ReturnType<typeof setTimeout>>();

  override connectedCallback(): void {
    super.connectedCallback();
    IcToast._instance = this;
    this._onDocumentToast = this._onDocumentToast.bind(this);
    document.addEventListener("ic-toast", this._onDocumentToast as EventListener);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (IcToast._instance === this) {
      IcToast._instance = null;
    }
    document.removeEventListener("ic-toast", this._onDocumentToast as EventListener);
    for (const timer of this._timers.values()) {
      clearTimeout(timer);
    }
    this._timers.clear();
  }

  /**
   * Show a toast notification.
   * Works from anywhere without needing an element reference.
   */
  static show(
    message: string,
    variant: "success" | "error" | "warning" | "info" = "info",
    duration = 4000,
  ): void {
    if (IcToast._instance) {
      IcToast._instance._addToast(message, variant, duration);
    }
  }

  private _onDocumentToast(e: CustomEvent<{ message: string; variant?: string; duration?: number }>): void {
    const { message, variant = "info", duration = 4000 } = e.detail;
    this._addToast(message, variant as ToastItem["variant"], duration);
  }

  private _addToast(message: string, variant: ToastItem["variant"], duration: number): void {
    const id = ++nextId;
    const toast: ToastItem = { id, message, variant, duration };

    // Enforce max visible limit - remove oldest
    let updated = [...this._toasts, toast];
    while (updated.length > MAX_TOASTS) {
      const oldest = updated[0];
      this._clearTimer(oldest.id);
      updated = updated.slice(1);
    }

    this._toasts = updated;

    // Auto-dismiss
    const timer = setTimeout(() => {
      this._removeToast(id);
    }, duration);
    this._timers.set(id, timer);
  }

  private _removeToast(id: number): void {
    this._clearTimer(id);
    this._toasts = this._toasts.filter((t) => t.id !== id);
  }

  private _clearTimer(id: number): void {
    const timer = this._timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this._timers.delete(id);
    }
  }

  override render() {
    return html`
      <div role="alert" aria-live="polite">
        ${this._toasts.map((toast) => {
          const borderColor = VARIANT_COLORS[toast.variant] ?? VARIANT_COLORS.info;
          return html`
            <div class="toast" data-variant=${toast.variant}>
              <div class="toast__border" style="background: ${borderColor}"></div>
              <span class="toast__message">${toast.message}</span>
              <button
                class="toast__close"
                aria-label="Close notification"
                @click=${() => this._removeToast(toast.id)}
              >\u2715</button>
            </div>
          `;
        })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-toast": IcToast;
  }
}
