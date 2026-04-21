// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { AgentInfo, EnrichedAgentInfo, AgentBilling, DataTableColumn } from "../../api/types/index.js";
import type { RpcClient } from "../../api/rpc-client.js";
import type { ApiClient } from "../../api/api-client.js";
import type { EventDispatcher } from "../../state/event-dispatcher.js";
import { SseController } from "../../state/sse-controller.js";
import { IcToast } from "../../components/feedback/ic-toast.js";

// Side-effect imports to register custom elements used in template
import "../../components/data/ic-data-table.js";
import "../../components/data/ic-tag.js";
import "../../components/form/ic-search-input.js";
import "../../components/form/ic-filter-chips.js";
import "../../components/feedback/ic-confirm-dialog.js";
import "../../components/feedback/ic-toast.js";
import "../../components/feedback/ic-loading.js";
import "../../components/feedback/ic-empty-state.js";
import "../../components/display/ic-icon.js";
import "../../components/shell/ic-skeleton-view.js";

/** Maps agent status strings to ic-tag variant names. */
const STATUS_VARIANT: Record<string, string> = {
  active: "success",
  idle: "info",
  suspended: "warning",
  error: "error",
};

/** Maps agent status strings to display labels. */
const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  idle: "Idle",
  suspended: "Suspended",
  error: "Error",
};

/** Filter chip options for agent status. */
const STATUS_FILTER_OPTIONS = [
  { value: "active", label: "Active", color: "var(--ic-success)" },
  { value: "idle", label: "Idle", color: "var(--ic-info)" },
  { value: "suspended", label: "Suspended", color: "var(--ic-warning)" },
  { value: "error", label: "Error", color: "var(--ic-error)" },
];

/** Currency formatter for USD display */
const currencyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** Shape returned by models.list RPC (unfiltered). */
interface CatalogProvider {
  name: string;
  modelCount: number;
  models: Array<{ modelId: string; displayName: string }>;
}

/** Tool policy profile descriptions for the wizard. */
const TOOL_PROFILES: Record<string, string> = {
  minimal: "Read and write only. Safest option for restricted environments.",
  coding: "Common tools including web, memory, and file operations.",
  messaging: "Optimized for chat and messaging workflows.",
  supervisor: "Extended tools for agent orchestration and oversight.",
  full: "All available tools. Best for autonomous agents with broad capabilities.",
};

/**
 * Agent list view with search, filtering, enriched data grid, CRUD actions,
 * and a 3-step Create Agent wizard modal.
 *
 * Displays all configured agents in a sortable data table with columns for
 * Status, Name, Model, Messages, Cost, Budget, and Actions. Supports text
 * search, status filter chips, and full CRUD operations.
 *
 * @fires navigate - Dispatched when user clicks a row or action button, with route path as detail
 */
