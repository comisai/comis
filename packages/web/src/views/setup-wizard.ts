// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import { IcToast } from "../components/feedback/ic-toast.js";

// Side-effect imports for sub-components
import "../components/display/ic-platform-icon.js";
import "../components/display/ic-icon.js";

import {
  createSetupWizardController,
  STEPS,
  LOG_LEVELS,
  CHANNEL_PLATFORMS,
  CUSTOM_PROVIDER_KEY,
  CUSTOM_PROVIDER_HINT,
  getProviderHint,
  type SetupWizardController,
  type SetupWizardSnapshot,
  type ChannelPlatform,
  type WizardData,
  type ChannelSetup,
} from "./setup-wizard-controller.js";

interface FieldOpts {
  label: string;
  value: string;
  type?: "text" | "password" | "number";
  placeholder?: string;
  hint?: string;
  error?: string;
  readonly?: boolean;
  min?: string;
  max?: string;
  step?: string;
  onInput: (value: string) => void;
}

/**
 * Setup wizard with 5-step guided flow for new operators.
 *
 * Steps: Basics, Provider, Agent, Channels, Review & Launch.
 * Generates YAML configuration with copy, download, and apply actions.
 * Covers all guided flow steps through review and launch.
 *
 * State + RPC orchestration is owned by `SetupWizardController`. This view
 * owns Lit lifecycle + render() + template helpers; all reads go through
 * `this._controller.getSnapshot()` and all mutations go through
 * `this._controller.<action>()`.
 */
