// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

/** Color mapping: variant name -> CSS custom property. */
const VARIANT_COLORS: Record<string, string> = {
  default: "var(--ic-text-muted)",
  success: "var(--ic-success)",
  warning: "var(--ic-warning)",
  error: "var(--ic-error)",
  info: "var(--ic-info)",
  accent: "var(--ic-accent)",
  // Platform colors
  telegram: "var(--ic-telegram)",
  discord: "var(--ic-discord)",
  slack: "var(--ic-slack)",
  whatsapp: "var(--ic-whatsapp)",
  line: "var(--ic-line)",
  signal: "var(--ic-signal)",
  imessage: "var(--ic-imessage)",
  irc: "var(--ic-irc)",
};

/**
 * Colored status/type badge (pill shape).
 *
 * Displays a tag with a semi-transparent background tinted
 * to the variant color and full-opacity text color.
 *
 * @example
 * ```html
 * <ic-tag variant="success">Active</ic-tag>
 * <ic-tag variant="telegram" size="md">Telegram</ic-tag>
 * ```
 */
@customElement("ic-tag")
export class IcTag extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: inline-block;
      }

      .tag {
        display: inline-flex;
        align-items: center;
        border-radius: 9999px;
        font-weight: 500;
        white-space: nowrap;
        line-height: 1;
      }

      .tag--sm {
        padding: 2px 8px;
        font-size: var(--ic-text-xs);
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }

      .tag--md {
        padding: 4px 12px;
        font-size: var(--ic-text-sm);
      }
    `,
  ];

  /**
   * Color variant: "default" | "success" | "warning" | "error" | "info" |
   * "accent" | platform names ("telegram", "discord", etc.)
   */
  @property() variant = "default";

  /** Size: "sm" (small) or "md" (medium). */
  @property() size = "sm";

  override render() {
    const color = VARIANT_COLORS[this.variant] ?? VARIANT_COLORS.default;
    const sizeClass = this.size === "md" ? "tag--md" : "tag--sm";

    return html`
      <span
        class="tag ${sizeClass}"
        style="background-color: color-mix(in srgb, ${color} 10%, transparent); color: ${color};"
      >
        <slot></slot>
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-tag": IcTag;
  }
}
