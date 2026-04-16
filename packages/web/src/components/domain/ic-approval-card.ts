import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import "../data/ic-tag.js";
import "../data/ic-relative-time.js";

/** Approval request object shape. */
export interface ApprovalRequest {
  id: string;
  agentId: string;
  action: string;
  classification: string;
  context: string;
  requestedAt: number;
  user?: string;
}

/** Risk classification to tag variant mapping. */
const RISK_VARIANT: Record<string, string> = {
  low: "success",
  medium: "warning",
  high: "error",
  critical: "error",
};

/** Risk classification to left border color mapping. */
const RISK_BORDER_COLOR: Record<string, string> = {
  low: "var(--ic-success)",
  medium: "var(--ic-warning)",
  high: "var(--ic-error)",
  critical: "var(--ic-error)",
};

/**
 * Approval card with approve/deny actions.
 *
 * Renders a single pending approval request with agent ID, action,
 * risk classification badge, timestamp, collapsible context, optional
 * user, reason input, and approve/deny buttons.
 *
 * @fires approve - CustomEvent<{ id: string; reason: string }>
 * @fires deny - CustomEvent<{ id: string; reason: string }>
 *
 * @example
 * ```html
 * <ic-approval-card
 *   .approval=${{ id: "appr-1", agentId: "default", action: "file_write", classification: "high", context: "Writing to /etc/config", requestedAt: Date.now() }}
 *   @approve=${(e) => console.log("Approved:", e.detail)}
 *   @deny=${(e) => console.log("Denied:", e.detail)}
 * ></ic-approval-card>
 * ```
 */
@customElement("ic-approval-card")
export class IcApprovalCard extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
        width: 100%;
      }

      .card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-md);
        border-left: 3px solid var(--ic-border);
      }

      .card-header {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        flex-wrap: wrap;
        margin-bottom: var(--ic-space-xs);
      }

      .agent-id {
        font-weight: 600;
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
      }

      .action-name {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        font-family: ui-monospace, monospace;
      }

      .timestamp {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        margin-bottom: var(--ic-space-sm);
      }

      .user-row {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        margin-bottom: var(--ic-space-sm);
      }

      .user-label {
        color: var(--ic-text-muted);
      }

      .context-toggle {
        background: none;
        border: none;
        color: var(--ic-accent);
        font-size: var(--ic-text-xs);
        cursor: pointer;
        padding: 0;
        font-family: inherit;
        margin-bottom: var(--ic-space-sm);
      }

      .context-toggle:hover {
        text-decoration: underline;
      }

      .context-details {
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm);
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
        white-space: pre-wrap;
        word-break: break-word;
        margin-bottom: var(--ic-space-sm);
      }

      .reason-input {
        width: 100%;
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
        margin-bottom: var(--ic-space-sm);
        box-sizing: border-box;
      }

      .reason-input:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .action-buttons {
        display: flex;
        gap: var(--ic-space-sm);
        flex-wrap: wrap;
      }

      .approve-btn {
        padding: 0.375rem 0.75rem;
        background: color-mix(in srgb, var(--ic-success) 15%, transparent);
        border: 1px solid var(--ic-success);
        border-radius: var(--ic-radius-md);
        color: var(--ic-success);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        font-family: inherit;
        font-weight: 500;
      }

      .approve-btn:hover {
        background: color-mix(in srgb, var(--ic-success) 25%, transparent);
      }

      .deny-btn {
        padding: 0.375rem 0.75rem;
        background: color-mix(in srgb, var(--ic-error) 15%, transparent);
        border: 1px solid var(--ic-error);
        border-radius: var(--ic-radius-md);
        color: var(--ic-error);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        font-family: inherit;
        font-weight: 500;
      }

      .deny-btn:hover {
        background: color-mix(in srgb, var(--ic-error) 25%, transparent);
      }
    `,
  ];

  /** The approval request to display. */
  @property({ type: Object }) approval: ApprovalRequest | null = null;

  /** Reason text entered by the operator. */
  @state() private _reason = "";

  /** Whether the context details section is expanded. */
  @state() private _expanded = false;

  private _onApprove(): void {
    if (!this.approval) return;
    this.dispatchEvent(
      new CustomEvent("approve", {
        detail: { id: this.approval.id, reason: this._reason },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onDeny(): void {
    if (!this.approval) return;
    this.dispatchEvent(
      new CustomEvent("deny", {
        detail: { id: this.approval.id, reason: this._reason },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    if (!this.approval) return nothing;

    const a = this.approval;
    const variant = RISK_VARIANT[a.classification] ?? "default";
    const borderColor = RISK_BORDER_COLOR[a.classification] ?? "var(--ic-border)";

    return html`
      <div
        class="card"
        role="article"
        aria-label="${a.agentId} ${a.action} approval request"
        style="border-left-color: ${borderColor};"
      >
        <div class="card-header">
          <span class="agent-id">${a.agentId}</span>
          <span class="action-name">${a.action}</span>
          <ic-tag variant=${variant}>${a.classification}</ic-tag>
        </div>
        <div class="timestamp">
          <ic-relative-time .timestamp=${a.requestedAt}></ic-relative-time>
        </div>
        ${a.user
          ? html`<div class="user-row"><span class="user-label">Requested by:</span> ${a.user}</div>`
          : nothing}
        <button
          class="context-toggle"
          @click=${() => { this._expanded = !this._expanded; }}
        >${this._expanded ? "Hide details" : "Show details"}</button>
        ${this._expanded
          ? html`<div class="context-details">${a.context}</div>`
          : nothing}
        <input
          class="reason-input"
          type="text"
          placeholder="Reason (optional)"
          aria-label="Decision reason"
          .value=${this._reason}
          @input=${(e: Event) => { this._reason = (e.target as HTMLInputElement).value; }}
        />
        <div class="action-buttons">
          <button class="approve-btn" @click=${() => this._onApprove()}>Approve</button>
          <button class="deny-btn" @click=${() => this._onDeny()}>Deny</button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-approval-card": IcApprovalCard;
  }
}