@customElement("ic-setup-wizard")
export class IcSetupWizard extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host { display: block; }
      .wizard-header { margin-bottom: var(--ic-space-lg); }
      .wizard-title { font-size: 1.125rem; font-weight: 600; }
      .wizard-subtitle {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        margin-top: var(--ic-space-xs);
      }
      /* Step progress bar */
      .step-bar {
        display: flex;
        align-items: flex-start;
        justify-content: center;
        gap: 0;
        margin-bottom: var(--ic-space-xl, 2rem);
      }
      .step-item {
        display: flex;
        flex-direction: column;
        align-items: center;
        min-width: 80px;
      }
      .step-circle {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: var(--ic-text-sm);
        font-weight: 600;
        border: 2px solid var(--ic-border);
        background: var(--ic-surface-2);
        color: var(--ic-text-dim);
        position: relative;
      }
      .step-circle.completed {
        background: var(--ic-accent);
        border-color: var(--ic-accent);
        color: white;
      }
      .step-circle.current {
        border-color: var(--ic-accent);
        color: var(--ic-accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--ic-accent) 25%, transparent);
      }
      .step-label {
        font-size: var(--ic-text-xs);
        margin-top: var(--ic-space-xs);
        color: var(--ic-text-dim);
        text-align: center;
      }
      .step-label.current { color: var(--ic-text); font-weight: 500; }
      .step-label.completed { color: var(--ic-text-muted); }
      .step-line {
        flex: 1;
        height: 2px;
        background: var(--ic-border);
        margin-top: 16px;
        min-width: 40px;
        max-width: 80px;
      }
      .step-line.completed { background: var(--ic-accent); }
      /* Step content area */
      .step-content { max-width: 640px; margin: 0 auto; min-height: 300px; }
      /* Form styling */
      .form-container { max-width: 500px; }
      .form-field {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
        margin-bottom: var(--ic-space-md);
      }
      .form-label {
        font-size: var(--ic-text-sm);
        font-weight: 500;
        color: var(--ic-text-muted);
      }
      .form-input {
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
      }
      .form-input:focus { outline: none; border-color: var(--ic-accent); }
      .form-input::placeholder { color: var(--ic-text-dim); }
      .form-hint { font-size: var(--ic-text-xs); color: var(--ic-text-dim); }
      .form-error { font-size: var(--ic-text-xs); color: var(--ic-error); }
      .form-select {
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
      }
      .form-select:focus { outline: none; border-color: var(--ic-accent); }
      /* Provider cards */
      .provider-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.75rem;
        margin-bottom: var(--ic-space-lg);
      }
      @media (max-width: 768px) {
        .provider-grid { grid-template-columns: repeat(2, 1fr); }
      }
      @media (max-width: 480px) {
        .provider-grid { grid-template-columns: 1fr; }
      }
      .provider-card {
        padding: 1rem;
        background: var(--ic-surface);
        border: 2px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        cursor: pointer;
        transition: border-color var(--ic-transition, 150ms), background var(--ic-transition, 150ms);
      }
      .provider-card:hover { border-color: var(--ic-text-dim); }
      .provider-card.active {
        border-color: var(--ic-accent);
        background: var(--ic-surface-2);
      }
      .provider-card-name {
        font-weight: 600;
        font-size: var(--ic-text-sm);
        margin-bottom: var(--ic-space-xs);
      }
      .provider-card-desc { font-size: var(--ic-text-xs); color: var(--ic-text-muted); }
      /* Provider config section */
      .provider-config { margin-top: var(--ic-space-lg); max-width: 500px; }
      /* Test connection */
      .test-row {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        margin-top: var(--ic-space-sm);
      }
      .test-btn {
        padding: 0.375rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text-muted);
        font-size: var(--ic-text-xs);
        font-family: inherit;
        cursor: pointer;
        white-space: nowrap;
      }
      .test-btn:hover { background: var(--ic-border); }
      .test-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .test-success {
        font-size: var(--ic-text-xs);
        color: var(--ic-success);
        display: flex;
        align-items: center;
        gap: 0.25rem;
      }
      .test-error {
        font-size: var(--ic-text-xs);
        color: var(--ic-error);
        display: flex;
        align-items: center;
        gap: 0.25rem;
      }
      .test-spinner { font-size: var(--ic-text-xs); color: var(--ic-text-muted); }
      /* Info box */
      .info-box {
        padding: 0.75rem 1rem;
        background: color-mix(in srgb, var(--ic-accent) 10%, transparent);
        border: 1px solid color-mix(in srgb, var(--ic-accent) 30%, transparent);
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        margin-bottom: var(--ic-space-md);
      }
      /* Channel cards */
      .channel-cards { display: flex; flex-direction: column; gap: 0.75rem; }
      .channel-card {
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        overflow: hidden;
      }
      .channel-header {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        padding: 0.75rem 1rem;
        cursor: pointer;
        background: var(--ic-surface);
        user-select: none;
      }
      .channel-header:hover { background: var(--ic-surface-2); }
      .channel-name { font-weight: 500; font-size: var(--ic-text-sm); flex: 1; }
      .channel-toggle {
        width: 36px;
        height: 20px;
        border-radius: 10px;
        border: none;
        cursor: pointer;
        position: relative;
        background: var(--ic-border);
        transition: background var(--ic-transition, 150ms);
        padding: 0;
      }
      .channel-toggle.enabled { background: var(--ic-accent); }
      .channel-toggle::after {
        content: "";
        position: absolute;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: white;
        top: 2px;
        left: 2px;
        transition: transform var(--ic-transition, 150ms);
      }
      .channel-toggle.enabled::after { transform: translateX(16px); }
      .channel-expand {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        transition: transform var(--ic-transition, 150ms);
      }
      .channel-expand.open { transform: rotate(180deg); }
      .channel-body {
        padding: 0.75rem 1rem 1rem;
        border-top: 1px solid var(--ic-border);
        background: var(--ic-surface-2);
      }
      /* Review YAML preview */
      .yaml-preview {
        background: var(--ic-surface-2);
        color: var(--ic-text);
        padding: 1rem;
        border-radius: var(--ic-radius-md);
        border: 1px solid var(--ic-border);
        max-height: 500px;
        overflow: auto;
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-sm);
        white-space: pre;
        line-height: 1.5;
      }
      .review-actions {
        display: flex;
        gap: var(--ic-space-sm);
        margin-top: var(--ic-space-md);
        flex-wrap: wrap;
      }
      .btn {
        padding: 0.5rem 1rem;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        border: none;
        white-space: nowrap;
      }
      .btn-primary { background: var(--ic-accent); color: white; }
      .btn-primary:hover { opacity: 0.9; }
      .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
      .btn-secondary {
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        color: var(--ic-text-muted);
      }
      .btn-secondary:hover { background: var(--ic-border); }
      .apply-status {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        margin-top: var(--ic-space-sm);
      }
      .dashboard-link { margin-top: var(--ic-space-md); }
      .dashboard-link a {
        color: var(--ic-accent);
        cursor: pointer;
        text-decoration: underline;
        font-size: var(--ic-text-sm);
      }
      /* Navigation bar */
      .nav-bar {
        display: flex;
        justify-content: space-between;
        margin-top: var(--ic-space-xl, 2rem);
        padding-top: var(--ic-space-md);
        border-top: 1px solid var(--ic-border);
      }
      .nav-spacer { flex: 1; }
    `,
  ];

  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @state() private _controller: SetupWizardController | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.rpcClient) {
      this._controller = createSetupWizardController(this, this.rpcClient);
    }
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("rpcClient") && this.rpcClient && !this._controller) {
      this._controller = createSetupWizardController(this, this.rpcClient);
    }
  }

  private async _copyYaml(): Promise<void> {
    const yaml = this._controller?.getSnapshot().yamlPreview ?? "";
    try {
      await navigator.clipboard.writeText(yaml);
      IcToast.show("Copied to clipboard", "success");
    } catch {
      IcToast.show("Failed to copy", "error");
    }
  }

  private _downloadYaml(): void {
    const yaml = this._controller?.getSnapshot().yamlPreview ?? "";
    const blob = new Blob([yaml], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "comis-config.yaml";
    a.click();
    URL.revokeObjectURL(url);
  }

  private _goToDashboard(): void {
    this.dispatchEvent(new CustomEvent("navigate", { detail: "dashboard", bubbles: true, composed: true }));
  }

  /** Generic form-field renderer used across steps 1, 2, and 3. */
  private _renderField(o: FieldOpts) {
    return html`
      <div class="form-field">
        <label class="form-label">${o.label}</label>
        <input class="form-input" type=${o.type ?? "text"} ?readonly=${o.readonly ?? false}
          min=${o.min ?? ""} max=${o.max ?? ""} step=${o.step ?? ""}
          placeholder=${o.placeholder ?? ""} .value=${o.value}
          @input=${(e: Event) => o.onInput((e.target as HTMLInputElement).value)} />
        ${o.hint ? html`<span class="form-hint">${o.hint}</span>` : nothing}
        ${o.error ? html`<span class="form-error">${o.error}</span>` : nothing}
      </div>
    `;
  }

  private _renderStep1(snap: SetupWizardSnapshot) {
    const d = snap.wizardData;
    const errors = snap.validationErrors;
    const ctrl = this._controller;

    return html`
      <div class="form-container">
        ${this._renderField({
          label: "Tenant ID",
          value: d.tenantId,
          hint: "Unique identifier for this installation",
          error: errors["tenantId"],
          onInput: (v) => ctrl?.updateWizardData({ tenantId: v }),
        })}
        ${this._renderField({
          label: "Data Directory",
          value: d.dataDir,
          hint: "Where Comis stores databases and logs",
          onInput: (v) => ctrl?.updateWizardData({ dataDir: v }),
        })}
        <div class="form-field">
          <label class="form-label">Log Level</label>
          ${this._renderLogLevelSelect(d)}
        </div>
        ${this._renderField({
          label: "Gateway Host",
          value: d.gatewayHost,
          onInput: (v) => ctrl?.updateWizardData({ gatewayHost: v }),
        })}
        ${this._renderField({
          label: "Gateway Port",
          value: String(d.gatewayPort),
          type: "number",
          min: "1",
          max: "65535",
          onInput: (v) => ctrl?.updateWizardData({ gatewayPort: Number(v) || 4766 }),
        })}
      </div>
    `;
  }

  /** Separate method for log level select to avoid Lit duplicate attribute binding. */
  private _renderLogLevelSelect(d: WizardData) {
    return html`
      <select
        class="form-select"
        @change=${(e: Event) => {
          this._controller?.updateWizardData({ logLevel: (e.target as HTMLSelectElement).value });
        }}
      >
        ${LOG_LEVELS.map(
          (level) => html`<option value=${level} ?selected=${level === d.logLevel}>${level}</option>`,
        )}
      </select>
    `;
  }

  private _renderStep2(snap: SetupWizardSnapshot) {
    const d = snap.wizardData;
    const errors = snap.validationErrors;
    return html`
      ${this._renderProviderGrid(snap, d.providerName)}
      ${errors["providerType"] ? html`<span class="form-error">${errors["providerType"]}</span>` : nothing}
      ${d.providerName ? this._renderProviderConfig(snap, d.providerName) : nothing}
    `;
  }

  private _renderProviderGrid(snap: SetupWizardSnapshot, selected: string) {
    if (snap.catalogProvidersLoading) {
      return html`<div class="provider-grid-loading">Loading providers from catalog...</div>`;
    }
    if (snap.catalogProvidersError) {
      return html`
        <div class="provider-grid-error">
          <span class="form-error">Failed to load provider catalog: ${snap.catalogProvidersError}</span>
          <button class="test-btn" @click=${() => { void this._controller?.loadCatalogProviders(); }}>Retry</button>
        </div>
      `;
    }
    const providerKeys = [...snap.catalogProviders, CUSTOM_PROVIDER_KEY];
    return html`
      <div class="provider-grid">
        ${providerKeys.map((key) => this._renderProviderCard(key, selected))}
      </div>
    `;
  }

  private _renderProviderCard(key: string, selected: string) {
    const hint = key === CUSTOM_PROVIDER_KEY ? CUSTOM_PROVIDER_HINT : getProviderHint(key);
    const active = selected === key;
    const onSelect = () => this._controller?.selectProvider(key);
    return html`
      <div class="provider-card ${active ? "active" : ""}" role="button" tabindex="0"
        aria-pressed=${active ? "true" : "false"}
        @click=${onSelect}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); }
        }}>
        <div class="provider-card-name">${hint.displayName}</div>
        <div class="provider-card-desc">${hint.description}</div>
      </div>
    `;
  }

  private _renderProviderConfig(snap: SetupWizardSnapshot, providerKey: string) {
    const d = snap.wizardData;
    const errors = snap.validationErrors;
    const isCustom = providerKey === CUSTOM_PROVIDER_KEY;
    const hint = isCustom ? CUSTOM_PROVIDER_HINT : getProviderHint(providerKey);
    const ctrl = this._controller;

    return html`
      <div class="provider-config">
        ${hint.needsApiKey ? this._renderField({
          label: "API Key",
          value: d.apiKey,
          type: "password",
          placeholder: "Enter your API key",
          error: errors["apiKey"],
          onInput: (v) => ctrl?.updateWizardData({ apiKey: v }),
        }) : nothing}
        ${hint.needsBaseUrl ? this._renderField({
          label: "Base URL",
          value: d.baseUrl,
          placeholder: hint.defaultBaseUrl || "https://api.example.com",
          error: errors["baseUrl"],
          onInput: (v) => ctrl?.updateWizardData({ baseUrl: v }),
        }) : nothing}

        ${this._renderModelField(snap, isCustom)}
        <div class="test-row">
          <button class="test-btn" ?disabled=${snap.testResult.status === "testing"}
            @click=${() => this._controller?.testConnection()}>
            ${snap.testResult.status === "testing" ? "Testing..." : "Test Connection"}
          </button>
          ${snap.testResult.status === "success" ? html`<span class="test-success">Connected</span>` : nothing}
          ${snap.testResult.status === "error" ? html`<span class="test-error">${snap.testResult.message}</span>` : nothing}
          ${snap.testResult.status === "testing" ? html`<span class="test-spinner">Connecting...</span>` : nothing}
        </div>
      </div>
    `;
  }

  /** Custom providers render a free-text input; native providers render a dropdown
   *  populated from `_modelOptions` (sorted by total cost ascending). */
  private _renderModelField(snap: SetupWizardSnapshot, isCustom: boolean) {
    const d = snap.wizardData;
    const errors = snap.validationErrors;
    const ctrl = this._controller;
    if (isCustom) {
      return this._renderField({
        label: "Model ID",
        value: d.defaultModel,
        placeholder: "e.g., qwen/qwen3-coder",
        onInput: (v) => ctrl?.updateWizardData({ defaultModel: v }),
      });
    }
    if (snap.modelOptionsLoading) {
      return html`<div class="form-field"><label class="form-label">Model</label>
        <span class="test-spinner">Loading models from ${d.providerName}...</span></div>`;
    }
    if (snap.modelOptionsError) {
      return html`<div class="form-field"><label class="form-label">Model</label>
        <span class="form-error">Failed to load models: ${snap.modelOptionsError}</span>
        <button class="test-btn" @click=${() => { void ctrl?.loadModelOptions(d.providerName); }}>Retry</button></div>`;
    }
    return html`
      <div class="form-field">
        <label class="form-label">Model</label>
        <select class="form-select"
          @change=${(e: Event) => ctrl?.updateWizardData({ defaultModel: (e.target as HTMLSelectElement).value })}>
          <option value="" ?selected=${!d.defaultModel}>— select a model —</option>
          ${snap.modelOptions.map((m) => html`<option value=${m.id} ?selected=${m.id === d.defaultModel}>
            ${m.id}${m.cost > 0 ? ` ($${m.cost.toFixed(2)}/1M)` : " (free)"}
          </option>`)}
        </select>
        ${errors["defaultModel"] ? html`<span class="form-error">${errors["defaultModel"]}</span>` : nothing}
      </div>
    `;
  }

  private _renderStep3(snap: SetupWizardSnapshot) {
    const d = snap.wizardData;
    const errors = snap.validationErrors;
    const ctrl = this._controller;

    return html`
      <div class="form-container">
        <div class="info-box">
          The agent will use the provider configured in Step 2. You can add more agents later from the Agents view.
        </div>
        ${this._renderField({
          label: "Agent ID",
          value: d.agentId,
          hint: "Unique identifier (letters, numbers, hyphens)",
          error: errors["agentId"],
          onInput: (v) => ctrl?.updateWizardData({ agentId: v }),
        })}
        ${this._renderField({
          label: "Agent Name",
          value: d.agentName,
          hint: "Display name for the agent",
          onInput: (v) => ctrl?.updateWizardData({ agentName: v }),
        })}
        ${this._renderField({
          label: "Model",
          value: d.agentModel,
          hint: "LLM model ID to use",
          onInput: (v) => ctrl?.updateWizardData({ agentModel: v }),
        })}
        ${this._renderField({
          label: "Provider",
          value: d.agentProvider,
          readonly: true,
          onInput: () => undefined,
        })}
        ${this._renderField({
          label: "Max Steps",
          value: String(d.maxSteps),
          type: "number",
          min: "1",
          max: "100",
          onInput: (v) => ctrl?.updateWizardData({ maxSteps: Number(v) || 25 }),
        })}
        ${this._renderField({
          label: "Budget Per Day (tokens)",
          value: String(d.budgetPerDay),
          type: "number",
          min: "0",
          step: "0.01",
          onInput: (v) => ctrl?.updateWizardData({ budgetPerDay: Number(v) || 0 }),
        })}
        ${this._renderField({
          label: "Budget Per Hour (tokens)",
          value: String(d.budgetPerHour),
          type: "number",
          min: "0",
          step: "0.01",
          onInput: (v) => ctrl?.updateWizardData({ budgetPerHour: Number(v) || 0 }),
        })}
      </div>
    `;
  }

  private _renderStep4(snap: SetupWizardSnapshot) {
    return html`
      <div class="info-box">
        Enable the channels you want to connect. You can configure more channels later.
      </div>
      <div class="channel-cards">
        ${CHANNEL_PLATFORMS.map((platform) => this._renderChannelCard(snap, platform))}
      </div>
    `;
  }

  private _renderChannelCard(snap: SetupWizardSnapshot, platform: ChannelPlatform) {
    const channel = snap.wizardData.channels[platform.key];
    if (!channel) return nothing;
    const isExpanded = snap.expandedChannels.has(platform.key);

    return html`
      <div class="channel-card">
        <div
          class="channel-header"
          @click=${() => this._controller?.toggleExpand(platform.key)}
        >
          <ic-platform-icon platform=${platform.key} size="20px"></ic-platform-icon>
          <span class="channel-name">${platform.label}</span>
          <button
            class="channel-toggle ${channel.enabled ? "enabled" : ""}"
            aria-label="${channel.enabled ? "Disable" : "Enable"} ${platform.label}"
            @click=${(e: Event) => {
              e.stopPropagation();
              this._controller?.toggleChannel(platform.key);
            }}
          ></button>
          <span class="channel-expand ${isExpanded ? "open" : ""}">&#9660;</span>
        </div>
        ${isExpanded ? html`
          <div class="channel-body">
            ${this._renderChannelFields(snap, platform)}
          </div>
        ` : nothing}
      </div>
    `;
  }

  private _renderChannelFields(snap: SetupWizardSnapshot, platform: ChannelPlatform) {
    const creds = snap.wizardData.channels[platform.key]?.credentials ?? {};
    const ctrl = this._controller;
    return html`
      ${platform.fields.map((field) => this._renderField({
        label: field.label,
        type: field.type,
        value: creds[field.key] ?? field.defaultValue ?? "",
        placeholder: field.placeholder ?? "",
        onInput: (v) => ctrl?.updateChannelCredential(platform.key, field.key, v),
      }))}
    `;
  }

  private _renderStep5(snap: SetupWizardSnapshot) {
    return html`
      <div class="yaml-preview">${snap.yamlPreview}</div>
      <div class="review-actions">
        <button class="btn btn-secondary" @click=${() => this._copyYaml()}>Copy</button>
        <button class="btn btn-secondary" @click=${() => this._downloadYaml()}>Download</button>
        <button class="btn btn-primary" ?disabled=${snap.applying} @click=${() => this._controller?.applyConfig()}>
          ${snap.applying ? "Applying..." : "Apply"}
        </button>
      </div>
      ${snap.applyStatus ? html`<div class="apply-status">${snap.applyStatus}</div>` : nothing}
      ${snap.applyDone ? html`
        <div class="dashboard-link">
          <a @click=${(e: Event) => { e.preventDefault(); this._goToDashboard(); }}>Go to Dashboard</a>
        </div>
      ` : nothing}
    `;
  }

  private _renderStepBar(snap: SetupWizardSnapshot) {
    return html`
      <div class="step-bar" role="navigation" aria-label="Setup wizard progress">
        ${STEPS.map((step, i) => {
          const isCompleted = i < snap.currentStep;
          const isCurrent = i === snap.currentStep;
          const cls = isCompleted ? "completed" : isCurrent ? "current" : "";
          return html`
            ${i > 0 ? html`<div class="step-line ${i <= snap.currentStep ? "completed" : ""}"></div>` : nothing}
            <div class="step-item">
              <div class="step-circle ${cls}" aria-label="Step ${i + 1}: ${step.label}">
                ${isCompleted ? html`&#10003;` : html`${i + 1}`}
              </div>
              <span class="step-label ${cls}">${step.label}</span>
            </div>
          `;
        })}
      </div>
    `;
  }

  override render() {
    if (!this._controller) {
      return html`<div class="wizard-header"><div class="wizard-title">Setup Wizard</div></div>`;
    }
    const snap = this._controller.getSnapshot();
    return html`
      <div class="wizard-header">
        <div class="wizard-title">Setup Wizard</div>
        <div class="wizard-subtitle">Configure your Comis installation step by step</div>
      </div>
      ${this._renderStepBar(snap)}
      <div class="step-content">
        ${snap.currentStep === 0 ? this._renderStep1(snap) : nothing}
        ${snap.currentStep === 1 ? this._renderStep2(snap) : nothing}
        ${snap.currentStep === 2 ? this._renderStep3(snap) : nothing}
        ${snap.currentStep === 3 ? this._renderStep4(snap) : nothing}
        ${snap.currentStep === 4 ? this._renderStep5(snap) : nothing}
      </div>
      <div class="nav-bar">
        ${snap.currentStep > 0
          ? html`<button class="btn btn-secondary" @click=${() => this._controller?.goBack()}>Back</button>`
          : html`<div class="nav-spacer"></div>`}
        ${snap.currentStep < 4
          ? html`<button class="btn btn-primary" @click=${() => this._controller?.goNext()}>
              ${snap.currentStep === 3 ? "Review" : "Next"}
            </button>`
          : html`<div class="nav-spacer"></div>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-setup-wizard": IcSetupWizard;
  }
}

export type { WizardData, ChannelSetup };
