import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { ApiClient } from "../api/api-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { SseController } from "../state/sse-controller.js";
import { IcToast } from "../components/feedback/ic-toast.js";
// Side-effect imports for sub-components
import "../components/nav/ic-tabs.js";
import "../components/feedback/ic-empty-state.js";
import "../components/feedback/ic-loading.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/data/ic-tag.js";
import "../components/display/ic-icon.js";
import "../components/display/ic-connection-dot.js";
import "../components/data/ic-provider-card.js";
import "../components/form/ic-search-input.js";

type LoadState = "loading" | "loaded" | "error";

interface ProviderEntry {
  type: string;
  name: string;
  baseUrl: string;
  apiKeyName: string;
  enabled: boolean;
  timeoutMs: number;
  maxRetries: number;
}

interface ModelInfo {
  provider: string;
  modelId: string;
  displayName: string;
  contextWindow: number;
  maxTokens: number;
  input: boolean;
  reasoning: boolean;
  validated: boolean;
}

interface ModelAlias {
  alias: string;
  provider: string;
  modelId: string;
}

interface TestResult {
  status: string;
  modelsAvailable?: number;
  validatedModels?: number;
  agentsUsing?: Array<{ agentId: string; model: string }>;
}

interface AgentOverride {
  id: string;
  provider: string;
  model: string;
}


/** Tab definitions for the models view. */
const TABS = [
  { id: "providers", label: "Providers" },
  { id: "models", label: "Catalog" },
  { id: "aliases", label: "Aliases" },
  { id: "defaults", label: "Defaults" },
];

/**
 * Models management view with 4 tabs for managing providers,
 * available models, aliases, and defaults.
 *
 * Loads data via config.read and models.list RPC, persists changes
 * via config.patch. Provider testing uses models.test RPC.
 */
