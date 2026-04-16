import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";
import "../data/ic-tag.js";
import "../data/ic-relative-time.js";

/** Audit event object shape. */
export interface AuditEvent {
  timestamp: number;
  agentId: string;
  action: string;
  classification: string;
  user: string;
  details?: string;
}

/** Risk classification to tag variant mapping. */
const RISK_VARIANT: Record<string, string> = {
  low: "success",
  medium: "warning",
  high: "error",
  critical: "error",
};

/**
 * Audit event row with risk classification color coding.
 *
 * Renders a single row in the audit log with timestamp, agent ID,
 * action, risk-level badge (color-coded tag), and user. Uses
 * display:contents for parent grid alignment.
 *
 * @example
 * ```html
 * <ic-audit-row .event=${{ timestamp: Date.now(), agentId: "default", action: "tool.exec", classification: "high", user: "admin" }}></ic-audit-row>
 * ```
 */
@customElement("ic-audit-row")
export class IcAuditRow extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: contents;
      }

      .cell {
        padding: var(--ic-space-xs) var(--ic-space-sm);
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        display: flex;
        align-items: center;
        border-bottom: 1px solid var(--ic-border);
        min-height: 2.25rem;
      }

      .cell--muted {
        color: var(--ic-text-muted);
      }

      .cell--details {
        color: var(--ic-text-dim);
        font-size: var(--ic-text-xs);
      }
    `,
  ];

  /** The audit event to display. */
  @property({ type: Object }) event: AuditEvent | null = null;

  override render() {
    if (!this.event) {
      return html`
        <div class="cell cell--muted" role="cell">---</div>
        <div class="cell cell--muted" role="cell">---</div>
        <div class="cell cell--muted" role="cell">---</div>
        <div class="cell cell--muted" role="cell">---</div>
        <div class="cell cell--muted" role="cell">---</div>
      `;
    }

    const ev = this.event;
    const variant = RISK_VARIANT[ev.classification] ?? "default";

    return html`
      <div class="cell cell--muted" role="cell">
        <ic-relative-time .timestamp=${ev.timestamp}></ic-relative-time>
      </div>
      <div class="cell" role="cell">${ev.agentId || "---"}</div>
      <div class="cell" role="cell">${ev.action || "---"}</div>
      <div class="cell" role="cell">
        <ic-tag variant=${variant}>${ev.classification || "unknown"}</ic-tag>
      </div>
      <div class="cell cell--muted" role="cell">${ev.user || "---"}</div>
      ${ev.details
        ? html`<div class="cell cell--details" role="cell" style="grid-column: 1 / -1;">${ev.details}</div>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-audit-row": IcAuditRow;
  }
}
