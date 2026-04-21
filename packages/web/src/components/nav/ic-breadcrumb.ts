// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

/** A single breadcrumb segment. */
export interface BreadcrumbItem {
  label: string;
  route?: string;
}

/**
 * Route breadcrumb trail.
 *
 * Renders an ordered list of navigable breadcrumb segments. The last item
 * is displayed as the current page (non-clickable). All preceding items
 * are clickable and fire a `navigate` event with their route.
 *
 * @fires navigate - CustomEvent<string> with the route of the clicked item
 *
 * @example
 * ```html
 * <ic-breadcrumb .items=${[
 *   { label: "Dashboard", route: "dashboard" },
 *   { label: "Agents", route: "agents" },
 *   { label: "Agent Alpha" }
 * ]}></ic-breadcrumb>
 * ```
 */
@customElement("ic-breadcrumb")
export class IcBreadcrumb extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        font-size: var(--ic-text-sm);
      }

      ol {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
        overflow: hidden;
      }

      li {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
        min-width: 0;
      }

      .separator {
        color: var(--ic-text-dim);
        flex-shrink: 0;
      }

      .link {
        color: var(--ic-text-muted);
        cursor: pointer;
        background: none;
        border: none;
        font-family: inherit;
        font-size: inherit;
        padding: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: color var(--ic-transition);
      }

      .link:hover {
        color: var(--ic-accent);
      }

      .current {
        color: var(--ic-text);
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .label {
        color: var(--ic-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `,
  ];

  /** Breadcrumb segments. Last item is displayed as the current page. */
  @property({ type: Array }) items: BreadcrumbItem[] = [];

  private _onNavigate(route: string): void {
    this.dispatchEvent(
      new CustomEvent("navigate", { detail: route }),
    );
  }

  override render() {
    const items = this.items;

    return html`
      <nav aria-label="Breadcrumb">
        <ol>
          ${items.map((item, index) => {
            const isLast = index === items.length - 1;
            return html`
              <li>
                ${index > 0 ? html`<span class="separator" aria-hidden="true">/</span>` : ""}
                ${isLast
                  ? html`<span class="current" aria-current="page">${item.label}</span>`
                  : item.route
                    ? html`<button
                        class="link"
                        @click=${() => this._onNavigate(item.route!)}
                      >${item.label}</button>`
                    : html`<span class="label">${item.label}</span>`
                }
              </li>
            `;
          })}
        </ol>
      </nav>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-breadcrumb": IcBreadcrumb;
  }
}