@customElement("ic-models-view")
export class IcModelsView extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .view-header {
        margin-bottom: var(--ic-space-lg);
      }

      .view-title {
        font-size: 1.125rem;
        font-weight: 600;
      }

      /* Loading & error states */
      .state-container {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 3rem;
      }

      .error-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
        padding: 3rem;
      }

      .error-message {
        color: var(--ic-error);
        font-size: var(--ic-text-sm);
      }

      .retry-btn {
        padding: 0.5rem 1rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        font-family: inherit;
      }

      .retry-btn:hover {
        background: var(--ic-border);
      }

      /* Provider grid */
      .provider-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
        gap: var(--ic-space-md);
      }

      /* Provider editor form */
      .editor-form {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm);
        max-width: 32rem;
        margin-top: var(--ic-space-lg);
      }

      .editor-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-muted);
      }

      .form-field {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
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

      .form-input:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .form-input:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .form-actions {
        display: flex;
        gap: var(--ic-space-sm);
        margin-top: var(--ic-space-xs);
      }

      .btn {
        padding: 0.375rem 0.75rem;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-xs);
        font-family: inherit;
        cursor: pointer;
        border: none;
        white-space: nowrap;
      }

      .btn-primary {
        background: var(--ic-accent);
        color: white;
      }

      .btn-primary:hover {
        opacity: 0.9;
      }

      .btn-secondary {
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        color: var(--ic-text-muted);
      }

      .btn-secondary:hover {
        background: var(--ic-border);
      }

      .btn-danger {
        background: var(--ic-error);
        color: white;
      }

      .btn-danger:hover {
        opacity: 0.9;
      }

      .btn-add {
        padding: 0.5rem 1rem;
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        margin-top: var(--ic-space-md);
      }

      .btn-add:hover {
        opacity: 0.9;
      }

      /* Models table */
      .models-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--ic-text-sm);
      }

      .models-table th {
        text-align: left;
        padding: var(--ic-space-sm) var(--ic-space-md);
        color: var(--ic-text-muted);
        font-weight: 600;
        font-size: var(--ic-text-xs);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border-bottom: 1px solid var(--ic-border);
      }

      .models-table td {
        padding: var(--ic-space-sm) var(--ic-space-md);
        border-bottom: 1px solid var(--ic-border);
      }

      .models-table tr:nth-child(even) {
        background: var(--ic-surface);
      }

      .models-table tr:nth-child(odd) {
        background: var(--ic-surface-2);
      }

      .validated-icon {
        color: var(--ic-success);
      }

      /* Aliases table */
      .alias-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--ic-text-sm);
      }

      .alias-table th {
        text-align: left;
        padding: var(--ic-space-sm) var(--ic-space-md);
        color: var(--ic-text-muted);
        font-weight: 600;
        font-size: var(--ic-text-xs);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border-bottom: 1px solid var(--ic-border);
      }

      .alias-table td {
        padding: var(--ic-space-sm) var(--ic-space-md);
        border-bottom: 1px solid var(--ic-border);
      }

      .alias-table tr:nth-child(even) {
        background: var(--ic-surface);
      }

      .alias-table tr:nth-child(odd) {
        background: var(--ic-surface-2);
      }

      .alias-actions {
        display: flex;
        gap: var(--ic-space-xs);
      }

      .alias-form {
        display: flex;
        gap: var(--ic-space-sm);
        align-items: flex-end;
        flex-wrap: wrap;
        margin-top: var(--ic-space-md);
      }

      .alias-form .form-field {
        flex: 1;
        min-width: 8rem;
      }

      /* Defaults section */
      .defaults-section {
        max-width: 48rem;
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-lg);
      }

      .defaults-select {
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
        max-width: 20rem;
      }

      .defaults-select:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .defaults-summary {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
      }

      .mono {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
      }

      /* Filter bar for Available Models tab */
      .filter-bar {
        display: flex;
        align-items: center;
        gap: var(--ic-space-md);
        margin-bottom: var(--ic-space-md);
        flex-wrap: wrap;
      }

      .filter-bar ic-search-input {
        flex: 1;
        min-width: 12rem;
      }

      .filter-select {
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
        min-width: 8rem;
      }

      .filter-select:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .filter-count {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
        white-space: nowrap;
      }

      /* Defaults resolved indicator */
      .defaults-resolved {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        padding: var(--ic-space-sm) 0;
      }

      .defaults-resolved code {
        color: var(--ic-accent);
      }

      /* Per-agent overrides */
      .overrides-divider {
        border: none;
        border-top: 1px solid var(--ic-border);
        margin: var(--ic-space-lg) 0;
      }

      .overrides-heading {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-muted);
        margin-bottom: var(--ic-space-md);
      }

      .overrides-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--ic-text-sm);
      }

      .overrides-table th {
        text-align: left;
        padding: var(--ic-space-sm) var(--ic-space-md);
        color: var(--ic-text-muted);
        font-weight: 600;
        font-size: var(--ic-text-xs);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border-bottom: 1px solid var(--ic-border);
      }

      .overrides-table td {
        padding: var(--ic-space-sm) var(--ic-space-md);
        border-bottom: 1px solid var(--ic-border);
      }

      .overrides-table tr:nth-child(even) {
        background: var(--ic-surface);
      }

      .overrides-table tr:nth-child(odd) {
        background: var(--ic-surface-2);
      }

      .override-select {
        padding: 0.375rem 0.5rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-xs);
        max-width: 14rem;
      }

      .override-select:focus {
        outline: none;
        border-color: var(--ic-accent);
      }
    `,
  ];

  @property({ attribute: false }) apiClient: ApiClient | null = null;
  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  private _sse: SseController | null = null;
  private _reloadDebounce: ReturnType<typeof setTimeout> | null = null;

  @state() private _loadState: LoadState = "loading";
  @state() private _error = "";
  @state() private _activeTab = "providers";
  @state() private _providers: Record<string, ProviderEntry> = {};
  @state() private _models: ModelInfo[] = [];
  @state() private _aliases: ModelAlias[] = [];
  @state() private _defaultProvider = "";
  @state() private _defaultModel = "";
  @state() private _providerTestResults = new Map<string, TestResult>();
  @state() private _testingProviders = new Set<string>();

  // Provider editor state
  @state() private _editingProvider: string | null = null;
  @state() private _editForm = { name: "", type: "", baseUrl: "", apiKeyName: "" };

  // Alias editor state
  @state() private _editingAlias: number | null = null;
  @state() private _aliasForm = { alias: "", provider: "", modelId: "" };

  // Models tab filter state
  @state() private _modelsSearchQuery = "";
  @state() private _modelsProviderFilter = "";

  // Per-agent model overrides (Defaults tab)
  @state() private _agents: AgentOverride[] = [];

  override connectedCallback(): void {
    super.connectedCallback();
    // Note: _loadData() is NOT called here -- rpcClient is typically
    // null at this point. The updated() callback handles loading once
    // the client property is set.
    this._initSse();
  }

  private _rpcStatusUnsub: (() => void) | null = null;

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._rpcStatusUnsub?.();
    this._rpcStatusUnsub = null;
    if (this._reloadDebounce !== null) {
      clearTimeout(this._reloadDebounce);
      this._reloadDebounce = null;
    }
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("eventDispatcher") && this.eventDispatcher && !this._sse) {
      this._initSse();
    }
    if (changed.has("rpcClient") && this.rpcClient) {
      this._rpcStatusUnsub?.();
      this._rpcStatusUnsub = null;

      if (this.rpcClient.status === "connected") {
        this._loadData();
      } else {
        this._rpcStatusUnsub = this.rpcClient.onStatusChange((status) => {
          if (status === "connected") {
            this._rpcStatusUnsub?.();
            this._rpcStatusUnsub = null;
            this._loadData();
          }
        });
      }
    }
  }

  private _scheduleReload(delayMs = 300): void {
    if (this._reloadDebounce !== null) clearTimeout(this._reloadDebounce);
    this._reloadDebounce = setTimeout(() => {
      this._reloadDebounce = null;
      void this._loadData();
    }, delayMs);
  }

  private _initSse(): void {
    if (!this.eventDispatcher || this._sse) return;
    this._sse = new SseController(this, this.eventDispatcher, {
      "model:catalog_loaded": () => { this._scheduleReload(); },
    });
  }

  async _loadData(): Promise<void> {
    if (!this.rpcClient) return;

    this._loadState = "loading";
    this._error = "";

    try {
      // Load config first (required for provider/alias display)
      const configResult = await this.rpcClient.call<{
        config: {
          providers: { entries: Record<string, ProviderEntry> };
          models: {
            aliases: ModelAlias[];
            defaultProvider: string;
            defaultModel: string;
          };
        };
        sections: string[];
      }>("config.read");

      this._providers = configResult.config.providers?.entries ?? {};
      this._aliases = configResult.config.models?.aliases ?? [];
      this._defaultProvider = configResult.config.models?.defaultProvider ?? "";
      this._defaultModel = configResult.config.models?.defaultModel ?? "";
      this._loadState = "loaded";

      // Load model catalog in the background
      this.rpcClient.call<{
        providers?: Array<{ name: string; models?: Array<string | { modelId: string; contextWindow: number; maxTokens: number }>; modelCount?: number }>;
        models?: ModelInfo[];
        totalModels?: number;
      }>("models.list").then((modelsList) => {
        if (modelsList.models && modelsList.models.length > 0) {
          this._models = modelsList.models;
        } else if (modelsList.providers && modelsList.providers.length > 0) {
          this._models = modelsList.providers.flatMap((p) =>
            (p.models ?? []).map((m) => {
              const isObj = typeof m === "object" && m !== null;
              const modelId = isObj ? m.modelId : m;
              return {
                provider: p.name,
                modelId,
                displayName: modelId,
                contextWindow: isObj ? m.contextWindow : 0,
                maxTokens: isObj ? m.maxTokens : 0,
                input: true,
                reasoning: false,
                validated: false,
              };
            }),
          );
        }
        // eslint-disable-next-line no-restricted-syntax -- Fire-and-forget UI action
      }).catch(() => { /* model catalog is supplementary */ });

      // Load per-agent model overrides in the background (supplementary)
      (async () => {
        try {
          const agentsList = await this.rpcClient!.call<{
            agents?: string[];
          }>("agents.list");
          const agentIds = (agentsList.agents ?? []).slice(0, 20);
          const agentDetails = await Promise.allSettled(
            agentIds.map((id) =>
              this.rpcClient!.call<{
                agentId: string;
                config: { provider?: string; model?: string };
              }>("agents.get", { agentId: id }),
            ),
          );
          this._agents = agentDetails
            .filter((r): r is PromiseFulfilledResult<{ agentId: string; config: { provider?: string; model?: string } }> =>
              r.status === "fulfilled" && r.value.agentId != null,
            )
            .map((r) => ({
              id: r.value.agentId,
              provider: r.value.config.provider ?? "",
              model: r.value.config.model ?? "",
            }));
        } catch {
          this._agents = [];
        }
      })();
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to load model configuration";
      this._loadState = "error";
    }
  }

  private async _patchConfig(path: string, value: unknown): Promise<boolean> {
    if (!this.rpcClient) return false;

    try {
      // Backend expects { section, key?, value }. Split dot-notation path into section + key.
      const dotIdx = path.indexOf(".");
      const section = dotIdx > 0 ? path.slice(0, dotIdx) : path;
      const key = dotIdx > 0 ? path.slice(dotIdx + 1) : undefined;
      await this.rpcClient.call("config.patch", { section, key, value });
      IcToast.show("Configuration updated", "success");
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update configuration";
      IcToast.show(msg, "error");
      return false;
    }
  }

  // --- Providers tab ---

  private async _testProvider(name: string): Promise<void> {
    if (!this.rpcClient) return;

    const newTesting = new Set(this._testingProviders);
    newTesting.add(name);
    this._testingProviders = newTesting;

    try {
      const result = await this.rpcClient.call<TestResult>("models.test", { provider: name });
      const newResults = new Map(this._providerTestResults);
      newResults.set(name, result);
      this._providerTestResults = newResults;
      IcToast.show(`Provider "${name}" test: ${result.status}`, result.status === "ok" ? "success" : "warning");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Test failed";
      const newResults = new Map(this._providerTestResults);
      newResults.set(name, { status: "error" });
      this._providerTestResults = newResults;
      IcToast.show(`Provider "${name}" test failed: ${msg}`, "error");
    } finally {
      const newTesting = new Set(this._testingProviders);
      newTesting.delete(name);
      this._testingProviders = newTesting;
    }
  }

  private async _toggleProvider(name: string, enabled: boolean): Promise<void> {
    const ok = await this._patchConfig(`providers.entries.${name}.enabled`, enabled);
    if (ok) {
      this._providers = {
        ...this._providers,
        [name]: { ...this._providers[name], enabled },
      };
    }
  }

  private _startEditProvider(name: string): void {
    const entry = this._providers[name];
    this._editingProvider = name;
    this._editForm = {
      name,
      type: entry?.type ?? "",
      baseUrl: entry?.baseUrl ?? "",
      apiKeyName: entry?.apiKeyName ?? "",
    };
  }

  private _startAddProvider(): void {
    this._editingProvider = "";
    this._editForm = { name: "", type: "", baseUrl: "", apiKeyName: "" };
  }

  private _cancelEditProvider(): void {
    this._editingProvider = null;
  }

  private async _saveProvider(): Promise<void> {
    const { name, type, baseUrl, apiKeyName } = this._editForm;
    if (!name.trim() || !type.trim()) return;

    const entry: ProviderEntry = {
      type: type.trim(),
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      apiKeyName: apiKeyName.trim(),
      enabled: this._providers[name]?.enabled ?? true,
      timeoutMs: this._providers[name]?.timeoutMs ?? 120000,
      maxRetries: this._providers[name]?.maxRetries ?? 2,
    };

    const ok = await this._patchConfig(`providers.entries.${name.trim()}`, entry);
    if (ok) {
      this._providers = { ...this._providers, [name.trim()]: entry };
      this._editingProvider = null;
    }
  }

  private async _deleteProvider(): Promise<void> {
    if (!this._editingProvider) return;
    const name = this._editingProvider;

    // Remove by setting entire entries without this key
    const updated = { ...this._providers };
    delete updated[name];

    const ok = await this._patchConfig("providers.entries", updated);
    if (ok) {
      this._providers = updated;
      this._editingProvider = null;
    }
  }

  private _renderProviderEditor() {
    if (this._editingProvider === null) return nothing;
    const isNew = this._editingProvider === "";

    return html`
      <div class="editor-form">
        <div class="editor-title">${isNew ? "Add Provider" : `Edit: ${this._editingProvider}`}</div>
        <div class="form-field">
          <label class="form-label">Provider Name</label>
          <input
            class="form-input"
            type="text"
            .value=${this._editForm.name}
            ?disabled=${!isNew}
            @input=${(e: Event) => {
              this._editForm = { ...this._editForm, name: (e.target as HTMLInputElement).value };
            }}
            placeholder="e.g., anthropic"
          />
        </div>
        <div class="form-field">
          <label class="form-label">Type</label>
          <input
            class="form-input"
            type="text"
            .value=${this._editForm.type}
            @input=${(e: Event) => {
              this._editForm = { ...this._editForm, type: (e.target as HTMLInputElement).value };
            }}
            placeholder="anthropic, openai, ollama, etc."
          />
        </div>
        <div class="form-field">
          <label class="form-label">Base URL (optional)</label>
          <input
            class="form-input"
            type="text"
            .value=${this._editForm.baseUrl}
            @input=${(e: Event) => {
              this._editForm = { ...this._editForm, baseUrl: (e.target as HTMLInputElement).value };
            }}
            placeholder="Leave empty for default"
          />
        </div>
        <div class="form-field">
          <label class="form-label">API Key Name (SecretManager ref)</label>
          <input
            class="form-input"
            type="text"
            .value=${this._editForm.apiKeyName}
            @input=${(e: Event) => {
              this._editForm = { ...this._editForm, apiKeyName: (e.target as HTMLInputElement).value };
            }}
            placeholder="e.g., ANTHROPIC_API_KEY"
          />
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" @click=${() => this._saveProvider()}>Save</button>
          ${!isNew
            ? html`<button class="btn btn-danger" @click=${() => this._deleteProvider()}>Delete</button>`
            : nothing}
          <button class="btn btn-secondary" @click=${() => this._cancelEditProvider()}>Cancel</button>
        </div>
      </div>
    `;
  }

  private _renderProvidersTab() {
    const entries = Object.entries(this._providers);

    if (entries.length === 0 && this._editingProvider === null) {
      return html`
        <ic-empty-state
          icon="models"
          message="No providers configured"
          description="Add a provider to connect to LLM services."
        ></ic-empty-state>
        <button class="btn-add" @click=${() => this._startAddProvider()}>Add Provider</button>
      `;
    }

    return html`
      <div class="provider-grid">
        ${entries.map(
          ([name, entry]) => html`
            <ic-provider-card
              .name=${name}
              .type=${entry.type}
              .baseUrl=${entry.baseUrl}
              .enabled=${entry.enabled}
              .testResult=${this._providerTestResults.get(name) ?? null}
              .testing=${this._testingProviders.has(name)}
              @test-connection=${() => this._testProvider(name)}
              @edit-provider=${() => this._startEditProvider(name)}
              @toggle-provider=${(e: CustomEvent<boolean>) => this._toggleProvider(name, e.detail)}
            ></ic-provider-card>
          `,
        )}
      </div>
      ${this._renderProviderEditor()}
      ${this._editingProvider === null
        ? html`<button class="btn-add" @click=${() => this._startAddProvider()}>Add Provider</button>`
        : nothing}
    `;
  }

  // --- Available Models tab ---

  /** Renders provider filter <option> elements separately to avoid Lit+happy-dom duplicate attribute binding. */
  private _renderProviderFilterSelect() {
    const providerNames = this._getProviderNames();
    return html`
      <select
        class="filter-select"
        .value=${this._modelsProviderFilter}
        @change=${(e: Event) => {
          this._modelsProviderFilter = (e.target as HTMLSelectElement).value;
        }}
      >
        <option value="">All providers</option>
        ${providerNames.map(
          (p) => html`<option value=${p} ?selected=${p === this._modelsProviderFilter}>${p}</option>`,
        )}
      </select>
    `;
  }

  private _renderModelsTab() {
    if (this._models.length === 0) {
      return html`
        <ic-empty-state
          icon="models"
          message="No models discovered"
          description="Configure providers and run a scan to discover available models."
        ></ic-empty-state>
      `;
    }

    // Apply filters
    let filtered = [...this._models];
    if (this._modelsProviderFilter) {
      filtered = filtered.filter((m) => m.provider === this._modelsProviderFilter);
    }
    if (this._modelsSearchQuery) {
      const q = this._modelsSearchQuery.toLowerCase();
      filtered = filtered.filter(
        (m) =>
          m.modelId.toLowerCase().includes(q) ||
          m.displayName.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q),
      );
    }
    const sorted = filtered.sort((a, b) => {
      const pc = a.provider.localeCompare(b.provider);
      return pc !== 0 ? pc : a.modelId.localeCompare(b.modelId);
    });

    return html`
      <div class="filter-bar">
        <ic-search-input
          placeholder="Search models..."
          .value=${this._modelsSearchQuery}
          @search=${(e: CustomEvent<string>) => {
            this._modelsSearchQuery = e.detail;
          }}
        ></ic-search-input>
        ${this._renderProviderFilterSelect()}
        <span class="filter-count">${filtered.length} of ${this._models.length} models</span>
      </div>
      ${sorted.length === 0
        ? html`<ic-empty-state icon="models" message="No models match your filter" description="Try adjusting your search or provider filter."></ic-empty-state>`
        : html`
          <table class="models-table">
            <thead>
              <tr>
                <th>Model ID</th>
                <th>Provider</th>
                <th>Context Window</th>
                <th>Max Tokens</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${sorted.map(
                (m) => html`
                  <tr>
                    <td class="mono">${m.modelId}</td>
                    <td><ic-tag variant="info">${m.provider}</ic-tag></td>
                    <td>${m.contextWindow.toLocaleString()}</td>
                    <td>${m.maxTokens.toLocaleString()}</td>
                    <td>
                      ${m.validated
                        ? html`<ic-icon name="check" size="16px" class="validated-icon" label="Validated"></ic-icon>`
                        : nothing}
                    </td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        `}
    `;
  }

  // --- Aliases tab ---

  private _startEditAlias(index: number): void {
    const alias = this._aliases[index];
    this._editingAlias = index;
    this._aliasForm = {
      alias: alias.alias,
      provider: alias.provider,
      modelId: alias.modelId,
    };
  }

  private _startAddAlias(): void {
    this._editingAlias = -1;
    this._aliasForm = { alias: "", provider: "", modelId: "" };
  }

  private _cancelEditAlias(): void {
    this._editingAlias = null;
    this._aliasForm = { alias: "", provider: "", modelId: "" };
  }

  private async _saveAlias(): Promise<void> {
    const { alias, provider, modelId } = this._aliasForm;
    if (!alias.trim() || !provider.trim() || !modelId.trim()) return;

    const entry: ModelAlias = {
      alias: alias.trim(),
      provider: provider.trim(),
      modelId: modelId.trim(),
    };

    let updated: ModelAlias[];
    if (this._editingAlias === -1) {
      // Adding new
      updated = [...this._aliases, entry];
    } else if (this._editingAlias !== null) {
      // Editing existing
      updated = this._aliases.map((a, i) => (i === this._editingAlias ? entry : a));
    } else {
      return;
    }

    const ok = await this._patchConfig("models.aliases", updated);
    if (ok) {
      this._aliases = updated;
      this._editingAlias = null;
      this._aliasForm = { alias: "", provider: "", modelId: "" };
    }
  }

  private async _deleteAlias(index: number): Promise<void> {
    const updated = this._aliases.filter((_, i) => i !== index);
    const ok = await this._patchConfig("models.aliases", updated);
    if (ok) {
      this._aliases = updated;
      IcToast.show("Alias removed", "success");
    }
  }

  private _renderAliasForm() {
    if (this._editingAlias === null) return nothing;

    return html`
      <div class="alias-form">
        <div class="form-field">
          <label class="form-label">Alias</label>
          <input
            class="form-input"
            type="text"
            .value=${this._aliasForm.alias}
            @input=${(e: Event) => {
              this._aliasForm = { ...this._aliasForm, alias: (e.target as HTMLInputElement).value };
            }}
            placeholder="e.g., claude"
          />
        </div>
        <div class="form-field">
          <label class="form-label">Provider</label>
          <input
            class="form-input"
            type="text"
            .value=${this._aliasForm.provider}
            @input=${(e: Event) => {
              this._aliasForm = { ...this._aliasForm, provider: (e.target as HTMLInputElement).value };
            }}
            placeholder="e.g., anthropic"
          />
        </div>
        <div class="form-field">
          <label class="form-label">Model ID</label>
          <input
            class="form-input"
            type="text"
            .value=${this._aliasForm.modelId}
            @input=${(e: Event) => {
              this._aliasForm = { ...this._aliasForm, modelId: (e.target as HTMLInputElement).value };
            }}
            placeholder="e.g., claude-sonnet-4-5-20250929"
          />
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" @click=${() => this._saveAlias()}>
            ${this._editingAlias === -1 ? "Add Alias" : "Save"}
          </button>
          <button class="btn btn-secondary" @click=${() => this._cancelEditAlias()}>Cancel</button>
        </div>
      </div>
    `;
  }

  private _renderAliasesTab() {
    if (this._aliases.length === 0 && this._editingAlias === null) {
      return html`
        <ic-empty-state
          icon="models"
          message="No aliases configured"
          description="Create aliases to reference models by short names."
        ></ic-empty-state>
        <button class="btn-add" @click=${() => this._startAddAlias()}>Add Alias</button>
      `;
    }

    return html`
      ${this._aliases.length > 0
        ? html`
            <table class="alias-table">
              <thead>
                <tr>
                  <th>Alias</th>
                  <th>Provider</th>
                  <th>Model ID</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${this._aliases.map(
                  (a, i) => html`
                    <tr>
                      <td class="mono">${a.alias}</td>
                      <td><ic-tag variant="info">${a.provider}</ic-tag></td>
                      <td class="mono">${a.modelId}</td>
                      <td>
                        <div class="alias-actions">
                          <button
                            class="btn btn-secondary"
                            @click=${() => this._startEditAlias(i)}
                            aria-label="Edit alias ${a.alias}"
                          >Edit</button>
                          <button
                            class="btn btn-danger"
                            @click=${() => this._deleteAlias(i)}
                            aria-label="Delete alias ${a.alias}"
                          >Delete</button>
                        </div>
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `
        : nothing}
      ${this._renderAliasForm()}
      ${this._editingAlias === null
        ? html`<button class="btn-add" @click=${() => this._startAddAlias()}>Add Alias</button>`
        : nothing}
    `;
  }

  // --- Defaults tab ---

  /** Patches both defaultProvider and defaultModel atomically in a single config.patch call.
   * This avoids the race condition where the first patch triggers a daemon restart (SIGUSR1)
   * before the second correlated patch can complete. */
  private async _patchModelDefaults(provider: string, model: string): Promise<boolean> {
    const ok = await this._patchConfig("models", {
      defaultProvider: provider,
      defaultModel: model,
      aliases: this._aliases,
    });
    if (ok) {
      this._defaultProvider = provider;
      this._defaultModel = model;
    }
    return ok;
  }

  private async _updateDefaultProvider(provider: string): Promise<void> {
    // Always clear model when switching providers so the user picks from the new provider's list
    const model = provider !== this._defaultProvider ? "" : this._defaultModel;
    await this._patchModelDefaults(provider, model);
  }

  private async _updateDefaultModel(model: string): Promise<void> {
    let provider = this._defaultProvider;
    // Auto-update provider to match the selected model
    if (model) {
      const modelEntry = this._models.find((m) => m.modelId === model);
      if (modelEntry && modelEntry.provider !== provider) {
        provider = modelEntry.provider;
      }
    }
    await this._patchModelDefaults(provider, model);
  }

  private _getProviderNames(): string[] {
    const fromConfig = Object.keys(this._providers);
    const fromModels = [...new Set(this._models.map((m) => m.provider))];
    return [...new Set([...fromConfig, ...fromModels])].sort();
  }

  /** Renders provider <option> elements for defaults tab separately to avoid Lit+happy-dom duplicate attribute binding. */
  private _renderDefaultProviderOptions() {
    const providerNames = this._getProviderNames();
    return html`
      <option value="">-- Select provider --</option>
      ${providerNames.map(
        (p) => html`<option value=${p} ?selected=${p === this._defaultProvider}>${p}</option>`,
      )}
    `;
  }

  /** Renders model <option> elements for defaults tab separately to avoid Lit+happy-dom duplicate attribute binding. */
  private _renderDefaultModelOptions() {
    const filteredModels = this._defaultProvider
      ? this._models.filter((m) => m.provider === this._defaultProvider)
      : this._models;
    const sorted = [...filteredModels].sort((a, b) => a.modelId.localeCompare(b.modelId));

    if (this._defaultProvider) {
      // Provider selected: show just model ID since provider context is clear
      return html`
        <option value="">-- Select model --</option>
        ${sorted.map(
          (m) => html`<option value=${m.modelId} ?selected=${m.modelId === this._defaultModel}>${m.modelId}</option>`,
        )}
      `;
    }
    // No provider selected: show all models with provider prefix
    return html`
      <option value="">-- Select model --</option>
      ${sorted.map(
        (m) => html`<option value=${m.modelId} ?selected=${m.modelId === this._defaultModel}>${m.provider}/${m.modelId}</option>`,
      )}
    `;
  }

  private async _updateAgentOverride(agentId: string, provider: string, model: string): Promise<void> {
    if (!this.rpcClient) return;
    try {
      await this.rpcClient.call("agents.update", {
        agentId,
        config: { provider: provider || undefined, model: model || undefined },
      });
      this._agents = this._agents.map((a) =>
        a.id === agentId ? { ...a, provider, model } : a,
      );
      IcToast.show("Agent model override updated", "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update agent override";
      IcToast.show(msg, "error");
    }
  }

  private _renderAgentOverrideProviderOptions(agent: AgentOverride) {
    const providerNames = this._getProviderNames();
    return html`
      <option value="">-- Inherit default --</option>
      ${providerNames.map(
        (p) => html`<option value=${p} ?selected=${p === agent.provider}>${p}</option>`,
      )}
    `;
  }

  private _renderAgentOverrideModelOptions(agent: AgentOverride) {
    const filteredModels = agent.provider
      ? this._models.filter((m) => m.provider === agent.provider)
      : this._models;
    const sorted = [...filteredModels].sort((a, b) => a.modelId.localeCompare(b.modelId));
    const noModel = !agent.model;

    if (agent.provider) {
      return html`
        <option value="" ?selected=${noModel}>-- Select model --</option>
        ${sorted.map(
          (m) => html`<option value=${m.modelId} ?selected=${m.modelId === agent.model}>${m.modelId}</option>`,
        )}
      `;
    }
    return html`
      <option value="" ?selected=${noModel}>-- Inherit default --</option>
      ${sorted.map(
        (m) => html`<option value=${m.modelId} ?selected=${m.modelId === agent.model}>${m.provider}/${m.modelId}</option>`,
      )}
    `;
  }

  private _renderPerAgentOverrides() {
    if (this._agents.length === 0) {
      return html`
        <ic-empty-state
          icon="models"
          message="No agents configured"
          description="Configure agents to set per-agent model overrides."
        ></ic-empty-state>
      `;
    }

    return html`
      <table class="overrides-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Provider</th>
            <th>Model</th>
          </tr>
        </thead>
        <tbody>
          ${this._agents.map(
            (agent) => html`
              <tr>
                <td class="mono">${agent.id}</td>
                <td>
                  <select
                    class="override-select"
                    .value=${agent.provider}
                    @change=${(e: Event) => {
                      const provider = (e.target as HTMLSelectElement).value;
                      // Clear model when switching providers
                      this._updateAgentOverride(agent.id, provider, "");
                    }}
                  >
                    ${this._renderAgentOverrideProviderOptions(agent)}
                  </select>
                </td>
                <td>
                  <select
                    class="override-select"
                    .value=${agent.model}
                    @change=${(e: Event) => {
                      const model = (e.target as HTMLSelectElement).value;
                      this._updateAgentOverride(agent.id, agent.provider, model);
                    }}
                  >
                    ${this._renderAgentOverrideModelOptions(agent)}
                  </select>
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    `;
  }

  private _renderDefaultsTab() {
    return html`
      <div class="defaults-section">
        <div class="form-field">
          <label class="form-label">Default Provider</label>
          <select
            class="defaults-select"
            .value=${this._defaultProvider}
            @change=${(e: Event) => {
              this._updateDefaultProvider((e.target as HTMLSelectElement).value);
            }}
          >
            ${this._renderDefaultProviderOptions()}
          </select>
        </div>

        <div class="form-field">
          <label class="form-label">Default Model</label>
          <select
            class="defaults-select"
            .value=${this._defaultModel}
            @change=${(e: Event) => {
              this._updateDefaultModel((e.target as HTMLSelectElement).value);
            }}
          >
            ${this._renderDefaultModelOptions()}
          </select>
        </div>

        <div class="defaults-summary">
          Current default:
          <ic-tag variant="accent">${this._defaultProvider || "none"}</ic-tag>
          /
          <ic-tag variant="info">${this._defaultModel || "none"}</ic-tag>
        </div>

        <div class="defaults-resolved">
          ${this._defaultProvider && this._defaultModel
            ? html`<span>Resolved: <code class="mono">${this._defaultProvider}/${this._defaultModel}</code></span>`
            : html`<span style="color: var(--ic-warning)">Select both a provider and model to set defaults</span>`}
        </div>

        <hr class="overrides-divider" />
        <div class="overrides-heading">Per-Agent Overrides</div>
        ${this._renderPerAgentOverrides()}
      </div>
    `;
  }

  // --- Main render ---

  private _renderTabContent() {
    switch (this._activeTab) {
      case "providers":
        return this._renderProvidersTab();
      case "models":
        return this._renderModelsTab();
      case "aliases":
        return this._renderAliasesTab();
      case "defaults":
        return this._renderDefaultsTab();
      default:
        return nothing;
    }
  }

  override render() {
    if (this._loadState === "loading") {
      return html`<ic-skeleton-view variant="list"></ic-skeleton-view>`;
    }

    if (this._loadState === "error") {
      return html`
        <div class="error-container">
          <span class="error-message">${this._error}</span>
          <button class="retry-btn" @click=${() => this._loadData()}>Retry</button>
        </div>
      `;
    }

    return html`
      <div class="view-header">
        <div class="view-title">Models & Providers</div>
      </div>
      <ic-tabs
        .tabs=${TABS}
        .activeTab=${this._activeTab}
        @tab-change=${(e: CustomEvent<string>) => { this._activeTab = e.detail; }}
      ></ic-tabs>
      <div style="margin-top: var(--ic-space-md);">
        ${this._renderTabContent()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-models-view": IcModelsView;
  }
}
