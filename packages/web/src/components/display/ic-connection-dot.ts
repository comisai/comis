import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";
import { getHealthVisual } from "../../utils/health-status.js";

// Side-effect import to register ic-icon custom element
import "./ic-icon.js";

/**
 * Colored status dot indicator with icon and text label.
 *
 * Shows a small colored circle, a status icon, and a text label
 * representing connection status. The icon and label ensure status
 * is never communicated by color alone (WCAG 2.1 AA compliance).
 * Includes a pulse animation for "reconnecting" state that
 * respects prefers-reduced-motion.
 *
 * @example
 * ```html
 * <ic-connection-dot status="connected"></ic-connection-dot>
 * <ic-connection-dot status="reconnecting"></ic-connection-dot>
 * ```
 */
@customElement("ic-connection-dot")
export class IcConnectionDot extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs);
      }

      .dot {
        border-radius: 50%;
        flex-shrink: 0;
      }

      .dot--pulse {
        animation: pulse 2s ease-in-out infinite;
      }

      @keyframes pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.4;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .dot--pulse {
          animation: none;
        }
      }

      .status-icon {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
      }

      .label {
        color: var(--ic-text-dim);
        font-size: var(--ic-text-xs);
      }
    `,
  ];

  /** Channel health status (any raw status string -- normalized internally). */
  @property() status: string = "disconnected";

  /** Dot diameter as a CSS value. */
  @property() size = "8px";

  /** Whether to display the status text next to the dot. Defaults to true for color independence. */
  @property({ type: Boolean }) showLabel = true;

  override render() {
    const visual = getHealthVisual(this.status);

    return html`
      <span
        class="dot ${visual.pulse ? "dot--pulse" : ""}"
        style="width: ${this.size}; height: ${this.size}; background-color: ${visual.color};"
        role="status"
        aria-label="Connection status: ${visual.label}"
      ></span>
      <span class="status-icon" aria-hidden="true">
        <ic-icon name=${visual.icon} size="12px" color=${visual.color}></ic-icon>
      </span>
      ${this.showLabel
        ? html`<span class="label">${visual.label}</span>`
        : html``}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-connection-dot": IcConnectionDot;
  }
}
