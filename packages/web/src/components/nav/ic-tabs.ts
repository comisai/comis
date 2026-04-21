// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

/** A single tab definition. */
export interface TabDef {
  id: string;
  label: string;
  badge?: number;
}

/**
 * Horizontal tab bar with keyboard navigation and slotted content panels.
 *
 * Tabs are defined via the `tabs` property. Content is provided through
 * named slots matching the tab IDs, or through elements with `data-tab`
 * attributes inside the default slot.
 *
 * @fires tab-change - CustomEvent<string> with the new active tab ID
 *
 * @example
 * ```html
 * <ic-tabs .tabs=${[{ id: "overview", label: "Overview" }, { id: "logs", label: "Logs", badge: 3 }]}>
 *   <div data-tab="overview">Overview content...</div>
 *   <div data-tab="logs">Logs content...</div>
 * </ic-tabs>
 * ```
 */
@customElement("ic-tabs")
export class IcTabs extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .tablist {
        display: flex;
        border-bottom: 1px solid var(--ic-border);
        gap: 0;
      }

      .tab {
        padding: var(--ic-space-sm) var(--ic-space-md);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        color: var(--ic-text-muted);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs);
        transition: color var(--ic-transition), border-color var(--ic-transition);
        white-space: nowrap;
      }

      .tab:hover:not(.tab--active) {
        color: var(--ic-text);
      }

      .tab--active {
        color: var(--ic-accent);
        border-bottom-color: var(--ic-accent);
        font-weight: 500;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 1.25rem;
        height: 1.25rem;
        padding: 0 var(--ic-space-xs);
        background: var(--ic-accent);
        color: #fff;
        font-size: var(--ic-text-xs);
        font-weight: 600;
        border-radius: 9999px;
        line-height: 1;
      }

      .panels {
        margin-top: var(--ic-space-md);
      }

      ::slotted([data-tab]) {
        display: none;
      }

      ::slotted([data-tab][data-active]) {
        display: block;
      }
    `,
  ];

  /** Tab definitions. */
  @property({ type: Array }) tabs: TabDef[] = [];

  /** Currently active tab ID. Defaults to first tab if empty. */
  @property() activeTab = "";

  override willUpdate(changed: Map<string, unknown>): void {
    // Default to first tab if activeTab is empty
    if ((!this.activeTab || changed.has("tabs")) && this.tabs.length > 0 && !this.activeTab) {
      this.activeTab = this.tabs[0].id;
    }
  }

   
  override updated(_changed: Map<string, unknown>): void {
    // Show/hide slotted panels based on activeTab
    this._updatePanelVisibility();
  }

  private _updatePanelVisibility(): void {
    const slot = this.shadowRoot?.querySelector<HTMLSlotElement>("slot:not([name])");
    if (!slot) return;
    const assigned = slot.assignedElements();
    for (const el of assigned) {
      const tabId = (el as HTMLElement).dataset.tab;
      if (tabId) {
        if (tabId === this.activeTab) {
          (el as HTMLElement).setAttribute("data-active", "");
        } else {
          (el as HTMLElement).removeAttribute("data-active");
        }
      }
    }
  }

  private _selectTab(tabId: string): void {
    if (tabId === this.activeTab) return;
    this.activeTab = tabId;
    this.dispatchEvent(
      new CustomEvent("tab-change", { detail: tabId }),
    );
  }

  private _onTabKeyDown(e: KeyboardEvent): void {
    const tabElements = Array.from(
      this.shadowRoot?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
    );
    const currentIndex = tabElements.indexOf(e.target as HTMLElement);
    if (currentIndex < 0) return;

    let nextIndex = -1; // eslint-disable-line no-useless-assignment -- reassigned in switch branches below

    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        nextIndex = currentIndex > 0 ? currentIndex - 1 : tabElements.length - 1;
        break;
      case "ArrowRight":
        e.preventDefault();
        nextIndex = currentIndex < tabElements.length - 1 ? currentIndex + 1 : 0;
        break;
      case "Home":
        e.preventDefault();
        nextIndex = 0;
        break;
      case "End":
        e.preventDefault();
        nextIndex = tabElements.length - 1;
        break;
      default:
        return;
    }

    if (nextIndex >= 0 && nextIndex < tabElements.length) {
      tabElements[nextIndex].focus();
      const tabId = this.tabs[nextIndex]?.id;
      if (tabId) {
        this._selectTab(tabId);
      }
    }
  }

  override render() {
    const activeId = this.activeTab || (this.tabs.length > 0 ? this.tabs[0].id : "");

    return html`
      <div class="tablist" role="tablist">
        ${this.tabs.map((tab) => {
          const isActive = tab.id === activeId;
          return html`
            <button
              role="tab"
              id="tab-${tab.id}"
              class="tab ${isActive ? "tab--active" : ""}"
              aria-selected=${isActive ? "true" : "false"}
              aria-controls="panel-${tab.id}"
              tabindex=${isActive ? "0" : "-1"}
              @click=${() => this._selectTab(tab.id)}
              @keydown=${this._onTabKeyDown}
            >
              ${tab.label}
              ${tab.badge && tab.badge > 0
                ? html`<span class="badge">${tab.badge}</span>`
                : nothing}
            </button>
          `;
        })}
      </div>
      <div class="panels">
        ${this.tabs.map((tab) => {
          const isActive = tab.id === activeId;
          return html`
            <div
              role="tabpanel"
              id="panel-${tab.id}"
              aria-labelledby="tab-${tab.id}"
              ?hidden=${!isActive}
            >
              <slot name=${tab.id}></slot>
            </div>
          `;
        })}
        <slot @slotchange=${this._updatePanelVisibility}></slot>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-tabs": IcTabs;
  }
}
