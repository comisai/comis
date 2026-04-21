// SPDX-License-Identifier: Apache-2.0
/**
 * Send Policy configuration sub-editor.
 *
 * Renders: enabled, defaultAction, and a custom rule list with
 * channelType, chatType, channelId, action, and description per rule.
 *
 * Emits `config-change` CustomEvent with { section: "sendPolicy", key, value }.
 * Parent shell handles the RPC call (config.patch).
 */
import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  renderSelectField,
  renderCheckbox,
} from "./editor-helpers.js";
import type { EditorForm } from "./editor-types.js";
import type { ConfigChangeDetail } from "./agent-queue-editor.js";

interface SendPolicyRule {
  channelType?: string;
  chatType?: string;
  channelId?: string;
  action: string;
  description?: string;
}

@customElement("ic-agent-send-policy-editor")
export class IcAgentSendPolicyEditor extends LitElement {
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

    .rules-list {
      display: flex;
      flex-direction: column;
      gap: var(--ic-space-sm);
    }

    .rule-row {
      display: grid;
      grid-template-columns: 1fr 1fr 1.5fr 0.8fr 1.5fr auto;
      gap: var(--ic-space-xs);
      align-items: center;
      background: var(--ic-surface);
      border: 1px solid var(--ic-border);
      border-radius: var(--ic-radius-md);
      padding: var(--ic-space-sm);
    }

    .rule-row select,
    .rule-row input {
      background: var(--ic-surface-2);
      border: 1px solid var(--ic-border);
      border-radius: var(--ic-radius-sm);
      padding: 4px 6px;
      color: var(--ic-text);
      font-family: inherit;
      font-size: var(--ic-text-xs);
      outline: none;
    }

    .rule-row select:focus,
    .rule-row input:focus {
      border-color: var(--ic-accent);
    }

    .btn-icon {
      background: none;
      border: none;
      color: var(--ic-text-dim);
      cursor: pointer;
      padding: 2px 6px;
      font-size: var(--ic-text-sm);
      line-height: 1;
      border-radius: var(--ic-radius-sm);
    }

    .btn-icon:hover {
      color: var(--ic-error);
    }

    .btn-add {
      padding: var(--ic-space-xs) var(--ic-space-md);
      background: var(--ic-accent);
      color: white;
      border: none;
      border-radius: var(--ic-radius-md);
      font-size: var(--ic-text-sm);
      cursor: pointer;
      margin-top: var(--ic-space-sm);
      width: fit-content;
    }

    .btn-add:hover {
      opacity: 0.9;
    }

    .empty-hint {
      font-size: var(--ic-text-xs);
      color: var(--ic-text-dim);
      font-style: italic;
    }

    @media (max-width: 767px) {
      .rule-row {
        grid-template-columns: 1fr 1fr;
      }
    }
  `;

  @property({ attribute: false }) config: Record<string, unknown> = {};
  @state() private _rules: SendPolicyRule[] = [];

  override willUpdate(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("config") && this.config.rules) {
      const raw = this.config.rules;
      if (Array.isArray(raw)) {
        this._rules = raw.map((r) => {
          const rule = r as Record<string, unknown>;
          return {
            channelType: (rule.channelType as string) ?? "any",
            chatType: (rule.chatType as string) ?? "any",
            channelId: (rule.channelId as string) ?? "",
            action: (rule.action as string) ?? "allow",
            description: (rule.description as string) ?? "",
          };
        });
      }
    }
  }

  private _emit(key: string, value: unknown): void {
    this.dispatchEvent(
      new CustomEvent<ConfigChangeDetail>("config-change", {
        detail: { section: "sendPolicy", key, value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onChange = (key: string, value: unknown): void => {
    this._emit(key, value);
  };

  private _addRule(): void {
    this._rules = [
      ...this._rules,
      { channelType: "any", chatType: "any", channelId: "", action: "allow", description: "" },
    ];
    this._emitRules();
  }

  private _removeRule(index: number): void {
    this._rules = this._rules.filter((_, i) => i !== index);
    this._emitRules();
  }

  private _updateRule(index: number, field: keyof SendPolicyRule, value: string): void {
    this._rules = this._rules.map((r, i) =>
      i === index ? { ...r, [field]: value } : r,
    );
    this._emitRules();
  }

  private _emitRules(): void {
    this._emit("rules", this._rules);
  }

  override render() {
    const form = this.config as EditorForm;

    return html`
      ${renderCheckbox(form, "enabled", "Enabled", this._onChange)}
      ${renderSelectField(form, "defaultAction", "Default Action", [
        { value: "allow", label: "Allow" },
        { value: "deny", label: "Deny" },
      ], this._onChange)}

      <hr class="divider" />
      <div class="section-title">Rules</div>

      ${this._rules.length > 0
        ? html`
            <div class="rules-list">
              ${this._rules.map((rule, i) => html`
                <div class="rule-row">
                  <select
                    .value=${rule.channelType ?? "any"}
                    @change=${(e: Event) => this._updateRule(i, "channelType", (e.target as HTMLSelectElement).value)}
                  >
                    <option value="any">Any Channel</option>
                    <option value="telegram">Telegram</option>
                    <option value="discord">Discord</option>
                    <option value="slack">Slack</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="signal">Signal</option>
                    <option value="irc">IRC</option>
                    <option value="line">LINE</option>
                  </select>
                  <select
                    .value=${rule.chatType ?? "any"}
                    @change=${(e: Event) => this._updateRule(i, "chatType", (e.target as HTMLSelectElement).value)}
                  >
                    <option value="any">Any Chat</option>
                    <option value="dm">DM</option>
                    <option value="group">Group</option>
                    <option value="thread">Thread</option>
                  </select>
                  <input
                    type="text"
                    placeholder="channelId (optional)"
                    .value=${rule.channelId ?? ""}
                    @input=${(e: Event) => this._updateRule(i, "channelId", (e.target as HTMLInputElement).value)}
                  />
                  <select
                    .value=${rule.action ?? "allow"}
                    @change=${(e: Event) => this._updateRule(i, "action", (e.target as HTMLSelectElement).value)}
                  >
                    <option value="allow">Allow</option>
                    <option value="deny">Deny</option>
                  </select>
                  <input
                    type="text"
                    placeholder="description (optional)"
                    .value=${rule.description ?? ""}
                    @input=${(e: Event) => this._updateRule(i, "description", (e.target as HTMLInputElement).value)}
                  />
                  <button class="btn-icon" @click=${() => this._removeRule(i)} aria-label="Remove rule">\u2715</button>
                </div>
              `)}
            </div>
          `
        : html`<div class="empty-hint">No rules defined. Default action applies to all messages.</div>`}

      <button class="btn-add" @click=${() => this._addRule()}>Add Rule</button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-agent-send-policy-editor": IcAgentSendPolicyEditor;
  }
}