@customElement("ic-agent-list")
export class IcAgentList extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .page-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--ic-space-lg, 1.5rem);
      }

      .page-title {
        font-size: var(--ic-text-2xl, 1.5rem);
        font-weight: 700;
        margin: 0;
      }

      .create-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs, 0.25rem);
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        background: var(--ic-accent, #3b82f6);
        color: #fff;
        border: none;
        border-radius: var(--ic-radius-md, 0.5rem);
        font-size: var(--ic-text-sm, 0.875rem);
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        transition: background var(--ic-transition, 150ms ease);
      }

      .create-btn:hover {
        background: var(--ic-accent-hover, #2563eb);
      }

      .toolbar {
        display: flex;
        align-items: center;
        gap: var(--ic-space-md, 0.75rem);
        margin-bottom: var(--ic-space-md, 0.75rem);
        flex-wrap: wrap;
      }

      .toolbar ic-search-input {
        flex: 1;
        min-width: 200px;
        max-width: 320px;
      }

      .toolbar ic-filter-chips {
        flex-shrink: 0;
      }

      /* Action buttons inside data table cells */
      .row-actions {
        display: flex;
        gap: 4px;
        justify-content: flex-end;
      }

      .action-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        background: transparent;
        border: 1px solid transparent;
        border-radius: var(--ic-radius-sm, 0.25rem);
        color: var(--ic-text-dim, #6b7280);
        cursor: pointer;
        transition: background var(--ic-transition, 150ms ease),
          color var(--ic-transition, 150ms ease),
          border-color var(--ic-transition, 150ms ease);
      }

      .action-btn:hover {
        background: var(--ic-surface-2, #1f2937);
        color: var(--ic-text, #f3f4f6);
        border-color: var(--ic-border, #374151);
      }

      .action-btn--danger:hover {
        color: var(--ic-error, #f87171);
        border-color: var(--ic-error, #f87171);
      }

      .budget-inline {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
      }

      .budget-track {
        flex: 1;
        height: 4px;
        background: var(--ic-surface-2, #1f2937);
        border-radius: 2px;
        overflow: hidden;
      }

      .budget-fill {
        height: 100%;
        border-radius: 2px;
      }

      .budget-pct {
        font-size: 0.75rem;
        font-family: ui-monospace, monospace;
        color: var(--ic-text-muted);
        min-width: 2.5rem;
        text-align: right;
      }

      .cost-cell {
        font-family: ui-monospace, monospace;
        text-align: right;
        width: 100%;
        display: block;
      }

      .numeric-cell {
        font-family: ui-monospace, monospace;
        text-align: right;
        width: 100%;
        display: block;
      }

      .model-cell {
        font-family: ui-monospace, monospace;
        font-size: 0.8125rem;
      }

      /* Error state */
      .error-container {
        text-align: center;
        padding: var(--ic-space-2xl, 3rem);
        color: var(--ic-text-muted, #9ca3af);
      }

      .error-message {
        margin-bottom: var(--ic-space-md, 0.75rem);
        color: var(--ic-error, #f87171);
      }

      .retry-btn {
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        background: transparent;
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        color: var(--ic-text, #f3f4f6);
        font-size: var(--ic-text-sm, 0.875rem);
        font-family: inherit;
        cursor: pointer;
      }

      .retry-btn:hover {
        border-color: var(--ic-accent, #3b82f6);
        color: var(--ic-accent, #3b82f6);
      }

      /* ---- Wizard Modal ---- */
      .wizard-dialog {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg, 0.75rem);
        max-width: 32rem;
        width: calc(100% - 2rem);
        padding: 0;
        color: var(--ic-text);
        box-shadow: var(--ic-shadow-lg);
      }

      .wizard-dialog::backdrop {
        background: rgba(0, 0, 0, 0.6);
      }

      .wizard-content {
        padding: var(--ic-space-lg, 1.5rem);
      }

      .wizard-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--ic-space-lg, 1.5rem);
      }

      .wizard-title {
        font-size: var(--ic-text-lg, 1.125rem);
        font-weight: 600;
        margin: 0;
      }

      .wizard-close {
        background: none;
        border: none;
        color: var(--ic-text-dim);
        cursor: pointer;
        font-size: 1.25rem;
        padding: 4px;
        line-height: 1;
      }

      .wizard-close:hover {
        color: var(--ic-text);
      }

      .wizard-steps {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        margin-bottom: var(--ic-space-lg, 1.5rem);
      }

      .step-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--ic-border);
        transition: background 0.15s;
      }

      .step-dot--active {
        background: var(--ic-accent);
      }

      .step-dot--done {
        background: var(--ic-success);
      }

      .step-label {
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-dim);
      }

      .wizard-field {
        margin-bottom: var(--ic-space-md, 0.75rem);
      }

      .wizard-field label {
        display: block;
        font-size: var(--ic-text-sm, 0.875rem);
        font-weight: 500;
        color: var(--ic-text-muted);
        margin-bottom: 0.375rem;
      }

      .wizard-field input,
      .wizard-field select {
        width: 100%;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md, 0.5rem);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm, 0.875rem);
        padding: var(--ic-space-sm, 0.5rem);
      }

      .wizard-field input:focus,
      .wizard-field select:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .wizard-field .hint {
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-dim);
        margin-top: 0.25rem;
      }

      .wizard-field .profile-desc {
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-dim);
        margin-top: 0.375rem;
        padding: 0.5rem;
        background: var(--ic-bg);
        border-radius: var(--ic-radius-sm, 0.25rem);
      }

      .wizard-error {
        font-size: var(--ic-text-sm, 0.875rem);
        color: var(--ic-error);
        margin-bottom: var(--ic-space-md, 0.75rem);
      }

      .wizard-footer {
        display: flex;
        justify-content: flex-end;
        gap: var(--ic-space-sm, 0.5rem);
        padding-top: var(--ic-space-md, 0.75rem);
        border-top: 1px solid var(--ic-border);
      }

      .wizard-btn {
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        border-radius: var(--ic-radius-md, 0.5rem);
        font-size: var(--ic-text-sm, 0.875rem);
        font-family: inherit;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }

      .wizard-btn--secondary {
        background: transparent;
        border: 1px solid var(--ic-border);
        color: var(--ic-text-muted);
      }

      .wizard-btn--secondary:hover {
        border-color: var(--ic-text-dim);
        color: var(--ic-text);
      }

      .wizard-btn--primary {
        background: var(--ic-accent);
        border: 1px solid var(--ic-accent);
        color: #fff;
      }

      .wizard-btn--primary:hover {
        background: var(--ic-accent-hover);
      }

      .wizard-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ];

  /** API client for data fetching. */
  @property({ attribute: false }) apiClient: ApiClient | null = null;

  /** RPC client for actions (suspend, resume, delete, create, billing). */
  @property({ attribute: false }) rpcClient: RpcClient | null = null;

  /** Event dispatcher for SSE subscriptions (injected from app.ts). */
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  private _sse: SseController | null = null;
  private _reloadDebounce: ReturnType<typeof setTimeout> | null = null;

  @state() private _agents: EnrichedAgentInfo[] = [];
  @state() private _loadState: "loading" | "loaded" | "error" = "loading";
  @state() private _error = "";
  @state() private _deleteTarget: EnrichedAgentInfo | null = null;
  @state() private _actionPending = "";

  // Toolbar state
  @state() private _searchQuery = "";
  @state() private _statusFilters: Set<string> = new Set();

  // Wizard state
  @state() private _wizardOpen = false;
  @state() private _wizardStep: 1 | 2 | 3 = 1;
  @state() private _wizardError = "";
  @state() private _wizardCreating = false;
  @state() private _wizardAgentId = "";
  @state() private _wizardAgentName = "";
  @state() private _wizardProvider = "anthropic";
  @state() private _wizardModel = "";
  @state() private _wizardToolProfile = "full";
  @state() private _catalogProviders: CatalogProvider[] = [];

  override connectedCallback(): void {
    super.connectedCallback();
    // Note: _loadAgents() is NOT called here -- apiClient is typically
    // null at this point. The updated() callback handles loading once
    // the client property is set.
    this._initSse();
    if (this.rpcClient) this._loadModelCatalog();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("apiClient") && this.apiClient) {
      this._loadAgents();
    }
    if (changed.has("rpcClient") && this.rpcClient && this._catalogProviders.length === 0) {
      this._loadModelCatalog();
    }
    if (changed.has("eventDispatcher") && this.eventDispatcher && !this._sse) {
      this._initSse();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._reloadDebounce !== null) {
      clearTimeout(this._reloadDebounce);
      this._reloadDebounce = null;
    }
  }

  private _initSse(): void {
    if (!this.eventDispatcher || this._sse) return;
    this._sse = new SseController(this, this.eventDispatcher, {
      "observability:token_usage": () => { this._scheduleReload(); },
      "agent:hot_added": () => { this._scheduleReload(); },
      "agent:hot_removed": () => { this._scheduleReload(); },
    });
  }

  private _scheduleReload(delayMs = 300): void {
    if (this._reloadDebounce !== null) clearTimeout(this._reloadDebounce);
    this._reloadDebounce = setTimeout(() => {
      this._reloadDebounce = null;
      void this._loadAgents();
    }, delayMs);
  }

  /** Fetch the model catalog from the backend. */
  private async _loadModelCatalog(): Promise<void> {
    if (!this.rpcClient) return;
    try {
      const result = await this.rpcClient.call<{
        providers?: CatalogProvider[];
        totalModels?: number;
      }>("models.list");
      if (result.providers) {
        this._catalogProviders = result.providers;
      }
    } catch {
      // Non-fatal - wizard will show empty lists until catalog loads
    }
  }

  /** Get budget bar color based on utilization percentage. */
  private _budgetColor(pct: number): string {
    if (pct >= 90) return "var(--ic-error)";
    if (pct >= 70) return "var(--ic-warning)";
    return "var(--ic-success)";
  }

  /** Build column definitions for the data table. */
  private _getColumns(): DataTableColumn<EnrichedAgentInfo>[] {
    return [
      {
        key: "status",
        label: "Status",
        sortable: true,
        width: "100px",
        render: (_value: unknown, row: EnrichedAgentInfo) => {
          const variant = STATUS_VARIANT[row.status] ?? "default";
          const label = STATUS_LABEL[row.status] ?? row.status;
          return html`<ic-tag variant=${variant}>${label}</ic-tag>`;
        },
      },
      {
        key: "name",
        label: "Name",
        sortable: true,
        render: (_value: unknown, row: EnrichedAgentInfo) =>
          html`<span>${row.name ?? row.id}</span>`,
      },
      {
        key: "model",
        label: "Model",
        sortable: true,
        render: (_value: unknown, row: EnrichedAgentInfo) =>
          html`<span style="font-family: ui-monospace, monospace; font-size: 0.8125rem; white-space: nowrap;">${row.model}</span>`,
      },
      {
        key: "messagesToday",
        label: "Messages",
        sortable: true,
        render: (value: unknown) =>
          html`<span style="font-family: ui-monospace, monospace; text-align: right; width: 100%; display: block;">${new Intl.NumberFormat("en-US").format(value as number)}</span>`,
      },
      {
        key: "costToday",
        label: "Cost",
        sortable: true,
        render: (value: unknown) => {
          const cost = value as number;
          return html`<span style="font-family: ui-monospace, monospace; text-align: right; width: 100%; display: block;">${cost > 0 ? currencyFmt.format(cost) : "--"}</span>`;
        },
      },
      {
        key: "budgetUtilization",
        label: "Budget",
        sortable: true,
        render: (value: unknown) => {
          const pct = Math.min(100, Math.max(0, value as number));
          if (pct === 0) return html`<span style="font-family: ui-monospace, monospace; text-align: right; width: 100%; display: block;">--</span>`;
          return html`
            <div style="display: flex; align-items: center; gap: 6px; width: 100%;">
              <div style="flex: 1; height: 4px; background: var(--ic-surface-2, #1f2937); border-radius: 2px; overflow: hidden;">
                <div style="height: 100%; border-radius: 2px; width: ${pct}%; background: ${this._budgetColor(pct)};"></div>
              </div>
              <span style="font-size: 0.75rem; font-family: ui-monospace, monospace; color: var(--ic-text-muted); min-width: 2.5rem; text-align: right;">${pct}%</span>
            </div>
          `;
        },
      },
      {
        key: "_actions",
        label: "Actions",
        sortable: false,
        render: (_value: unknown, row: EnrichedAgentInfo) => {
          const isSuspended = row.suspended || row.status === "suspended";
          const toggleIcon = isSuspended ? "play" : "pause";
          const toggleLabel = isSuspended ? "Resume agent" : "Suspend agent";
          const btnBase = "display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; background: transparent; border: 1px solid transparent; border-radius: 0.25rem; color: #9ca3af; cursor: pointer;";
          return html`
            <div style="display: flex; gap: 4px; justify-content: flex-end;">
              <button style=${btnBase} aria-label="Configure ${row.id}" @click=${(e: Event) => { e.stopPropagation(); this._navigate(`agents/${row.id}/edit`); }}>
                <ic-icon name="settings" size="16px" color="#9ca3af"></ic-icon>
              </button>
              <button style=${btnBase} aria-label=${toggleLabel} @click=${(e: Event) => { e.stopPropagation(); this._handleSuspendResume(row, e); }}>
                <ic-icon name=${toggleIcon} size="16px" color="#9ca3af"></ic-icon>
              </button>
              <button style=${btnBase} aria-label="Delete ${row.id}" @click=${(e: Event) => { e.stopPropagation(); this._handleDeleteClick(row, e); }}>
                <ic-icon name="trash" size="16px" color="#f87171"></ic-icon>
              </button>
            </div>
          `;
        },
      },
    ];
  }

  async _loadAgents(): Promise<void> {
    if (!this.apiClient) return;

    this._loadState = "loading";
    this._error = "";

    try {
      const rawAgents = await this.apiClient.getAgents();
      // Show agents immediately with placeholder billing data
      this._agents = rawAgents.map((a) => ({
        ...a,
        costToday: 0,
        budgetUtilization: 0,
        suspended: a.status === "suspended",
        messagesToday: a.messagesToday ?? 0,
      }));
      this._loadState = "loaded";

      // Enrich with billing data in the background (non-blocking)
      this._enrichAgents(rawAgents).then((enriched) => {
        this._agents = enriched;
        // eslint-disable-next-line no-restricted-syntax -- Fire-and-forget UI action
      }).catch(() => { /* billing enrichment is optional */ });
    } catch (e) {
      this._error = e instanceof Error ? e.message : "Failed to load agents";
      this._loadState = "error";
    }
  }

  /** Enrich agents with billing data via RPC. */
  private async _enrichAgents(agents: AgentInfo[]): Promise<EnrichedAgentInfo[]> {
    if (!this.rpcClient || agents.length === 0) {
      return agents.map((a) => ({
        ...a,
        costToday: 0,
        budgetUtilization: 0,
        suspended: a.status === "suspended",
        messagesToday: a.messagesToday ?? 0,
      }));
    }

    // Cap at 50 agents for billing calls
    const billingAgents = agents.slice(0, 50);
    const billingResults = await Promise.allSettled(
      billingAgents.map((a) =>
        this.rpcClient!.call<AgentBilling>("obs.billing.byAgent", { agentId: a.id }),
      ),
    );

    const billingMap = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < billingAgents.length; i++) {
      const result = billingResults[i];
      if (result.status === "fulfilled" && result.value) {
        billingMap.set(billingAgents[i].id, result.value as unknown as Record<string, unknown>);
      }
    }

    return agents.map((agent) => {
      const billing = billingMap.get(agent.id);
      let budgetUtil = 0;
      const budgetUsed = billing?.budgetUsed as { perDay?: { used: number; limit?: number } } | undefined;
      if (budgetUsed?.perDay?.used !== undefined && budgetUsed.perDay.limit) {
        budgetUtil = Math.round((budgetUsed.perDay.used / budgetUsed.perDay.limit) * 100);
      }
      // RPC returns totalCost/totalTokens; map to costToday for display
      const cost = Number(billing?.costToday ?? billing?.totalCost ?? 0);
      const messages = Number(billing?.messagesToday ?? agent.messagesToday ?? 0);
      return {
        ...agent,
        costToday: cost,
        budgetUtilization: budgetUtil,
        suspended: agent.status === "suspended",
        messagesToday: messages,
      };
    });
  }

  /** Get filtered agents based on search query and status filters. */
  private _getFilteredAgents(): EnrichedAgentInfo[] {
    let filtered = this._agents;

    // Apply search filter (case-insensitive substring on id and name)
    if (this._searchQuery) {
      const q = this._searchQuery.toLowerCase();
      filtered = filtered.filter(
        (a) =>
          a.id.toLowerCase().includes(q) ||
          (a.name ?? "").toLowerCase().includes(q),
      );
    }

    // Apply status filter chips
    if (this._statusFilters.size > 0) {
      filtered = filtered.filter((a) => this._statusFilters.has(a.status));
    }

    return filtered;
  }

  private _navigate(path: string): void {
    this.dispatchEvent(
      new CustomEvent("navigate", { detail: path, bubbles: true, composed: true }),
    );
  }

  private _handleSearch(e: CustomEvent<string>): void {
    this._searchQuery = e.detail;
  }

  private _handleFilterChange(e: CustomEvent<{ selected: Set<string> }>): void {
    this._statusFilters = e.detail.selected;
  }

  private async _handleSuspendResume(agent: EnrichedAgentInfo, e: Event): Promise<void> {
    e.stopPropagation();
    if (!this.rpcClient || this._actionPending) return;

    this._actionPending = agent.id;
    const isSuspended = agent.suspended || agent.status === "suspended";
    const method = isSuspended ? "agents.resume" : "agents.suspend";
    const label = isSuspended ? "resumed" : "suspended";

    try {
      await this.rpcClient.call(method, { agentId: agent.id });
      IcToast.show(`Agent ${agent.id} ${label}`, "success");
      await this._loadAgents();
    } catch (err) {
      IcToast.show(
        `Failed to ${isSuspended ? "resume" : "suspend"} agent: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    } finally {
      this._actionPending = "";
    }
  }

  private _handleDeleteClick(agent: EnrichedAgentInfo, e: Event): void {
    e.stopPropagation();
    this._deleteTarget = agent;
  }

  private async _confirmDelete(): Promise<void> {
    if (!this.rpcClient || !this._deleteTarget) return;

    const id = this._deleteTarget.id;
    this._deleteTarget = null;

    try {
      await this.rpcClient.call("agents.delete", { agentId: id });
      IcToast.show(`Agent ${id} deleted`, "success");
      await this._loadAgents();
    } catch (err) {
      IcToast.show(
        `Failed to delete agent: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    }
  }

  private _cancelDelete(): void {
    this._deleteTarget = null;
  }

  // ---- Wizard methods ----

  private _openWizard(): void {
    this._wizardOpen = true;
    this._wizardStep = 1;
    this._wizardError = "";
    this._wizardCreating = false;
    this._wizardAgentId = "";
    this._wizardAgentName = "";
    this._wizardProvider = "anthropic";
    this._wizardModel = "";
    this._wizardToolProfile = "full";

    // Ensure model catalog is loaded (retries if initial fetch failed)
    if (this._catalogProviders.length === 0) {
      this._loadModelCatalog();
    }

    this.updateComplete.then(() => {
      const dialog = this.shadowRoot?.querySelector<HTMLDialogElement>(".wizard-dialog");
      dialog?.showModal();
    });
  }

  private _closeWizard(): void {
    const dialog = this.shadowRoot?.querySelector<HTMLDialogElement>(".wizard-dialog");
    dialog?.close();
    this._wizardOpen = false;
  }

  private _wizardNext(): void {
    if (this._wizardStep === 1) {
      // Validate agent ID
      if (!this._wizardAgentId.match(/^[a-zA-Z0-9-]{3,50}$/)) {
        this._wizardError = "Agent ID must be 3-50 characters (letters, numbers, hyphens).";
        return;
      }
      this._wizardError = "";
      this._wizardStep = 2;
    } else if (this._wizardStep === 2) {
      if (!this._wizardModel.trim()) {
        this._wizardError = "Please select a model.";
        return;
      }
      this._wizardError = "";
      this._wizardStep = 3;
    }
  }

  private _wizardBack(): void {
    this._wizardError = "";
    if (this._wizardStep === 2) this._wizardStep = 1;
    else if (this._wizardStep === 3) this._wizardStep = 2;
  }

  private async _wizardCreate(): Promise<void> {
    if (!this.rpcClient || this._wizardCreating) return;

    this._wizardCreating = true;
    this._wizardError = "";

    try {
      await this.rpcClient.call("agents.create", {
        agentId: this._wizardAgentId,
        config: {
          name: this._wizardAgentName || undefined,
          provider: this._wizardProvider,
          model: this._wizardModel,
          skills: {
            toolPolicy: { profile: this._wizardToolProfile },
          },
        },
      });
      IcToast.show(`Agent ${this._wizardAgentId} created`, "success");
      this._closeWizard();
      this._navigate(`agents/${this._wizardAgentId}/edit`);
      await this._loadAgents();
    } catch (err) {
      this._wizardError = err instanceof Error ? err.message : "Failed to create agent";
    } finally {
      this._wizardCreating = false;
    }
  }

  override render() {
    return html`
      <div class="page-header" role="region" aria-label="Agents">
        <h1 class="page-title">Agents</h1>
        <button class="create-btn" @click=${this._openWizard}>
          <ic-icon name="plus" size="16px"></ic-icon>
          Create Agent
        </button>
      </div>
      ${this._renderContent()}
      ${this._deleteTarget
        ? html`
            <ic-confirm-dialog
              open
              variant="danger"
              title="Delete Agent"
              message=${`Are you sure you want to delete agent ${this._deleteTarget.id}? This cannot be undone.`}
              confirmLabel="Delete"
              @confirm=${this._confirmDelete}
              @cancel=${this._cancelDelete}
            ></ic-confirm-dialog>
          `
        : nothing}
      ${this._wizardOpen ? this._renderWizard() : nothing}
    `;
  }

  private _renderContent() {
    switch (this._loadState) {
      case "loading":
        return html`<ic-skeleton-view variant="list"></ic-skeleton-view>`;
      case "error":
        return html`
          <div class="error-container">
            <div class="error-message">${this._error}</div>
            <button class="retry-btn" @click=${() => this._loadAgents()}>Retry</button>
          </div>
        `;
      case "loaded":
        return this._agents.length === 0
          ? html`
              <ic-empty-state
                icon="users"
                message="No agents configured"
                description="Create your first agent to start processing messages."
              >
                <button class="create-btn" @click=${this._openWizard}>
                  <ic-icon name="plus" size="16px"></ic-icon>
                  Create Agent
                </button>
              </ic-empty-state>
            `
          : this._renderTable();
    }
  }

  private _renderTable() {
    const filteredAgents = this._getFilteredAgents();
    const columns = this._getColumns();

    return html`
      <div class="toolbar">
        <ic-search-input
          placeholder="Search agents..."
          @search=${this._handleSearch}
        ></ic-search-input>
        <ic-filter-chips
          .options=${STATUS_FILTER_OPTIONS}
          .selected=${this._statusFilters}
          @filter-change=${this._handleFilterChange}
        ></ic-filter-chips>
      </div>
      <ic-data-table
        .columns=${columns}
        .rows=${filteredAgents}
        emptyMessage="No agents match your filters"
        @row-click=${(e: CustomEvent<EnrichedAgentInfo>) => {
          this._navigate(`agents/${e.detail.id}`);
        }}
      ></ic-data-table>
    `;
  }

  private _renderWizard() {
    return html`
      <dialog class="wizard-dialog" @close=${this._closeWizard}>
        <div class="wizard-content">
          <div class="wizard-header">
            <h2 class="wizard-title">Create Agent</h2>
            <button class="wizard-close" @click=${this._closeWizard}>\u2715</button>
          </div>

          <div class="wizard-steps">
            ${[1, 2, 3].map(
              (step) => html`
                <span
                  class="step-dot ${step === this._wizardStep ? "step-dot--active" : ""} ${step < this._wizardStep ? "step-dot--done" : ""}"
                ></span>
              `,
            )}
            <span class="step-label">Step ${this._wizardStep} of 3</span>
          </div>

          ${this._wizardError
            ? html`<div class="wizard-error">${this._wizardError}</div>`
            : nothing}

          ${this._renderWizardStep()}

          <div class="wizard-footer">
            ${this._wizardStep > 1
              ? html`<button class="wizard-btn wizard-btn--secondary" @click=${this._wizardBack}>Back</button>`
              : html`<button class="wizard-btn wizard-btn--secondary" @click=${this._closeWizard}>Cancel</button>`}
            ${this._wizardStep < 3
              ? html`<button class="wizard-btn wizard-btn--primary" @click=${this._wizardNext}>Next</button>`
              : html`<button
                  class="wizard-btn wizard-btn--primary"
                  ?disabled=${this._wizardCreating}
                  @click=${this._wizardCreate}
                >${this._wizardCreating ? "Creating..." : "Create Agent"}</button>`}
          </div>
        </div>
      </dialog>
    `;
  }

  private _renderWizardStep() {
    switch (this._wizardStep) {
      case 1:
        return html`
          <div class="wizard-field">
            <label for="wizard-id">Agent ID</label>
            <input
              id="wizard-id"
              type="text"
              .value=${this._wizardAgentId}
              @input=${(e: InputEvent) => { this._wizardAgentId = (e.target as HTMLInputElement).value; }}
              placeholder="my-agent"
              required
            />
            <div class="hint">3-50 characters. Letters, numbers, and hyphens only.</div>
          </div>
          <div class="wizard-field">
            <label for="wizard-name">Display Name</label>
            <input
              id="wizard-name"
              type="text"
              .value=${this._wizardAgentName}
              @input=${(e: InputEvent) => { this._wizardAgentName = (e.target as HTMLInputElement).value; }}
              placeholder="My Agent (optional)"
            />
          </div>
        `;
      case 2: {
        const providers = this._catalogProviders.length > 0
          ? this._catalogProviders.map((p) => ({
              value: p.name,
              label: p.name.charAt(0).toUpperCase() + p.name.slice(1),
            }))
          : [{ value: "anthropic", label: "Anthropic" }];
        const catalogEntry = this._catalogProviders.find((p) => p.name === this._wizardProvider);
        const models = (catalogEntry?.models ?? []).map((m) => ({
          id: m.modelId,
          label: m.displayName || m.modelId,
        }));
        return html`
          <div class="wizard-field">
            <label for="wizard-provider">Provider</label>
            <select
              id="wizard-provider"
              .value=${this._wizardProvider}
              @change=${(e: Event) => {
                this._wizardProvider = (e.target as HTMLSelectElement).value;
                this._wizardModel = "";
              }}
            >
              ${providers.map((p) => html`<option value=${p.value} ?selected=${p.value === this._wizardProvider}>${p.label}</option>`)}
            </select>
          </div>
          <div class="wizard-field">
            <label for="wizard-model">Model</label>
            <select
              id="wizard-model"
              .value=${this._wizardModel}
              @change=${(e: Event) => { this._wizardModel = (e.target as HTMLSelectElement).value; }}
              required
            >
              <option value="" disabled ?selected=${!this._wizardModel}>Select a model...</option>
              ${models.map((m) => html`<option value=${m.id} ?selected=${this._wizardModel === m.id}>${m.label}</option>`)}
            </select>
            <div class="hint">Model to use for this agent.</div>
          </div>
        `;
      }
      case 3:
        return html`
          <div class="wizard-field">
            <label for="wizard-tools">Tool Policy Profile</label>
            <select
              id="wizard-tools"
              .value=${this._wizardToolProfile}
              @change=${(e: Event) => { this._wizardToolProfile = (e.target as HTMLSelectElement).value; }}
            >
              <option value="minimal">Minimal</option>
              <option value="coding">Coding</option>
              <option value="messaging">Messaging</option>
              <option value="supervisor">Supervisor</option>
              <option value="full">Full</option>
            </select>
            <div class="profile-desc">${TOOL_PROFILES[this._wizardToolProfile] ?? ""}</div>
          </div>
        `;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-agent-list": IcAgentList;
  }
}
