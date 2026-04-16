/**
 * Heartbeat section sub-editor for agent configuration.
 *
 * Renders: Enable/disable, interval, delivery target, prompt,
 * show OK/alerts, and advanced heartbeat fields.
 */
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { renderNumberField, renderTextField, renderTextarea, renderCheckbox } from "./editor-helpers.js";
import type { EditorForm, FieldChangeDetail } from "./editor-types.js";

@customElement("ic-agent-heartbeat-editor")
export class IcAgentHeartbeatEditor extends LitElement {
  static override styles = css`
    :host { display: block; }

    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: var(--ic-space-md);
    }

    .field label {
      font-size: var(--ic-text-xs);
      color: var(--ic-text-dim);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .field input,
    .field textarea {
      background: var(--ic-surface-2);
      border: 1px solid var(--ic-border);
      border-radius: var(--ic-radius-md);
      padding: var(--ic-space-sm) var(--ic-space-md);
      color: var(--ic-text);
      font-family: inherit;
      font-size: var(--ic-text-sm);
      outline: none;
      transition: border-color var(--ic-transition);
    }

    .field input:focus,
    .field textarea:focus {
      border-color: var(--ic-accent);
    }

    .field textarea {
      min-height: 4rem;
      resize: vertical;
    }

    .field-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--ic-space-md);
    }

    .checkbox-field {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: var(--ic-space-sm);
      margin-bottom: var(--ic-space-md);
    }

    .checkbox-field label {
      font-size: var(--ic-text-sm);
      color: var(--ic-text);
      text-transform: none;
      letter-spacing: normal;
      cursor: pointer;
    }

    .checkbox-field input[type="checkbox"] {
      width: 1rem;
      height: 1rem;
      accent-color: var(--ic-accent);
      cursor: pointer;
    }

    .divider {
      border: none;
      border-top: 1px solid var(--ic-border);
      margin: var(--ic-space-md) 0;
    }

    .section-title {
      font-weight: 600;
      margin-bottom: var(--ic-space-sm);
      font-size: var(--ic-text-sm);
      color: var(--ic-text);
    }

    @media (max-width: 767px) {
      .field-row {
        grid-template-columns: 1fr;
      }
    }
  `;

  @property({ attribute: false }) form: EditorForm = {};

  private _onChange = (key: string, value: unknown): void => {
    this.dispatchEvent(
      new CustomEvent<FieldChangeDetail>("field-change", {
        detail: { key, value },
        bubbles: true,
        composed: true,
      }),
    );
  };

  override render() {
    return html`
      ${renderCheckbox(this.form, "heartbeat.enabled", "Enabled", this._onChange, { id: "field-hb-enabled" })}
      ${renderNumberField(this.form, "heartbeat.intervalMs", "Interval (ms)", this._onChange, { id: "field-hb-intervalMs", placeholder: "900000" })}
      <div class="section-title">Delivery Target</div>
      <div class="field-row">
        ${renderTextField(this.form, "heartbeat.target.channelType", "Channel Type", this._onChange, { id: "field-hb-channelType", placeholder: "telegram" })}
        ${renderTextField(this.form, "heartbeat.target.channelId", "Channel ID", this._onChange, { id: "field-hb-channelId" })}
      </div>
      ${renderTextField(this.form, "heartbeat.target.chatId", "Chat ID", this._onChange, { id: "field-hb-chatId", placeholder: "Chat/conversation ID" })}
      ${renderTextarea(this.form, "heartbeat.prompt", "Prompt", this._onChange, { id: "field-hb-prompt", placeholder: "Check system health" })}
      <div class="field-row">
        ${renderCheckbox(this.form, "heartbeat.showOk", "Show OK", this._onChange, { id: "field-hb-showOk" })}
        ${renderCheckbox(this.form, "heartbeat.showAlerts", "Show Alerts", this._onChange, { id: "field-hb-showAlerts" })}
      </div>

      <hr class="divider" />
      <div class="section-title">Advanced Heartbeat</div>
      <div class="field-row">
        ${renderTextField(this.form, "heartbeat.model", "Model Override", this._onChange, { id: "field-hb-model", placeholder: "e.g. claude-sonnet-4-5-20250929" })}
        ${renderTextField(this.form, "heartbeat.session", "Session Key", this._onChange, { id: "field-hb-session" })}
      </div>
      <div class="field-row">
        ${renderCheckbox(this.form, "heartbeat.allowDm", "Allow DM", this._onChange, { id: "field-hb-allowDm" })}
        ${renderCheckbox(this.form, "heartbeat.lightContext", "Light Context", this._onChange, { id: "field-hb-lightContext" })}
        ${renderCheckbox(this.form, "heartbeat.skipHeartbeatOnlyDelivery", "Skip HB-Only Delivery", this._onChange, { id: "field-hb-skipDelivery" })}
      </div>
      <div class="field-row">
        ${renderNumberField(this.form, "heartbeat.ackMaxChars", "Ack Max Chars", this._onChange, { id: "field-hb-ackMaxChars" })}
        ${renderTextField(this.form, "heartbeat.responsePrefix", "Response Prefix", this._onChange, { id: "field-hb-responsePrefix" })}
      </div>
      <div class="field-row">
        ${renderNumberField(this.form, "heartbeat.alertThreshold", "Alert Threshold", this._onChange, { id: "field-hb-alertThreshold" })}
        ${renderNumberField(this.form, "heartbeat.alertCooldownMs", "Alert Cooldown (ms)", this._onChange, { id: "field-hb-alertCooldownMs" })}
      </div>
      ${renderNumberField(this.form, "heartbeat.staleMs", "Stale Timeout (ms)", this._onChange, { id: "field-hb-staleMs" })}
    `;
  }
}
