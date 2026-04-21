// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

// Side-effect import to register ic-icon custom element
import "../display/ic-icon.js";

/**
 * Empty content placeholder component.
 *
 * Displays a centered message with optional icon and description
 * for empty content areas (empty tables, empty lists, no search results).
 *
 * @example
 * ```html
 * <ic-empty-state icon="search" message="No results found" description="Try a different search term."></ic-empty-state>
 * ```
 */
@customElement("ic-empty-state")
export class IcEmptyState extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .container {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--ic-space-2xl) var(--ic-space-md);
        text-align: center;
        gap: var(--ic-space-sm);
      }

      .icon-area {
        margin-bottom: var(--ic-space-xs);
      }

      .message {
        color: var(--ic-text-muted);
        font-size: var(--ic-text-base);
        margin: 0;
      }

      .description {
        color: var(--ic-text-dim);
        font-size: var(--ic-text-sm);
        margin: 0;
      }

      .action-area {
        margin-top: var(--ic-space-sm);
      }
    `,
  ];

  /** Main message text. */
  @property() message = "No items to display";

  /** Optional secondary description text. */
  @property() description = "";

  /** Optional icon name (rendered via ic-icon). */
  @property() icon = "";

  override render() {
    return html`
      <div class="container">
        ${this.icon
          ? html`
              <div class="icon-area">
                <ic-icon
                  name=${this.icon}
                  size="48px"
                  color="var(--ic-text-dim)"
                ></ic-icon>
              </div>
            `
          : nothing}
        <p class="message">${this.message}</p>
        ${this.description
          ? html`<p class="description">${this.description}</p>`
          : nothing}
        <div class="action-area">
          <slot></slot>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-empty-state": IcEmptyState;
  }
}
