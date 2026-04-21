// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

// Side-effect import to register ic-loading custom element
import "../feedback/ic-loading.js";

/**
 * View-level skeleton loading screen component.
 *
 * Provides layout-aware skeleton placeholders that match the structure of
 * the target view, giving users a sense of the content shape before data arrives.
 *
 * Uses a 150ms delay before showing to prevent flash on fast loads.
 *
 * @example
 * ```html
 * <ic-skeleton-view variant="dashboard"></ic-skeleton-view>
 * <ic-skeleton-view variant="list"></ic-skeleton-view>
 * ```
 */
@customElement("ic-skeleton-view")
export class IcSkeletonView extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .skeleton-container {
        padding: var(--ic-space-md, 0.75rem) 0;
      }

      .skeleton-hidden {
        visibility: hidden;
      }

      /* Dashboard variant */
      .skeleton-stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--ic-space-md);
        margin-bottom: var(--ic-space-lg);
      }

      @media (max-width: 639px) {
        .skeleton-stats {
          grid-template-columns: 1fr;
        }
      }

      .skeleton-stat-card {
        background: var(--ic-surface, #111827);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md) var(--ic-space-lg);
        height: 80px;
      }

      .skeleton-content-block {
        background: var(--ic-surface, #111827);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-lg);
      }

      /* List variant */
      .skeleton-search {
        height: 40px;
        background: var(--ic-surface, #111827);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md);
        margin-bottom: var(--ic-space-md);
        max-width: 320px;
      }

      .skeleton-row {
        display: flex;
        gap: var(--ic-space-md);
        padding: var(--ic-space-sm) var(--ic-space-md);
        border-bottom: 1px solid var(--ic-border, #374151);
      }

      .skeleton-row-cell {
        flex: 1;
      }

      /* Detail variant */
      .skeleton-detail-header {
        margin-bottom: var(--ic-space-lg);
      }

      .skeleton-two-col {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--ic-space-lg);
      }

      @media (max-width: 767px) {
        .skeleton-two-col {
          grid-template-columns: 1fr;
        }
      }

      .skeleton-block {
        background: var(--ic-surface, #111827);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-lg);
        min-height: 150px;
      }

      /* Editor variant */
      .skeleton-editor-block {
        background: var(--ic-surface, #111827);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-lg);
        min-height: 300px;
      }
    `,
  ];

  /** Layout variant matching the target view structure. */
  @property() variant: "dashboard" | "list" | "detail" | "table" | "editor" = "dashboard";

  /** Whether the skeleton is visible (delayed by 150ms). */
  @state() private _showSkeleton = false;

  private _delayTimer: ReturnType<typeof setTimeout> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._delayTimer = setTimeout(() => {
      this._showSkeleton = true;
    }, 150);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._delayTimer) {
      clearTimeout(this._delayTimer);
      this._delayTimer = null;
    }
  }

  private _renderDashboard() {
    return html`
      <div class="skeleton-stats">
        <div class="skeleton-stat-card"><ic-loading mode="skeleton" lines="2"></ic-loading></div>
        <div class="skeleton-stat-card"><ic-loading mode="skeleton" lines="2"></ic-loading></div>
        <div class="skeleton-stat-card"><ic-loading mode="skeleton" lines="2"></ic-loading></div>
      </div>
      <div class="skeleton-content-block"><ic-loading mode="skeleton" lines="6"></ic-loading></div>
    `;
  }

  private _renderList() {
    return html`
      <div class="skeleton-search"></div>
      <div class="skeleton-content-block">
        ${Array.from({ length: 8 }, () => html`
          <div class="skeleton-row">
            <div class="skeleton-row-cell"><ic-loading mode="skeleton" lines="1"></ic-loading></div>
            <div class="skeleton-row-cell"><ic-loading mode="skeleton" lines="1"></ic-loading></div>
            <div class="skeleton-row-cell"><ic-loading mode="skeleton" lines="1"></ic-loading></div>
          </div>
        `)}
      </div>
    `;
  }

  private _renderDetail() {
    return html`
      <div class="skeleton-detail-header">
        <ic-loading mode="skeleton" lines="2"></ic-loading>
      </div>
      <div class="skeleton-two-col">
        <div class="skeleton-block"><ic-loading mode="skeleton" lines="5"></ic-loading></div>
        <div class="skeleton-block"><ic-loading mode="skeleton" lines="5"></ic-loading></div>
      </div>
    `;
  }

  private _renderTable() {
    return html`
      <div class="skeleton-content-block">
        <ic-loading mode="skeleton" lines="1"></ic-loading>
        ${Array.from({ length: 8 }, () => html`
          <div class="skeleton-row">
            <div class="skeleton-row-cell"><ic-loading mode="skeleton" lines="1"></ic-loading></div>
            <div class="skeleton-row-cell"><ic-loading mode="skeleton" lines="1"></ic-loading></div>
          </div>
        `)}
      </div>
    `;
  }

  private _renderEditor() {
    return html`
      <div class="skeleton-detail-header">
        <ic-loading mode="skeleton" lines="1"></ic-loading>
      </div>
      <div class="skeleton-editor-block"><ic-loading mode="skeleton" lines="8"></ic-loading></div>
    `;
  }

  override render() {
    const containerClass = this._showSkeleton ? "skeleton-container" : "skeleton-container skeleton-hidden";

    return html`
      <div class=${containerClass} role="status" aria-label="Loading content">
        ${(() => {
          switch (this.variant) {
            case "dashboard": return this._renderDashboard();
            case "list": return this._renderList();
            case "detail": return this._renderDetail();
            case "table": return this._renderTable();
            case "editor": return this._renderEditor();
          }
        })()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-skeleton-view": IcSkeletonView;
  }
}
