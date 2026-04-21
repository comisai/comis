// SPDX-License-Identifier: Apache-2.0
/**
 * Essential section sub-editor for agent configuration.
 *
 * Renders: Agent ID, Display Name, Provider/Model selects, Temperature,
 * Thinking Level, Max Steps, Max Tokens.
 */
import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { renderNumberField, renderTextField, renderSelectField, getField } from "./editor-helpers.js";
import type { EditorForm, FieldChangeDetail, CatalogProvider } from "./editor-types.js";

@customElement("ic-agent-essential-editor")
export class IcAgentEssentialEditor extends LitElement {
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

    @media (max-width: 767px) {
      .field-row {
        grid-template-columns: 1fr;
      }
    }
  `;

  @property({ attribute: false }) form: EditorForm = {};
  @property({ type: Boolean }) isNew = false;
  @property() agentId = "";
  @property({ attribute: false }) catalogProviders: CatalogProvider[] = [];

  private _emit(key: string, value: unknown): void {
    this.dispatchEvent(
      new CustomEvent<FieldChangeDetail>("field-change", {
        detail: { key, value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onChange = (key: string, value: unknown): void => {
    this._emit(key, value);
  };

  private _renderProviderModelFields() {
    const providers = this.catalogProviders.length > 0
      ? this.catalogProviders.map((p) => ({
          value: p.name,
          label: p.name.charAt(0).toUpperCase() + p.name.slice(1),
        }))
      : [{ value: "anthropic", label: "Anthropic" }];

    const currentProvider = getField(this.form, "provider", "anthropic") as string;
    const currentModel = getField(this.form, "model", "") as string;

    const catalogEntry = this.catalogProviders.find((p) => p.name === currentProvider);
    const models = (catalogEntry?.models ?? []).map((m) => ({
      id: m.modelId,
      label: m.displayName || m.modelId,
    }));
    const modelInList = !currentModel || models.some((m) => m.id === currentModel);

    if (currentProvider && !providers.some((p) => p.value === currentProvider)) {
      providers.unshift({ value: currentProvider, label: currentProvider });
    }

    return html`
      <div class="field">
        <label for="field-provider">Provider</label>
        <select
          id="field-provider"
          @change=${(e: Event) => {
            const newProvider = (e.target as HTMLSelectElement).value;
            this._emit("provider", newProvider);
            this._emit("model", "");
          }}
        >
          ${providers.map(
            (p) => html`<option value=${p.value} ?selected=${p.value === currentProvider}>${p.label}</option>`,
          )}
        </select>
      </div>
      <div class="field">
        <label for="field-model">Model</label>
        <select
          id="field-model"
          @change=${(e: Event) => this._emit("model", (e.target as HTMLSelectElement).value)}
        >
          <option value="" ?selected=${!currentModel}>-- Select model --</option>
          ${!modelInList && currentModel
            ? html`<option value=${currentModel} selected>${currentModel}</option>`
            : nothing}
          ${models.map(
            (m) => html`<option value=${m.id} ?selected=${m.id === currentModel}>${m.label}</option>`,
          )}
        </select>
      </div>
    `;
  }

  private _getSelectedModel() {
    const provider = getField(this.form, "provider", "anthropic") as string;
    const modelId = getField(this.form, "model", "") as string;
    const catalogEntry = this.catalogProviders.find((p) => p.name === provider);
    return catalogEntry?.models?.find((m) => m.modelId === modelId);
  }

  override render() {
    const selectedModel = this._getSelectedModel();
    const maxTokensPlaceholder = selectedModel?.maxTokens
      ? `Default: ${selectedModel.maxTokens.toLocaleString()}`
      : "Provider default";

    return html`
      ${this.isNew
        ? renderTextField(this.form, "id", "Agent ID", this._onChange, { id: "field-id", placeholder: "unique-agent-id" })
        : html`
            <div class="field">
              <label for="field-id">Agent ID</label>
              <input id="field-id" type="text" .value=${this.agentId} readonly />
            </div>
          `}
      ${renderTextField(this.form, "name", "Display Name", this._onChange, { id: "field-name", placeholder: "My Agent" })}
      <div class="field-row">
        ${this._renderProviderModelFields()}
      </div>
      <div class="field-row">
        ${renderNumberField(this.form, "temperature", "Temperature", this._onChange, { id: "field-temperature", step: "0.1", min: "0", max: "2", placeholder: "Default: 1.0" })}
        ${renderSelectField(this.form, "thinkingLevel", "Thinking Level", [
          { value: "none", label: "None" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ], this._onChange, { id: "field-thinkingLevel" })}
      </div>
      <div class="field-row">
        ${renderNumberField(this.form, "maxSteps", "Max Steps", this._onChange, { id: "field-maxSteps", min: "1" })}
        ${renderNumberField(this.form, "maxTokens", "Max Tokens", this._onChange, { id: "field-maxTokens", placeholder: maxTokensPlaceholder })}
      </div>
    `;
  }
}
