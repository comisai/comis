// SPDX-License-Identifier: Apache-2.0
/**
 * Node editor panel for the graph builder.
 *
 * 320px right-side panel that opens when a node is selected. Provides
 * editing for all node fields: task, agent assignment, dependencies,
 * constraints, model override, and action buttons.
 *
 * Covers task, agent assignment, dependencies, constraints, model override, and actions.
 *
 * Events dispatched (all CustomEvent, bubbles: true, composed: true):
 * - node-update:    { nodeId: string, partial: Partial<PipelineNode> }
 * - edge-add:       { source: string, target: string }
 * - edge-remove:    { source: string, target: string }
 * - node-duplicate: { nodeId: string }
 * - node-delete:    { nodeId: string }
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { PipelineNode, PipelineEdge, NodeTypeId } from "../../api/types/index.js";
import type { RpcClient } from "../../api/rpc-client.js";
import { wouldCreateCycle } from "../../utils/cycle-detection.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface AgentEntry {
  readonly id: string;
  readonly model: string;
  readonly provider: string;
  readonly suspended: boolean;
}

interface ModelEntry {
  readonly provider: string;
  readonly modelId: string;
}

const NODE_TYPE_METADATA: Record<string, { label: string; description: string }> = {
  agent:           { label: "Agent",         description: "Run a single sub-agent with explicit driver config" },
  debate:          { label: "Debate",        description: "Multi-round adversarial debate between agents" },
  vote:            { label: "Vote",          description: "Parallel independent voting by multiple agents" },
  refine:          { label: "Refine",        description: "Sequential refinement chain through reviewers" },
  collaborate:     { label: "Collaborate",   description: "Sequential multi-perspective collaboration" },
  "approval-gate": { label: "Approval Gate", description: "Human approval checkpoint with timeout" },
  "map-reduce":    { label: "Map-Reduce",    description: "Parallel map tasks then single reduce" },
};

function getDefaultTypeConfig(typeId: string): Record<string, unknown> {
  switch (typeId) {
    case "agent":         return { agent: "", model: "", max_steps: 10 };
    case "debate":        return { agents: [], rounds: 2, synthesizer: "" };
    case "vote":          return { voters: [], prompt_suffix: "", verdict_format: "", min_voters: 0 };
    case "refine":        return { reviewers: [] };
    case "collaborate":   return { agents: [], rounds: 1 };
    case "approval-gate": return { message: "", timeout_minutes: 60 };
    case "map-reduce":    return { mappers: [], reducer: "", reducer_prompt: "" };
    default:              return {};
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("ic-node-editor")
export class IcNodeEditor extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
        width: 320px;
        border-left: 1px solid var(--ic-border);
        overflow-y: auto;
        background: var(--ic-surface);
        padding: 16px;
      }

      .section-header {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text);
        margin: 16px 0 8px;
      }

      .section-header:first-of-type {
        margin-top: 0;
      }

      h3 {
        margin: 0 0 4px;
        font-size: var(--ic-text-base);
        color: var(--ic-text);
      }

      .node-id-label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
        margin-bottom: 12px;
      }

      /* Form elements */
      textarea,
      input[type="text"],
      input[type="number"],
      select {
        width: 100%;
        padding: 6px 8px;
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-sm);
        background: var(--ic-bg);
        color: var(--ic-text);
        font-family: var(--ic-font-sans);
        font-size: var(--ic-text-sm);
      }

      textarea {
        resize: vertical;
        font-family: var(--ic-font-mono);
        line-height: 1.4;
      }

      textarea:focus,
      input:focus,
      select:focus {
        outline: 2px solid var(--ic-accent);
        outline-offset: -1px;
        border-color: var(--ic-accent);
      }

      /* Variables toggle */
      .variables-toggle {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-top: 4px;
        padding: 2px 8px;
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-sm);
        background: transparent;
        color: var(--ic-text-muted);
        font-size: var(--ic-text-xs);
        cursor: pointer;
      }

      .variables-toggle:hover {
        background: var(--ic-surface-2);
        color: var(--ic-text);
      }

      .variables-list {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 6px;
      }

      .variable-chip {
        display: inline-block;
        padding: 2px 8px;
        border: 1px solid var(--ic-border);
        border-radius: 9999px;
        background: var(--ic-surface-2);
        color: var(--ic-text-muted);
        font-family: var(--ic-font-mono);
        font-size: var(--ic-text-xs);
        cursor: pointer;
        user-select: none;
      }

      .variable-chip:hover {
        background: color-mix(in srgb, var(--ic-accent) 15%, transparent);
        color: var(--ic-accent);
        border-color: var(--ic-accent);
      }

      .no-variables {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        font-style: italic;
      }

      /* Agent info */
      .agent-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .agent-row select {
        flex: 1;
      }

      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .status-dot--active {
        background: var(--ic-success, #22c55e);
      }

      .status-dot--suspended {
        background: var(--ic-danger, #ef4444);
      }

      .agent-info {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
        margin-top: 4px;
      }

      .allowlist-warning {
        margin-top: 6px;
        padding: 6px 8px;
        border-radius: var(--ic-radius-sm);
        background: color-mix(in srgb, var(--ic-warning, #f59e0b) 10%, transparent);
        border: 1px solid color-mix(in srgb, var(--ic-warning, #f59e0b) 30%, transparent);
        color: var(--ic-warning, #f59e0b);
        font-size: var(--ic-text-xs);
      }

      /* Dependency checkboxes */
      .dep-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .dep-item {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
      }

      .dep-item input[type="checkbox"] {
        width: auto;
        margin: 0;
        cursor: pointer;
      }

      .dep-task-preview {
        color: var(--ic-text-muted);
        font-size: var(--ic-text-xs);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 150px;
      }

      .cycle-error {
        color: var(--ic-danger, #ef4444);
        font-size: var(--ic-text-xs);
        margin-left: 4px;
      }

      /* Constraint fields */
      .constraint-row {
        margin-bottom: 8px;
      }

      .constraint-label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
        margin-bottom: 2px;
      }

      .constraint-help {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        margin-top: 2px;
      }

      /* Actions */
      .actions {
        display: flex;
        gap: 8px;
        margin-top: 16px;
      }

      .btn {
        flex: 1;
        padding: 6px 12px;
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-sm);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        text-align: center;
      }

      .btn-accent {
        background: color-mix(in srgb, var(--ic-accent) 10%, transparent);
        color: var(--ic-accent);
        border-color: color-mix(in srgb, var(--ic-accent) 30%, transparent);
      }

      .btn-accent:hover {
        background: color-mix(in srgb, var(--ic-accent) 20%, transparent);
      }

      .btn-danger {
        background: color-mix(in srgb, var(--ic-danger, #ef4444) 10%, transparent);
        color: var(--ic-danger, #ef4444);
        border-color: color-mix(in srgb, var(--ic-danger, #ef4444) 30%, transparent);
      }

      .btn-danger:hover {
        background: color-mix(in srgb, var(--ic-danger, #ef4444) 20%, transparent);
      }

      /* Loading state */
      .loading {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        font-style: italic;
      }

      .empty-state {
        padding: 32px 16px;
        text-align: center;
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
      }

      /* Node type system */
      .type-select {
        width: 100%;
        padding: 6px 8px;
        background: var(--ic-input-bg);
        color: var(--ic-text);
        border: 1px solid var(--ic-border);
        border-radius: 4px;
        font-size: var(--ic-text-sm);
        margin-bottom: 8px;
      }

      .type-description {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-secondary);
        margin-bottom: 12px;
      }

      .type-agent-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-bottom: 8px;
      }

      .type-agent-row {
        display: flex;
        gap: 4px;
        align-items: center;
      }

      .type-agent-row select {
        flex: 1;
      }

      .type-remove-btn {
        background: none;
        border: 1px solid var(--ic-border);
        color: var(--ic-text-secondary);
        border-radius: 4px;
        padding: 4px 8px;
        cursor: pointer;
        font-size: var(--ic-text-xs);
      }

      .type-remove-btn:hover {
        border-color: var(--ic-error);
        color: var(--ic-error);
      }

      .type-add-btn {
        background: none;
        border: 1px dashed var(--ic-border);
        color: var(--ic-text-secondary);
        border-radius: 4px;
        padding: 6px;
        cursor: pointer;
        font-size: var(--ic-text-xs);
        width: 100%;
        text-align: center;
      }

      .type-add-btn:hover {
        border-color: var(--ic-accent);
        color: var(--ic-accent);
      }

      .type-mapper-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px;
        border: 1px solid var(--ic-border);
        border-radius: 4px;
        margin-bottom: 4px;
      }

      .type-mapper-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
    `,
  ];

  // -- Properties (inputs) --------------------------------------------------

  @property({ attribute: false })
  node: PipelineNode | null = null;

  @property({ attribute: false })
  allNodes: ReadonlyArray<PipelineNode> = [];

  @property({ attribute: false })
  allEdges: ReadonlyArray<PipelineEdge> = [];

  @property({ attribute: false })
  rpcClient: RpcClient | null = null;

  // -- Internal state -------------------------------------------------------

  @state() private _agents: AgentEntry[] = [];
  @state() private _models: ModelEntry[] = [];
  @state() private _allowAgents: string[] = [];
  @state() private _agentsLoading = true;
  @state() private _modelsLoading = true;
  @state() private _showVariables = false;
  @state() private _cycleErrors: Map<string, boolean> = new Map();

  // Cache flags to prevent re-fetching on every render
  private _agentsLoaded = false;
  private _modelsLoaded = false;
  private _allowListLoaded = false;

  // Textarea ref for variable insertion
  private _textareaRef: HTMLTextAreaElement | null = null;

  // -- Lifecycle ------------------------------------------------------------

  override connectedCallback(): void {
    super.connectedCallback();
    this._loadAgents();
    this._loadModels();
    this._loadAllowList();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("rpcClient") && this.rpcClient) {
      // rpcClient was set after connectedCallback - retry loading
      if (!this._agentsLoaded) this._loadAgents();
      if (!this._modelsLoaded) this._loadModels();
      if (!this._allowListLoaded) this._loadAllowList();
    }
  }

  // -- RPC Data Fetching ----------------------------------------------------

  private async _loadAgents(): Promise<void> {
    if (this._agentsLoaded || !this.rpcClient) {
      this._agentsLoading = false;
      return;
    }

    try {
      const listResult = await this.rpcClient.call<{ agents: string[] }>("agents.list");
      const agentIds = listResult.agents ?? [];

      const settled = await Promise.allSettled(
        agentIds.map((agentId) =>
          this.rpcClient!.call<{
            agentId: string;
            config: { model?: string; provider?: string };
            suspended?: boolean;
          }>("agents.get", { agentId }),
        ),
      );

      this._agents = settled
        .filter(
          (r): r is PromiseFulfilledResult<{
            agentId: string;
            config: { model?: string; provider?: string };
            suspended?: boolean;
          }> => r.status === "fulfilled",
        )
        .map((r) => ({
          id: r.value.agentId,
          model: r.value.config?.model ?? "unknown",
          provider: r.value.config?.provider ?? "unknown",
          suspended: r.value.suspended === true,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));

      this._agentsLoaded = true;
    } catch {
      // RPC not available -- leave agents empty
      this._agents = [];
    } finally {
      this._agentsLoading = false;
    }
  }

  private async _loadModels(): Promise<void> {
    if (this._modelsLoaded || !this.rpcClient) {
      this._modelsLoading = false;
      return;
    }

    try {
      const result = await this.rpcClient.call<{
        providers: Array<{
          name: string;
          models: Array<string | { modelId: string }>;
        }>;
      }>("models.list", {});

      this._models = (result.providers ?? []).flatMap((p) =>
        (p.models ?? []).map((m) => ({
          provider: p.name,
          modelId: typeof m === "string" ? m : m.modelId,
        })),
      );

      this._modelsLoaded = true;
    } catch {
      this._models = [];
    } finally {
      this._modelsLoading = false;
    }
  }

  private async _loadAllowList(): Promise<void> {
    if (this._allowListLoaded || !this.rpcClient) return;

    try {
      const result = await this.rpcClient.call<{
        agentToAgent?: { allowAgents?: string[] };
      }>("config.read", { section: "security" });

      this._allowAgents = result?.agentToAgent?.allowAgents ?? [];
      this._allowListLoaded = true;
    } catch {
      // No admin trust or call failed -- treat as all allowed
      this._allowAgents = [];
      this._allowListLoaded = true;
    }
  }

  // -- Render ---------------------------------------------------------------

  override render() {
    if (!this.node) {
      return html`<div class="empty-state">Select a node to edit</div>`;
    }

    const node = this.node;
    const deps = this._getDependencies(node);
    const depCount = deps.length;

    return html`
      ${this._renderHeader(node)}
      ${this._renderTask(node)}
      ${node.typeId ? nothing : this._renderAgent(node)}
      ${this._renderDependencies(node)}
      ${this._renderConstraints(node, depCount)}
      ${this._renderRetries(node)}
      ${this._renderContextMode(node)}
      ${this._renderNodeType(node)}
      ${this._renderModelOverride(node)}
      ${this._renderActions(node)}
    `;
  }

  // -- Section 1: Header ----------------------------------------------------

  private _renderHeader(node: PipelineNode) {
    return html`
      <h3>${node.id}</h3>
      <div class="node-id-label">Node ID: ${node.id}</div>
    `;
  }

  // -- Section 2: Task -------------------------------------------------------

  private _renderTask(node: PipelineNode) {
    const deps = this._getDependencies(node);

    return html`
      <div class="section-header">Task</div>
      <textarea
        rows="4"
        .value=${node.task}
        @input=${(e: InputEvent) => {
          const textarea = e.target as HTMLTextAreaElement;
          this._textareaRef = textarea;
          this._dispatchNodeUpdate(node.id, { task: textarea.value });
        }}
        placeholder="Describe the task for this node..."
      ></textarea>
      <button
        class="variables-toggle"
        @click=${() => { this._showVariables = !this._showVariables; }}
      >
        ${this._showVariables ? "\u25BC" : "\u25B6"} Variables
      </button>
      ${this._showVariables ? this._renderVariablesList(deps) : nothing}
    `;
  }

  private _renderVariablesList(deps: Array<{ source: string }>) {
    if (deps.length === 0) {
      return html`<div class="no-variables">No dependencies -- add dependencies to use variables</div>`;
    }

    return html`
      <div class="variables-list">
        ${deps.map(
          (dep) => html`
            <span
              class="variable-chip"
              @click=${() => this._insertVariable(`{{${dep.source}.result}}`)}
            >{{${dep.source}.result}}</span>
          `,
        )}
      </div>
    `;
  }

  private _insertVariable(text: string): void {
    const textarea = this._textareaRef ??
      this.renderRoot.querySelector("textarea");
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    const newValue = value.substring(0, start) + text + value.substring(end);

    textarea.value = newValue;
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    textarea.focus();

    // Dispatch update
    if (this.node) {
      this._dispatchNodeUpdate(this.node.id, { task: newValue });
    }
  }

  // -- Section 3: Agent -----------------------------------------------------

  private _renderAgent(node: PipelineNode) {
    const selectedAgent = this._agents.find((a) => a.id === node.agentId);
    const showWarning =
      this._allowAgents.length > 0 &&
      node.agentId != null &&
      node.agentId !== "" &&
      !this._allowAgents.includes(node.agentId);

    return html`
      <div class="section-header">Agent</div>
      ${this._agentsLoading
        ? html`<div class="loading">Loading agents...</div>`
        : html`
            <div class="agent-row">
              <select
                .value=${node.agentId ?? ""}
                @change=${(e: Event) => {
                  const val = (e.target as HTMLSelectElement).value;
                  this._dispatchNodeUpdate(node.id, {
                    agentId: val || undefined,
                  });
                }}
              >
                <option value="">-- No agent (uses default) --</option>
                ${this._agents.map(
                  (a) => html`
                    <option value=${a.id} ?selected=${a.id === node.agentId}>
                      ${a.id}${a.suspended ? " (suspended)" : ""}
                    </option>
                  `,
                )}
              </select>
              ${selectedAgent
                ? html`<span
                    class="status-dot ${selectedAgent.suspended ? "status-dot--suspended" : "status-dot--active"}"
                    title=${selectedAgent.suspended ? "Suspended" : "Active"}
                  ></span>`
                : nothing}
            </div>
            ${selectedAgent
              ? html`<div class="agent-info">${selectedAgent.model} (${selectedAgent.provider})</div>`
              : nothing}
            ${showWarning
              ? html`<div class="allowlist-warning">This agent is not in the security allowlist and may be restricted</div>`
              : nothing}
          `}
    `;
  }

  // -- Section 4: Dependencies -----------------------------------------------

  private _renderDependencies(node: PipelineNode) {
    // Other nodes sorted by visual position (y asc, x asc)
    const otherNodes = this.allNodes
      .filter((n) => n.id !== node.id)
      .slice()
      .sort((a, b) => {
        const dy = a.position.y - b.position.y;
        return dy !== 0 ? dy : a.position.x - b.position.x;
      });

    if (otherNodes.length === 0) {
      return html`
        <div class="section-header">Dependencies</div>
        <div class="loading">No other nodes in graph</div>
      `;
    }

    return html`
      <div class="section-header">Dependencies</div>
      <div class="dep-list">
        ${otherNodes.map((other) => {
          const isChecked = this.allEdges.some(
            (e) => e.source === other.id && e.target === node.id,
          );
          const hasCycleError = this._cycleErrors.get(other.id) ?? false;

          return html`
            <label class="dep-item">
              <input
                type="checkbox"
                .checked=${isChecked}
                @change=${(e: Event) => {
                  const checked = (e.target as HTMLInputElement).checked;
                  this._handleDependencyChange(node.id, other.id, checked);
                }}
              />
              <span>${other.id}</span>
              <span class="dep-task-preview">${this._truncate(other.task, 30)}</span>
              ${hasCycleError
                ? html`<span class="cycle-error">Would create cycle</span>`
                : nothing}
            </label>
          `;
        })}
      </div>
    `;
  }

  private _handleDependencyChange(
    nodeId: string,
    depNodeId: string,
    checked: boolean,
  ): void {
    if (checked) {
      // Validate with cycle detection
      if (wouldCreateCycle(this.allEdges, depNodeId, nodeId)) {
        // Prevent check and show error
        const newErrors = new Map(this._cycleErrors);
        newErrors.set(depNodeId, true);
        this._cycleErrors = newErrors;

        // Clear error after 2 seconds
        setTimeout(() => {
          const cleared = new Map(this._cycleErrors);
          cleared.delete(depNodeId);
          this._cycleErrors = cleared;
        }, 2000);
        return;
      }

      this.dispatchEvent(
        new CustomEvent("edge-add", {
          detail: { source: depNodeId, target: nodeId },
          bubbles: true,
          composed: true,
        }),
      );
    } else {
      this.dispatchEvent(
        new CustomEvent("edge-remove", {
          detail: { source: depNodeId, target: nodeId },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  // -- Section 5: Constraints ------------------------------------------------

  private _renderConstraints(node: PipelineNode, depCount: number) {
    const barrierHelp: Record<string, string> = {
      all: "Wait for all dependencies to complete",
      majority: "Proceed when >50% of dependencies complete",
      "best-effort": "Proceed when any dependency completes",
    };

    return html`
      <div class="section-header">Constraints</div>

      ${depCount >= 2
        ? html`
            <div class="constraint-row">
              <div class="constraint-label">Barrier Mode</div>
              <select
                .value=${node.barrierMode ?? "all"}
                @change=${(e: Event) => {
                  const val = (e.target as HTMLSelectElement).value as
                    | "all"
                    | "majority"
                    | "best-effort";
                  this._dispatchNodeUpdate(node.id, { barrierMode: val });
                }}
              >
                <option value="all">all</option>
                <option value="majority">majority</option>
                <option value="best-effort">best-effort</option>
              </select>
              <div class="constraint-help">
                ${barrierHelp[node.barrierMode ?? "all"]}
              </div>
            </div>
          `
        : nothing}

      <div class="constraint-row">
        <div class="constraint-label">Timeout (ms)</div>
        <input
          type="number"
          min="0"
          step="1000"
          placeholder="Default"
          .value=${node.timeoutMs != null ? String(node.timeoutMs) : ""}
          @change=${(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            this._dispatchNodeUpdate(node.id, {
              timeoutMs: val ? Number(val) : undefined,
            });
          }}
        />
      </div>

      <div class="constraint-row">
        <div class="constraint-label">Max Steps</div>
        <input
          type="number"
          min="1"
          max="50"
          placeholder="Default"
          .value=${node.maxSteps != null ? String(node.maxSteps) : ""}
          @change=${(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            this._dispatchNodeUpdate(node.id, {
              maxSteps: val ? Number(val) : undefined,
            });
          }}
        />
      </div>
    `;
  }

  // -- Section 6a: Retries ---------------------------------------------------

  private _renderRetries(node: PipelineNode) {
    return html`
      <div class="constraint-row">
        <div class="constraint-label">Retries</div>
        <input
          type="number"
          min="0"
          max="3"
          step="1"
          placeholder="0"
          .value=${node.retries != null ? String(node.retries) : ""}
          @change=${(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            this._dispatchNodeUpdate(node.id, {
              retries: val ? Number(val) : undefined,
            });
          }}
        />
        <div class="constraint-help">Automatic retry with exponential backoff (0-3)</div>
      </div>
    `;
  }

  // -- Section 6b: Context Mode ---------------------------------------------

  private _renderContextMode(node: PipelineNode) {
    return html`
      <div class="constraint-row">
        <div class="constraint-label">Context Mode</div>
        <select
          .value=${node.contextMode ?? "full"}
          @change=${(e: Event) => {
            const val = (e.target as HTMLSelectElement).value as
              | "full"
              | "summary"
              | "none";
            this._dispatchNodeUpdate(node.id, {
              contextMode: val === "full" ? undefined : val,
            });
          }}
        >
          <option value="full">full (complete upstream outputs)</option>
          <option value="summary">summary (truncated + shared dir ref)</option>
          <option value="none">none (inline templates only)</option>
        </select>
      </div>
    `;
  }

  // -- Section 6c: Node Type ------------------------------------------------

  private _renderNodeType(node: PipelineNode) {
    return html`
      <div class="section-header">Node Type</div>
      <select
        class="type-select"
        .value=${node.typeId ?? ""}
        @change=${(e: Event) => {
          const val = (e.target as HTMLSelectElement).value;
          if (val === "") {
            this._dispatchNodeUpdate(node.id, { typeId: undefined, typeConfig: undefined });
          } else {
            this._dispatchNodeUpdate(node.id, {
              typeId: val as NodeTypeId,
              typeConfig: getDefaultTypeConfig(val),
            });
          }
        }}
      >
        <option value="">Standard (no type driver)</option>
        ${Object.entries(NODE_TYPE_METADATA).map(
          ([id, meta]) => html`
            <option value=${id} ?selected=${node.typeId === id}>${meta.label}</option>
          `,
        )}
      </select>
      ${node.typeId && NODE_TYPE_METADATA[node.typeId]
        ? html`<div class="type-description">${NODE_TYPE_METADATA[node.typeId]!.description}</div>`
        : nothing}
      ${node.typeId ? this._renderTypeConfigForm(node) : nothing}
    `;
  }

  private _renderTypeConfigForm(node: PipelineNode) {
    const config = (node.typeConfig ?? {}) as Record<string, unknown>;
    switch (node.typeId) {
      case "agent":         return this._renderAgentTypeConfig(node, config);
      case "debate":        return this._renderDebateTypeConfig(node, config);
      case "vote":          return this._renderVoteTypeConfig(node, config);
      case "refine":        return this._renderRefineTypeConfig(node, config);
      case "collaborate":   return this._renderCollaborateTypeConfig(node, config);
      case "approval-gate": return this._renderApprovalGateTypeConfig(node, config);
      case "map-reduce":    return this._renderMapReduceTypeConfig(node, config);
      default:              return nothing;
    }
  }

  private _renderAgentTypeConfig(node: PipelineNode, config: Record<string, unknown>) {
    return html`
      <div class="constraint-row">
        <div class="constraint-label">Agent</div>
        <select
          .value=${String(config.agent ?? "")}
          @change=${(e: Event) => {
            const val = (e.target as HTMLSelectElement).value;
            this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, agent: val || undefined } });
          }}
        >
          <option value="">-- Select agent --</option>
          ${this._agents.map((a) => html`
            <option value=${a.id} ?selected=${a.id === config.agent}>${a.id}${a.suspended ? " (suspended)" : ""}</option>
          `)}
        </select>
      </div>
      <div class="constraint-row">
        <div class="constraint-label">Model</div>
        <select
          .value=${String(config.model ?? "")}
          @change=${(e: Event) => {
            const val = (e.target as HTMLSelectElement).value;
            this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, model: val || undefined } });
          }}
        >
          <option value="">-- Default --</option>
          ${this._models.map((m) => html`
            <option value=${m.modelId} ?selected=${m.modelId === config.model}>${m.modelId}</option>
          `)}
        </select>
      </div>
      <div class="constraint-row">
        <div class="constraint-label">Max Steps</div>
        <input type="number" min="1" max="50" placeholder="10"
          .value=${config.max_steps != null ? String(config.max_steps) : ""}
          @change=${(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, max_steps: val ? Number(val) : undefined } });
          }}
        />
      </div>
    `;
  }

  private _renderDebateTypeConfig(node: PipelineNode, config: Record<string, unknown>) {
    const agents = (Array.isArray(config.agents) ? config.agents : []) as string[];
    return html`
      <div class="constraint-label">Debate Agents (min 2)</div>
      <div class="type-agent-list">
        ${agents.map((agentId, idx) => html`
          <div class="type-agent-row">
            <select .value=${agentId} @change=${(e: Event) => {
              const val = (e.target as HTMLSelectElement).value;
              const newAgents = [...agents]; newAgents[idx] = val;
              this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, agents: newAgents } });
            }}>
              <option value="">-- Select agent --</option>
              ${this._agents.map((a) => html`<option value=${a.id} ?selected=${a.id === agentId}>${a.id}${a.suspended ? " (suspended)" : ""}</option>`)}
            </select>
            <button class="type-remove-btn" @click=${() => {
              this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, agents: agents.filter((_, i) => i !== idx) } });
            }}>Remove</button>
          </div>
        `)}
        <button class="type-add-btn" @click=${() => {
          this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, agents: [...agents, ""] } });
        }}>+ Add agent</button>
      </div>
      <div class="constraint-row">
        <div class="constraint-label">Rounds</div>
        <input type="number" min="1" max="5" placeholder="2"
          .value=${config.rounds != null ? String(config.rounds) : ""}
          @change=${(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, rounds: val ? Number(val) : undefined } });
          }}
        />
      </div>
      <div class="constraint-row">
        <div class="constraint-label">Synthesizer</div>
        <select .value=${String(config.synthesizer ?? "")} @change=${(e: Event) => {
          const val = (e.target as HTMLSelectElement).value;
          this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, synthesizer: val || undefined } });
        }}>
          <option value="">-- None --</option>
          ${this._agents.map((a) => html`<option value=${a.id} ?selected=${a.id === config.synthesizer}>${a.id}${a.suspended ? " (suspended)" : ""}</option>`)}
        </select>
      </div>
    `;
  }

  private _renderVoteTypeConfig(node: PipelineNode, config: Record<string, unknown>) {
    const voters = (Array.isArray(config.voters) ? config.voters : []) as string[];
    return html`
      <div class="constraint-label">Voters (min 2)</div>
      <div class="type-agent-list">
        ${voters.map((agentId, idx) => html`
          <div class="type-agent-row">
            <select .value=${agentId} @change=${(e: Event) => {
              const val = (e.target as HTMLSelectElement).value;
              const nv = [...voters]; nv[idx] = val;
              this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, voters: nv } });
            }}>
              <option value="">-- Select agent --</option>
              ${this._agents.map((a) => html`<option value=${a.id} ?selected=${a.id === agentId}>${a.id}${a.suspended ? " (suspended)" : ""}</option>`)}
            </select>
            <button class="type-remove-btn" @click=${() => {
              this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, voters: voters.filter((_, i) => i !== idx) } });
            }}>Remove</button>
          </div>
        `)}
        <button class="type-add-btn" @click=${() => {
          this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, voters: [...voters, ""] } });
        }}>+ Add voter</button>
      </div>
      <div class="constraint-row">
        <div class="constraint-label">Verdict Format</div>
        <input type="text" placeholder="YES or NO with justification"
          .value=${String(config.verdict_format ?? "")}
          @change=${(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, verdict_format: val || undefined } });
          }}
        />
      </div>
      <div class="constraint-row">
        <div class="constraint-label">Prompt Suffix</div>
        <textarea rows="2" placeholder="Additional instructions for voters..."
          .value=${String(config.prompt_suffix ?? "")}
          @change=${(e: Event) => {
            const val = (e.target as HTMLTextAreaElement).value;
            this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, prompt_suffix: val || undefined } });
          }}
        ></textarea>
      </div>
      <div class="constraint-row">
        <div class="constraint-label">Min Voters</div>
        <input type="number" min="0" max="20" placeholder="0 (all)"
          .value=${config.min_voters != null ? String(config.min_voters) : ""}
          @change=${(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, min_voters: val ? Number(val) : undefined } });
          }}
        />
      </div>
    `;
  }

  private _renderRefineTypeConfig(node: PipelineNode, config: Record<string, unknown>) {
    const reviewers = (Array.isArray(config.reviewers) ? config.reviewers : []) as string[];
    return html`
      <div class="constraint-label">Reviewers (min 2, sequential order)</div>
      <div class="type-agent-list">
        ${reviewers.map((agentId, idx) => html`
          <div class="type-agent-row">
            <select .value=${agentId} @change=${(e: Event) => {
              const val = (e.target as HTMLSelectElement).value;
              const nr = [...reviewers]; nr[idx] = val;
              this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, reviewers: nr } });
            }}>
              <option value="">-- Select agent --</option>
              ${this._agents.map((a) => html`<option value=${a.id} ?selected=${a.id === agentId}>${a.id}${a.suspended ? " (suspended)" : ""}</option>`)}
            </select>
            <button class="type-remove-btn" @click=${() => {
              this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, reviewers: reviewers.filter((_, i) => i !== idx) } });
            }}>Remove</button>
          </div>
        `)}
        <button class="type-add-btn" @click=${() => {
          this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, reviewers: [...reviewers, ""] } });
        }}>+ Add reviewer</button>
      </div>
    `;
  }

  private _renderCollaborateTypeConfig(node: PipelineNode, config: Record<string, unknown>) {
    const agents = (Array.isArray(config.agents) ? config.agents : []) as string[];
    return html`
      <div class="constraint-label">Collaborators (min 2)</div>
      <div class="type-agent-list">
        ${agents.map((agentId, idx) => html`
          <div class="type-agent-row">
            <select .value=${agentId} @change=${(e: Event) => {
              const val = (e.target as HTMLSelectElement).value;
              const na = [...agents]; na[idx] = val;
              this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, agents: na } });
            }}>
              <option value="">-- Select agent --</option>
              ${this._agents.map((a) => html`<option value=${a.id} ?selected=${a.id === agentId}>${a.id}${a.suspended ? " (suspended)" : ""}</option>`)}
            </select>
            <button class="type-remove-btn" @click=${() => {
              this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, agents: agents.filter((_, i) => i !== idx) } });
            }}>Remove</button>
          </div>
        `)}
        <button class="type-add-btn" @click=${() => {
          this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, agents: [...agents, ""] } });
        }}>+ Add collaborator</button>
      </div>
      <div class="constraint-row">
        <div class="constraint-label">Rounds</div>
        <input type="number" min="1" max="3" placeholder="1"
          .value=${config.rounds != null ? String(config.rounds) : ""}
          @change=${(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, rounds: val ? Number(val) : undefined } });
          }}
        />
      </div>
    `;
  }

  private _renderApprovalGateTypeConfig(node: PipelineNode, config: Record<string, unknown>) {
    return html`
      <div class="constraint-row">
        <div class="constraint-label">Message</div>
        <textarea rows="2" placeholder="Approval request message..."
          .value=${String(config.message ?? "")}
          @change=${(e: Event) => {
            const val = (e.target as HTMLTextAreaElement).value;
            this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, message: val || undefined } });
          }}
        ></textarea>
      </div>
      <div class="constraint-row">
        <div class="constraint-label">Timeout (min)</div>
        <input type="number" min="1" max="1440" placeholder="60"
          .value=${config.timeout_minutes != null ? String(config.timeout_minutes) : ""}
          @change=${(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, timeout_minutes: val ? Number(val) : undefined } });
          }}
        />
      </div>
    `;
  }

  private _renderMapReduceTypeConfig(node: PipelineNode, config: Record<string, unknown>) {
    const mappers = (Array.isArray(config.mappers) ? config.mappers : []) as Array<{ agent: string; task_suffix?: string }>;
    return html`
      <div class="constraint-label">Mappers (min 2)</div>
      <div class="type-agent-list">
        ${mappers.map((mapper, idx) => html`
          <div class="type-mapper-row">
            <div class="type-mapper-header">
              <span class="constraint-label">Mapper ${idx + 1}</span>
              <button class="type-remove-btn" @click=${() => {
                this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, mappers: mappers.filter((_, i) => i !== idx) } });
              }}>Remove</button>
            </div>
            <select .value=${mapper.agent ?? ""} @change=${(e: Event) => {
              const val = (e.target as HTMLSelectElement).value;
              const nm = [...mappers]; nm[idx] = { ...mapper, agent: val };
              this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, mappers: nm } });
            }}>
              <option value="">-- Select agent --</option>
              ${this._agents.map((a) => html`<option value=${a.id} ?selected=${a.id === mapper.agent}>${a.id}${a.suspended ? " (suspended)" : ""}</option>`)}
            </select>
            <input type="text" placeholder="Task suffix (optional)"
              .value=${mapper.task_suffix ?? ""}
              @change=${(e: Event) => {
                const val = (e.target as HTMLInputElement).value;
                const nm = [...mappers]; nm[idx] = { ...mapper, task_suffix: val || undefined };
                this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, mappers: nm } });
              }}
            />
          </div>
        `)}
        <button class="type-add-btn" @click=${() => {
          this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, mappers: [...mappers, { agent: "" }] } });
        }}>+ Add mapper</button>
      </div>
      <div class="constraint-row">
        <div class="constraint-label">Reducer Agent</div>
        <select .value=${String(config.reducer ?? "")} @change=${(e: Event) => {
          const val = (e.target as HTMLSelectElement).value;
          this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, reducer: val || undefined } });
        }}>
          <option value="">-- Select agent --</option>
          ${this._agents.map((a) => html`<option value=${a.id} ?selected=${a.id === config.reducer}>${a.id}${a.suspended ? " (suspended)" : ""}</option>`)}
        </select>
      </div>
      <div class="constraint-row">
        <div class="constraint-label">Reducer Prompt</div>
        <textarea rows="2" placeholder="Instructions for the reducer..."
          .value=${String(config.reducer_prompt ?? "")}
          @change=${(e: Event) => {
            const val = (e.target as HTMLTextAreaElement).value;
            this._dispatchNodeUpdate(node.id, { typeConfig: { ...config, reducer_prompt: val || undefined } });
          }}
        ></textarea>
      </div>
    `;
  }

  // -- Section 7: Model Override --------------------------------------------

  private _renderModelOverride(node: PipelineNode) {
    // Group models by provider
    const grouped = new Map<string, string[]>();
    for (const m of this._models) {
      let group = grouped.get(m.provider);
      if (!group) {
        group = [];
        grouped.set(m.provider, group);
      }
      group.push(m.modelId);
    }

    return html`
      <div class="section-header">Model Override</div>
      ${this._modelsLoading
        ? html`<div class="loading">Loading models...</div>`
        : html`
            <select
              .value=${node.modelId ?? ""}
              @change=${(e: Event) => {
                const val = (e.target as HTMLSelectElement).value;
                this._dispatchNodeUpdate(node.id, {
                  modelId: val || undefined,
                });
              }}
            >
              <option value="">-- Use agent default --</option>
              ${[...grouped.entries()].map(
                ([provider, models]) => html`
                  <optgroup label=${provider}>
                    ${models.map(
                      (modelId) => html`
                        <option
                          value=${modelId}
                          ?selected=${modelId === node.modelId}
                        >
                          ${modelId}
                        </option>
                      `,
                    )}
                  </optgroup>
                `,
              )}
            </select>
          `}
    `;
  }

  // -- Section 8: Actions ---------------------------------------------------

  private _renderActions(node: PipelineNode) {
    return html`
      <div class="actions">
        <button
          class="btn btn-accent"
          @click=${() => {
            this.dispatchEvent(
              new CustomEvent("node-duplicate", {
                detail: { nodeId: node.id },
                bubbles: true,
                composed: true,
              }),
            );
          }}
        >
          Duplicate
        </button>
        <button
          class="btn btn-danger"
          @click=${() => {
            this.dispatchEvent(
              new CustomEvent("node-delete", {
                detail: { nodeId: node.id },
                bubbles: true,
                composed: true,
              }),
            );
          }}
        >
          Delete
        </button>
      </div>
    `;
  }

  // -- Helpers --------------------------------------------------------------

  /** Get edges where target = this node (dependencies). */
  private _getDependencies(node: PipelineNode): Array<{ source: string; target: string }> {
    return this.allEdges.filter((e) => e.target === node.id);
  }

  /** Dispatch node-update event. */
  private _dispatchNodeUpdate(
    nodeId: string,
    partial: Partial<PipelineNode>,
  ): void {
    this.dispatchEvent(
      new CustomEvent("node-update", {
        detail: { nodeId, partial },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Truncate text with ellipsis. */
  private _truncate(text: string, maxLen: number): string {
    if (text.length > maxLen) {
      return text.slice(0, maxLen - 1) + "\u2026";
    }
    return text;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-node-editor": IcNodeEditor;
  }
}
