/**
 * Auto-Reply engine configuration sub-editor.
 *
 * Renders: enabled, groupActivation, customPatterns (via ic-array-editor),
 * historyInjection, maxHistoryInjections, maxGroupHistoryMessages.
 *
 * Emits `config-change` CustomEvent with { section: "autoReplyEngine", key, value }.
 * Parent shell handles the RPC call (config.patch).
 */
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  renderNumberField,
  renderSelectField,
  renderCheckbox,
  getField,
} from "./editor-helpers.js";
import type { EditorForm } from "./editor-types.js";
import type { ConfigChangeDetail } from "./agent-queue-editor.js";
import "../../../components/form/ic-array-editor.js";

@customElement("ic-agent-auto-reply-editor")
export class IcAgentAutoReplyEditor extends LitElement {
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

    .patterns-section {
      margin-bottom: var(--ic-space-md);
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
        detail: { section: "autoReplyEngine", key, value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onChange = (key: string, value: unknown): void => {
    this._emit(key, value);
  };

  override render() {
    const form = this.config as EditorForm;
    const patterns = getField<string[]>(form, "customPatterns", []);

    return html`
      ${renderCheckbox(form, "enabled", "Enabled", this._onChange)}
      ${renderSelectField(form, "groupActivation", "Group Activation", [
        { value: "always", label: "Always" },
        { value: "mention-gated", label: "Mention-Gated" },
        { value: "custom", label: "Custom" },
      ], this._onChange)}

      <div class="patterns-section">
        <ic-array-editor
          label="Custom Patterns"
          .items=${Array.isArray(patterns) ? patterns : []}
          placeholder="Add regex pattern..."
          @change=${(e: CustomEvent<string[]>) => this._emit("customPatterns", e.detail)}
        ></ic-array-editor>
      </div>

      ${renderCheckbox(form, "historyInjection", "History Injection", this._onChange)}
      <div class="field-row">
        ${renderNumberField(form, "maxHistoryInjections", "Max History Injections", this._onChange, { placeholder: "50" })}
        ${renderNumberField(form, "maxGroupHistoryMessages", "Max Group History Messages", this._onChange, { placeholder: "20" })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-agent-auto-reply-editor": IcAgentAutoReplyEditor;
  }
}
