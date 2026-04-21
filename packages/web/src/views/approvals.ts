// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { sharedStyles } from "../styles/shared.js";

/**
 * Deprecated approvals view -- approvals are now managed in the Security view.
 *
 * Keeps the `ic-approvals-view` custom element registered for backward
 * compatibility (the route still exists) but renders a redirect notice
 * pointing users to the Security view's Pending Approvals tab.
 */
@customElement("ic-approvals-view")
export class IcApprovalsView extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .redirect-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 4rem 2rem;
        gap: var(--ic-space-md);
        text-align: center;
      }

      .redirect-title {
        font-size: 1.125rem;
        font-weight: 600;
        color: var(--ic-text);
      }

      .redirect-desc {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        max-width: 28rem;
      }

      .redirect-btn {
        padding: 0.5rem 1.25rem;
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
      }

      .redirect-btn:hover {
        opacity: 0.9;
      }
    `,
  ];

  private _navigateToSecurity(): void {
    window.location.hash = "#security";
  }

  override render() {
    return html`
      <div class="redirect-container">
        <div class="redirect-title">Approvals Moved</div>
        <div class="redirect-desc">
          Approvals have been merged into the Security view. Use the
          "Pending Approvals" and "Approval Rules" tabs to manage approvals.
        </div>
        <button class="redirect-btn" @click=${() => this._navigateToSecurity()}>
          Go to Security
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-approvals-view": IcApprovalsView;
  }
}
