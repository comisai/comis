// SPDX-License-Identifier: Apache-2.0
/**
 * Queue / Overflow configuration sub-editor.
 *
 * Renders: Basic (enabled, maxConcurrentSessions, cleanupIdleMs, defaultMode),
 * Overflow (maxDepth, policy), Debounce Buffer (windowMs, maxBufferedMessages,
 * firstMessageImmediate), Follow-up (maxFollowupRuns, followupOnCompaction),
 * Priority Lanes (priorityEnabled, lanes JSON viewer).
 *
 * Emits `config-change` CustomEvent with { section: "queue", key, value }.
 * Parent shell handles the RPC call (config.patch).
 */
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  renderNumberField,
  renderSelectField,
  renderCheckbox,
} from "./editor-helpers.js";
import type { EditorForm } from "./editor-types.js";
import "../../../components/form/ic-json-editor.js";

/** Detail payload carried by the `config-change` event. */
export interface ConfigChangeDetail {
  section: string;
  key: string;
  value: unknown;
}

@customElement("ic-agent-queue-editor")
export class IcAgentQueueEditor extends LitElement {
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

    .checkbox-field {
      display: flex;
      align-items: center;
      gap: var(--ic-space-sm);
      margin-bottom: var(--ic-space-md);
    }

    .checkbox-field label {
      font-size: var(--ic-text-sm);
      color: var(--ic-text);
      cursor: pointer;
    }

    .checkbox-field input[type="checkbox"] {
      accent-color: var(--ic-accent);
    }

    .field-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--ic-space-md);
    }

    .section-title {
      font-size: var(--ic-text-sm);
      font-weight: 600;
      color: var(--ic-text);
      margin-top: var(--ic-space-lg);
      margin-bottom: var(--ic-space-sm);
    }

    .divider {
      border: none;
      border-top: 1px solid var(--ic-border);
      margin: var(--ic-space-md) 0 var(--ic-space-xs);
    }

    .json-section {
      margin-top: var(--ic-space-sm);
    }

    @media (max-width: 767px) {
      .field-row {
        grid-template-columns: 1fr;
      }
    }
  `;

  @property({ attribute: false }) config: Record<string, unknown> = {};

  private _emit(key: string, value: unknown): void {
    this.dispatchEvent(
      new CustomEvent<ConfigChangeDetail>("config-change", {
        detail: { section: "queue", key, value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Wrap onChange for flat fields. */
  private _onChange = (key: string, value: unknown): void => {
    this._emit(key, value);
  };

  /** Emit full nested object for sub-section changes. */
  private _onNestedChange(parentKey: string, childKey: string, value: unknown): void {
    const current = (this.config[parentKey] as Record<string, unknown>) ?? {};
    this._emit(parentKey, { ...current, [childKey]: value });
  }

  override render() {
    const form = this.config as EditorForm;
    const overflow = (this.config.defaultOverflow as Record<string, unknown>) ?? {};
    const debounce = (this.config.defaultDebounceBuffer as Record<string, unknown>) ?? {};
    const followup = (this.config.followup as Record<string, unknown>) ?? {};

    return html`
      <div class="section-title">Basic</div>
      ${renderCheckbox(form, "enabled", "Enabled", this._onChange)}
      <div class="field-row">
        ${renderNumberField(form, "maxConcurrentSessions", "Max Concurrent Sessions", this._onChange, { placeholder: "10" })}
        ${renderNumberField(form, "cleanupIdleMs", "Cleanup Idle (ms)", this._onChange, { placeholder: "600000" })}
      </div>
      ${renderSelectField(form, "defaultMode", "Default Mode", [
        { value: "followup", label: "Follow-up" },
        { value: "collect", label: "Collect" },
        { value: "steer", label: "Steer" },
        { value: "steer+followup", label: "Steer + Follow-up" },
      ], this._onChange)}

      <hr class="divider" />
      <div class="section-title">Overflow</div>
      <div class="field-row">
        ${renderNumberField(overflow as EditorForm, "maxDepth", "Max Depth", (_k, v) => this._onNestedChange("defaultOverflow", "maxDepth", v), { placeholder: "100" })}
        ${renderSelectField(overflow as EditorForm, "policy", "Policy", [
          { value: "drop-old", label: "Drop Old" },
          { value: "drop-new", label: "Drop New" },
          { value: "summarize", label: "Summarize" },
        ], (_k, v) => this._onNestedChange("defaultOverflow", "policy", v))}
      </div>

      <hr class="divider" />
      <div class="section-title">Debounce Buffer</div>
      <div class="field-row">
        ${renderNumberField(debounce as EditorForm, "windowMs", "Window (ms)", (_k, v) => this._onNestedChange("defaultDebounceBuffer", "windowMs", v), { placeholder: "0" })}
        ${renderNumberField(debounce as EditorForm, "maxBufferedMessages", "Max Buffered Messages", (_k, v) => this._onNestedChange("defaultDebounceBuffer", "maxBufferedMessages", v), { placeholder: "10" })}
      </div>
      ${renderCheckbox(debounce as EditorForm, "firstMessageImmediate", "First Message Immediate", (_k, v) => this._onNestedChange("defaultDebounceBuffer", "firstMessageImmediate", v))}

      <hr class="divider" />
      <div class="section-title">Follow-up</div>
      <div class="field-row">
        ${renderNumberField(followup as EditorForm, "maxFollowupRuns", "Max Follow-up Runs", (_k, v) => this._onNestedChange("followup", "maxFollowupRuns", v), { placeholder: "3" })}
      </div>
      ${renderCheckbox(followup as EditorForm, "followupOnCompaction", "Follow-up on Compaction", (_k, v) => this._onNestedChange("followup", "followupOnCompaction", v))}

      <hr class="divider" />
      <div class="section-title">Priority Lanes</div>
      ${renderCheckbox(form, "priorityEnabled", "Priority Enabled", this._onChange)}
      <div class="json-section">
        <ic-json-editor
          label="Priority Lanes (key-value)"
          .value=${this._lanesToRecord()}
          @change=${this._handleLanesChange}
        ></ic-json-editor>
      </div>
    `;
  }

  /** Convert lanes array to Record for ic-json-editor display. */
  private _lanesToRecord(): Record<string, string> {
    const lanes = this.config.priorityLanes;
    if (!Array.isArray(lanes)) return {};
    const record: Record<string, string> = {};
    for (const lane of lanes) {
      if (lane && typeof lane === "object") {
        const l = lane as Record<string, unknown>;
        const name = String(l.name ?? l.label ?? `lane-${Object.keys(record).length}`);
        record[name] = JSON.stringify(l);
      }
    }
    return record;
  }

  /** Convert ic-json-editor Record back to lanes array. */
  private _handleLanesChange = (e: CustomEvent<Record<string, string>>): void => {
    const record = e.detail;
    const lanes: Record<string, unknown>[] = [];
    for (const [, val] of Object.entries(record)) {
      try {
        lanes.push(JSON.parse(val));
      } catch {
        // Skip invalid JSON values
      }
    }
    this._emit("priorityLanes", lanes);
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-agent-queue-editor": IcAgentQueueEditor;
  }
}
