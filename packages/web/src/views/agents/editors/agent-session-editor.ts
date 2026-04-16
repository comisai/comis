/**
 * Session Policy section sub-editor for agent configuration.
 *
 * Renders: Reset mode, daily reset hour, timezone, idle timeout,
 * DM scope, pruning, and compaction settings.
 */
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { renderNumberField, renderSelectField, renderCheckbox, getField, nothing } from "./editor-helpers.js";
import type { EditorForm, FieldChangeDetail } from "./editor-types.js";

@customElement("ic-agent-session-editor")
export class IcAgentSessionEditor extends LitElement {
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
    .field select {
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
    .field select:focus {
      border-color: var(--ic-accent);
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
    const resetMode = getField(this.form, "session.resetMode", "none") as string;
    const hourOptions = Array.from({ length: 24 }, (_, i) => ({
      value: String(i),
      label: `${String(i).padStart(2, "0")}:00`,
    }));

    return html`
      <div class="field-row">
        ${renderSelectField(this.form, "session.resetMode", "Reset Mode", [
          { value: "none", label: "None (manual only)" },
          { value: "daily", label: "Daily" },
          { value: "idle", label: "Idle Timeout" },
          { value: "hybrid", label: "Hybrid (first to expire)" },
        ], this._onChange, { id: "field-sess-resetMode" })}
        ${resetMode === "idle" || resetMode === "hybrid" ? renderNumberField(this.form, "session.idleTimeoutMs", "Idle Timeout (ms)", this._onChange, { id: "field-sess-idleTimeout", placeholder: "14400000" }) : nothing}
      </div>
      ${resetMode === "daily" || resetMode === "hybrid" ? html`
        <div class="field-row">
          ${renderSelectField(this.form, "session.dailyResetHour", "Daily Reset Hour", hourOptions, this._onChange, { id: "field-sess-dailyResetHour" })}
          ${renderSelectField(this.form, "session.timezone", "Timezone", [
            { value: "UTC", label: "UTC" },
            { value: "America/New_York", label: "US Eastern" },
            { value: "America/Chicago", label: "US Central" },
            { value: "America/Denver", label: "US Mountain" },
            { value: "America/Los_Angeles", label: "US Pacific" },
            { value: "Europe/London", label: "Europe/London" },
            { value: "Europe/Berlin", label: "Europe/Berlin" },
            { value: "Europe/Paris", label: "Europe/Paris" },
            { value: "Europe/Moscow", label: "Europe/Moscow" },
            { value: "Asia/Dubai", label: "Asia/Dubai" },
            { value: "Asia/Kolkata", label: "Asia/Kolkata" },
            { value: "Asia/Shanghai", label: "Asia/Shanghai" },
            { value: "Asia/Tokyo", label: "Asia/Tokyo" },
            { value: "Asia/Seoul", label: "Asia/Seoul" },
            { value: "Asia/Jerusalem", label: "Asia/Jerusalem" },
            { value: "Australia/Sydney", label: "Australia/Sydney" },
            { value: "Pacific/Auckland", label: "Pacific/Auckland" },
          ], this._onChange, { id: "field-sess-timezone" })}
        </div>
      ` : nothing}

      <hr class="divider" />
      <div class="section-title">DM Scope</div>
      ${renderSelectField(this.form, "session.dmScopeMode", "DM Scope Mode", [
        { value: "", label: "Default (main)" },
        { value: "main", label: "Main (single session)" },
        { value: "per-peer", label: "Per Peer" },
        { value: "per-channel-peer", label: "Per Channel+Peer" },
        { value: "per-account-channel-peer", label: "Per Account+Channel+Peer" },
      ], this._onChange, { id: "field-sess-dmScope" })}

      <hr class="divider" />
      <div class="section-title">Pruning</div>
      ${renderCheckbox(this.form, "session.pruning.enabled", "Enable Pruning", this._onChange, { id: "field-sess-pruning" })}
      ${renderNumberField(this.form, "session.pruning.maxEntries", "Max Entries", this._onChange, { id: "field-sess-pruning-max", min: "1" })}

      <div class="section-title">Compaction</div>
      ${renderCheckbox(this.form, "session.compaction.enabled", "Enable Compaction", this._onChange, { id: "field-sess-compaction" })}
      ${renderNumberField(this.form, "session.compaction.threshold", "Threshold (messages)", this._onChange, { id: "field-sess-compaction-threshold", min: "1" })}
    `;
  }
}
