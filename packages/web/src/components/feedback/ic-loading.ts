import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

/** Maps size names to pixel values. */
const SIZE_MAP: Record<string, string> = {
  sm: "16px",
  md: "24px",
  lg: "48px",
};

/**
 * Loading indicator component.
 *
 * Supports two modes:
 * - **spinner**: A circular spinning indicator.
 * - **skeleton**: Rectangular shimmer bars for content placeholders.
 *
 * Respects `prefers-reduced-motion` by disabling animations.
 *
 * @example
 * ```html
 * <ic-loading></ic-loading>
 * <ic-loading mode="skeleton" lines="4"></ic-loading>
 * <ic-loading size="lg"></ic-loading>
 * ```
 */
@customElement("ic-loading")
export class IcLoading extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      /* --- Spinner --- */
      .spinner {
        border: 2px solid var(--ic-border);
        border-top-color: var(--ic-accent);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .spinner {
          animation: none;
          border-top-color: var(--ic-accent);
          opacity: 0.7;
        }
      }

      /* --- Skeleton --- */
      .skeleton-container {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm);
      }

      .skeleton-line {
        height: 12px;
        background: var(--ic-surface-2);
        border-radius: var(--ic-radius-sm);
        position: relative;
        overflow: hidden;
      }

      .skeleton-line::after {
        content: "";
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: linear-gradient(
          90deg,
          transparent,
          rgba(255, 255, 255, 0.05),
          transparent
        );
        animation: shimmer 1.5s ease-in-out infinite;
      }

      @keyframes shimmer {
        0% {
          transform: translateX(-100%);
        }
        100% {
          transform: translateX(100%);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .skeleton-line::after {
          animation: none;
          display: none;
        }
      }
    `,
  ];

  /** Loading mode: "spinner" or "skeleton". */
  @property() mode = "spinner";

  /** Spinner size: "sm" (16px) | "md" (24px) | "lg" (48px). */
  @property() size = "md";

  /** Number of skeleton lines (only for skeleton mode). */
  @property({ type: Number }) lines = 3;

  override render() {
    if (this.mode === "skeleton") {
      return this._renderSkeleton();
    }
    return this._renderSpinner();
  }

  private _renderSpinner() {
    const px = SIZE_MAP[this.size] ?? SIZE_MAP.md;
    return html`
      <div
        class="spinner"
        style="width: ${px}; height: ${px};"
        role="status"
        aria-label="Loading"
      ></div>
    `;
  }

  private _renderSkeleton() {
    // Varying widths: 100%, 80%, 60% pattern for visual interest
    const widths = ["100%", "80%", "60%"];
    const lineArray = Array.from({ length: this.lines }, (_, i) => i);

    return html`
      <div
        class="skeleton-container"
        role="status"
        aria-label="Loading"
      >
        ${lineArray.map(
          (i) =>
            html`<div
              class="skeleton-line"
              style="width: ${widths[i % widths.length]};"
            ></div>`,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-loading": IcLoading;
  }
}
