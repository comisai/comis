// SPDX-License-Identifier: Apache-2.0
/**
 * Delivery section sub-editor for system-wide delivery queue and mirror configuration.
 *
 * Renders: Delivery queue (7 fields) and delivery mirror (5 fields).
 * Uses config.read/config.patch RPC flow and emits `config-change` events.
 */
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { renderNumberField, renderCheckbox } from "./editor-helpers.js";
import type { EditorForm } from "./editor-types.js";
import type { ConfigChangeDetail } from "./agent-streaming-editor.js";

@customElement("ic-agent-delivery-editor")
export class IcAgentDeliveryEditor extends LitElement {
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

    .field input {
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

    .field input:focus {
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

    .section-divider {
      margin: var(--ic-space-lg) 0 var(--ic-space-md);
      padding-bottom: var(--ic-space-sm);
      border-bottom: 1px solid var(--ic-border);
      font-size: var(--ic-text-xs);
      font-weight: 600;
      color: var(--ic-text-dim);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    @media (max-width: 767px) {
      .field-row {
        grid-template-columns: 1fr;
      }
    }
  `;

  @property({ attribute: false }) deliveryQueueConfig: Record<string, unknown> = {};
  @property({ attribute: false }) deliveryMirrorConfig: Record<string, unknown> = {};

  /** Emit config-change for a delivery queue field. */
  private _onQueueChange = (key: string, value: unknown): void => {
    this.dispatchEvent(
      new CustomEvent<ConfigChangeDetail>("config-change", {
        detail: { section: "deliveryQueue", key, value },
        bubbles: true,
        composed: true,
      }),
    );
  };

  /** Emit config-change for a delivery mirror field. */
  private _onMirrorChange = (key: string, value: unknown): void => {
    this.dispatchEvent(
      new CustomEvent<ConfigChangeDetail>("config-change", {
        detail: { section: "deliveryMirror", key, value },
        bubbles: true,
        composed: true,
      }),
    );
  };

  /** Build a proxy form object for delivery queue fields. */
  private _queueForm(): EditorForm {
    const cfg = this.deliveryQueueConfig;
    return new Proxy({} as EditorForm, {
      get: (_target, prop: string) => {
        const val = cfg[prop];
        return val !== undefined && val !== null ? val : undefined;
      },
    });
  }

  /** Build a proxy form object for delivery mirror fields. */
  private _mirrorForm(): EditorForm {
    const cfg = this.deliveryMirrorConfig;
    return new Proxy({} as EditorForm, {
      get: (_target, prop: string) => {
        const val = cfg[prop];
        return val !== undefined && val !== null ? val : undefined;
      },
    });
  }

  override render() {
    const queueForm = this._queueForm();
    const mirrorForm = this._mirrorForm();

    return html`
      <!-- Delivery Queue -->
      ${renderCheckbox(queueForm, "enabled", "Enabled", this._onQueueChange)}

      <div class="field-row">
        ${renderNumberField(queueForm, "maxQueueDepth", "Max Queue Depth", this._onQueueChange, { placeholder: "10000" })}
        ${renderNumberField(queueForm, "defaultMaxAttempts", "Default Max Attempts", this._onQueueChange, { placeholder: "5" })}
      </div>

      <div class="field-row">
        ${renderNumberField(queueForm, "defaultExpireMs", "Default Expire (ms)", this._onQueueChange, { placeholder: "3600000" })}
        ${renderCheckbox(queueForm, "drainOnStartup", "Drain on Startup", this._onQueueChange)}
      </div>

      <div class="field-row">
        ${renderNumberField(queueForm, "drainBudgetMs", "Drain Budget (ms)", this._onQueueChange, { placeholder: "60000" })}
        ${renderNumberField(queueForm, "pruneIntervalMs", "Prune Interval (ms)", this._onQueueChange, { placeholder: "300000" })}
      </div>

      <!-- Delivery Mirror -->
      <div class="section-divider">Delivery Mirror</div>

      ${renderCheckbox(mirrorForm, "enabled", "Enabled", this._onMirrorChange)}

      <div class="field-row">
        ${renderNumberField(mirrorForm, "retentionMs", "Retention (ms)", this._onMirrorChange, { placeholder: "86400000" })}
        ${renderNumberField(mirrorForm, "pruneIntervalMs", "Prune Interval (ms)", this._onMirrorChange, { placeholder: "300000" })}
      </div>

      <div class="field-row">
        ${renderNumberField(mirrorForm, "maxEntriesPerInjection", "Max Entries per Injection", this._onMirrorChange, { placeholder: "10" })}
        ${renderNumberField(mirrorForm, "maxCharsPerInjection", "Max Chars per Injection", this._onMirrorChange, { placeholder: "4000" })}
      </div>
    `;
  }
}
