// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { SecurityEvent, InputSecurityGuardSummary } from "../../api/types/security-types.js";
import type { AuditEvent } from "../../components/domain/ic-audit-row.js";

// Side-effect imports for sub-components used in template
import "../../components/data/ic-tag.js";
import "../../components/data/ic-relative-time.js";
import "../../components/feedback/ic-empty-state.js";
import "../../components/domain/ic-audit-row.js";

/** Maximum number of audit events to retain. */
const MAX_AUDIT_ENTRIES = 200;

/**
 * Security event streaming and classification sub-component.
 * Renders the security events feed and audit log with pause/resume.
 *
 * Receives events from parent coordinator via property binding and
 * public methods (onAuditEvent, onSecurityEvent).
 */
@customElement("ic-security-event-feed")
export class IcSecurityEventFeed extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .guard-summary {
        display: flex;
        gap: var(--ic-space-sm);
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: var(--ic-surface-alt, var(--ic-surface-2));
        border-radius: var(--ic-radius-md);
        margin-bottom: var(--ic-space-md);
        align-items: center;
        flex-wrap: wrap;
      }

      .event-row {
        display: flex;
        gap: var(--ic-space-sm);
        padding: var(--ic-space-sm) var(--ic-space-sm);
        border-bottom: 1px solid var(--ic-border);
        align-items: center;
      }

      .event-message {
        flex: 1;
        font-size: var(--ic-text-sm);
      }

      .event-details {
        font-family: ui-monospace, monospace;
        font-size: var(--ic-text-xs);
        background: var(--ic-surface-alt, var(--ic-surface-2));
        padding: var(--ic-space-sm);
        border-radius: var(--ic-radius-md);
        max-height: 200px;
        overflow: auto;
        white-space: pre-wrap;
        margin-top: var(--ic-space-xs);
      }

      .event-details-toggle {
        cursor: pointer;
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        background: none;
        border: none;
        font-family: inherit;
        padding: 0;
      }

      .event-details-toggle:hover {
        color: var(--ic-text-muted);
      }

      .audit-controls {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        margin-bottom: var(--ic-space-md);
      }

      .pause-btn {
        padding: 0.375rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        font-family: inherit;
      }

      .pause-btn[data-active] {
        background: var(--ic-warning);
        color: var(--ic-bg);
        border-color: var(--ic-warning);
      }

      .audit-grid {
        display: grid;
        grid-template-columns: 8rem 7rem 1fr 6rem 6rem;
        overflow-y: auto;
        max-height: 600px;
      }

      .audit-grid .header-cell {
        padding: var(--ic-space-xs) var(--ic-space-sm);
        font-size: var(--ic-text-xs);
        font-weight: 600;
        color: var(--ic-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border-bottom: 2px solid var(--ic-border);
        background: var(--ic-surface);
        position: sticky;
        top: 0;
        z-index: 1;
      }
    `,
  ];

  /** Which sub-tab to render: "events" or "audit". */
  @property({ type: String }) activeSubTab: "events" | "audit" = "events";

  /** Security events from parent (pushed via SSE). */
  @property({ attribute: false }) securityEvents: SecurityEvent[] = [];

  /** Input guard summary from parent. */
  @property({ attribute: false }) inputGuardSummary: InputSecurityGuardSummary = { blockedAttempts: 0, patternsTriggered: [], period: "session" };

  // Audit state -- managed internally, events pushed via public method
  @state() private _auditEntries: AuditEvent[] = [];
  @state() private _paused = false;
  private _pauseBuffer: AuditEvent[] = [];

  /** Set of expanded event IDs for details toggle. */
  private _expandedEvents = new Set<string>();

  /** Called by parent when audit:event SSE fires. */
  public onAuditEvent(data: unknown): void {
    const detail = data as AuditEvent;
    if (!detail) return;

    if (this._paused) {
      this._pauseBuffer = [...this._pauseBuffer.slice(-(MAX_AUDIT_ENTRIES - 1)), detail];
      return;
    }

    this._auditEntries = [...this._auditEntries.slice(-(MAX_AUDIT_ENTRIES - 1)), detail];
  }

  /** Expose audit entries for test inspection. */
  public get auditEntries(): AuditEvent[] {
    return this._auditEntries;
  }

  /** Expose paused state for test inspection. */
  public get paused(): boolean {
    return this._paused;
  }

  /** Expose pause buffer for test inspection. */
  public get pauseBuffer(): AuditEvent[] {
    return this._pauseBuffer;
  }

  private _severityVariant(severity: SecurityEvent["severity"]): string {
    switch (severity) {
      case "critical":
      case "high":
        return "error";
      case "medium":
        return "warning";
      case "low":
      default:
        return "info";
    }
  }

  private _toggleEventDetails(eventId: string): void {
    if (this._expandedEvents.has(eventId)) {
      this._expandedEvents.delete(eventId);
    } else {
      this._expandedEvents.add(eventId);
    }
    this.requestUpdate();
  }

  private _togglePause(): void {
    if (this._paused) {
      const merged = [...this._auditEntries, ...this._pauseBuffer].slice(-MAX_AUDIT_ENTRIES);
      this._auditEntries = merged;
      this._pauseBuffer = [];
    }
    this._paused = !this._paused;
  }

  private _renderEventsContent() {
    return html`
      <div class="guard-summary">
        <span style="font-size: var(--ic-text-sm); font-weight: 500; color: var(--ic-text-muted);">Input Guard</span>
        <ic-tag variant="error">${this.inputGuardSummary.blockedAttempts} blocked</ic-tag>
        ${this.inputGuardSummary.patternsTriggered.length > 0
          ? html`<ic-tag variant="warning">${this.inputGuardSummary.patternsTriggered.join(", ")}</ic-tag>`
          : nothing}
      </div>
      ${this.securityEvents.length === 0
        ? html`<ic-empty-state icon="security" message="No security events" description="Security events will appear here in real-time as they are detected."></ic-empty-state>`
        : html`
            <div role="list" aria-label="Security events">
              ${this.securityEvents.map(
                (evt) => html`
                  <div class="event-row" role="listitem">
                    <ic-tag variant=${this._severityVariant(evt.severity)}>${evt.severity}</ic-tag>
                    <ic-tag variant="default">${evt.type}</ic-tag>
                    <span class="event-message">${evt.message}</span>
                    ${evt.agentId ? html`<ic-tag variant="info">${evt.agentId}</ic-tag>` : nothing}
                    <ic-relative-time .timestamp=${evt.timestamp}></ic-relative-time>
                    <button class="event-details-toggle"
                      @click=${() => this._toggleEventDetails(evt.id)}
                    >${this._expandedEvents.has(evt.id) ? "hide" : "details"}</button>
                  </div>
                  ${this._expandedEvents.has(evt.id)
                    ? html`<pre class="event-details">${JSON.stringify(evt.details, null, 2)}</pre>`
                    : nothing}
                `,
              )}
            </div>
          `}
    `;
  }

  private _renderAuditContent() {
    return html`
      <div class="audit-controls">
        <button class="pause-btn" ?data-active=${this._paused}
          @click=${() => this._togglePause()}
        >${this._paused ? "Resume" : "Pause"}</button>
        ${this._paused
          ? html`<span style="font-size: var(--ic-text-xs); color: var(--ic-text-dim);">${this._pauseBuffer.length} buffered</span>`
          : nothing}
      </div>
      ${this._auditEntries.length === 0
        ? html`<ic-empty-state icon="security" message="No audit events" description="Events will appear here as they occur."></ic-empty-state>`
        : html`
            <div class="audit-grid" role="table" aria-label="Audit log">
              <div class="header-cell" role="columnheader">Time</div>
              <div class="header-cell" role="columnheader">Agent</div>
              <div class="header-cell" role="columnheader">Action</div>
              <div class="header-cell" role="columnheader">Risk</div>
              <div class="header-cell" role="columnheader">User</div>
              ${this._auditEntries.map(
                (ev) => html`<ic-audit-row .event=${ev} role="row"></ic-audit-row>`,
              )}
            </div>
          `}
    `;
  }

  override render() {
    if (this.activeSubTab === "audit") {
      return this._renderAuditContent();
    }
    return this._renderEventsContent();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-security-event-feed": IcSecurityEventFeed;
  }
}
