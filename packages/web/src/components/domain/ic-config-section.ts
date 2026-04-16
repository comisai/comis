import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

/**
 * Collapsible config section wrapper using native `<details>/<summary>`.
 *
 * Renders a heading with a chevron that rotates on expand/collapse.
 * Content is provided via the default slot inside the details element.
 * Uses native details/summary for accordion behavior.
 *
 * @example
 * ```html
 * <ic-config-section heading="Provider Settings" description="Configure LLM providers">
 *   <div>...section content...</div>
 * </ic-config-section>
 *
 * <ic-config-section heading="Advanced" open>
 *   <div>...expanded by default...</div>
 * </ic-config-section>
 * ```
 */
@customElement("ic-config-section")
export class IcConfigSection extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      details {
        border-bottom: 1px solid var(--ic-border);
      }

      summary {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        padding: var(--ic-space-md);
        cursor: pointer;
        user-select: none;
        list-style: none;
      }

      /* Remove default marker in Safari */
      summary::-webkit-details-marker {
        display: none;
      }

      summary::marker {
        content: "";
      }

      .chevron {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1rem;
        height: 1rem;
        transition: transform 0.2s ease;
        flex-shrink: 0;
        color: var(--ic-text-muted);
      }

      details[open] > summary .chevron {
        transform: rotate(90deg);
      }

      .heading {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text);
      }

      .description {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
        margin-left: auto;
      }

      .content {
        padding: 0 var(--ic-space-md) var(--ic-space-md);
      }

      summary:hover {
        background: var(--ic-surface);
      }

      summary:focus-visible {
        outline: 2px solid var(--ic-accent);
        outline-offset: -2px;
      }
    `,
  ];

  /** The heading text displayed in the summary. */
  @property() heading = "";

  /** Whether the section is expanded by default. */
  @property({ type: Boolean, reflect: true }) open = false;

  /** Optional description shown to the right of the heading. */
  @property() description = "";

  override render() {
    return html`
      <details ?open=${this.open}>
        <summary>
          <span class="chevron">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
          <span class="heading">${this.heading}</span>
          ${this.description
            ? html`<span class="description">${this.description}</span>`
            : ""}
        </summary>
        <div class="content">
          <slot></slot>
        </div>
      </details>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-config-section": IcConfigSection;
  }
}
