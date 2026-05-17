// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { ApiClient } from "../api/api-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { systemDateFrom } from "@comis/core";
// Side-effect imports for sub-components
import "../components/nav/ic-tabs.js";
import "../components/form/ic-search-input.js";
import "../components/feedback/ic-empty-state.js";
import "../components/feedback/ic-loading.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/feedback/ic-confirm-dialog.js";
import "../components/data/ic-tag.js";

import {
  createSkillsController,
  SKILLS_TABS,
  TOOL_CATEGORIES,
  TOOL_DESCRIPTIONS,
  TOOL_PARAM_HINTS,
  PLATFORM_TOOL_CATEGORIES,
  PLATFORM_TOOL_DESCRIPTIONS,
  agentIdFromLocation,
  type SkillsController,
  type SkillsViewSnapshot,
  type DiscoveredSkill,
  type SkillsConfig,
} from "./skills-controller.js";

/**
 * Skills management view with 2 tabs: Built-in Tools (with Platform Tools
 * and Tool Policy merged in) and Prompt Skills.
 *
 * State + RPC orchestration is owned by `SkillsController`. This view
 * keeps Lit decorators, render(), and template helpers.
 */
@customElement("ic-skills-view")
export class IcSkillsView extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host { display: block; }
      .view-header { margin-bottom: var(--ic-space-lg); }
      .view-title { font-size: 1.125rem; font-weight: 600; }
      /* Loading & error states */
      .state-container { display: flex; align-items: center; justify-content: center; padding: 3rem; }
      .error-container { display: flex; flex-direction: column; align-items: center; gap: 0.75rem; padding: 3rem; }
      .error-message { color: var(--ic-error); font-size: var(--ic-text-sm); }
      .retry-btn { padding: 0.5rem 1rem; background: var(--ic-surface-2); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md); color: var(--ic-text-muted); font-size: var(--ic-text-sm); cursor: pointer; font-family: inherit; }
      .retry-btn:hover { background: var(--ic-border); }
      /* Category headers */
      .category-header { font-size: var(--ic-text-sm); font-weight: 600; color: var(--ic-text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-top: var(--ic-space-lg); margin-bottom: var(--ic-space-sm); }
      .category-header:first-of-type { margin-top: 0; }
      /* Tool cards grid */
      .tool-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: var(--ic-space-md); }
      .tool-card { background: var(--ic-surface); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md); padding: var(--ic-space-md); display: flex; flex-direction: column; gap: var(--ic-space-xs); }
      .tool-card-header { display: flex; align-items: center; justify-content: space-between; gap: var(--ic-space-sm); }
      .tool-name { font-weight: 600; font-size: var(--ic-text-sm); }
      .tool-desc { font-size: var(--ic-text-xs); color: var(--ic-text-dim); line-height: 1.4; }
      .tool-params { font-size: var(--ic-text-xs); color: var(--ic-text-dim); margin-top: var(--ic-space-xs); padding-left: var(--ic-space-sm); border-left: 2px solid var(--ic-border); }
      .tool-params li { list-style: none; padding: 1px 0; font-family: var(--ic-font-mono, monospace); font-size: 0.7rem; }
      /* Tool status hint */
      .tool-hint { font-size: var(--ic-text-xs); color: var(--ic-text-dim); margin-top: var(--ic-space-sm); font-style: italic; }
      /* Prompt skills form */
      .form-section { display: flex; flex-direction: column; gap: var(--ic-space-md); max-width: 32rem; }
      .form-field { display: flex; flex-direction: column; gap: var(--ic-space-xs); }
      .form-label { font-size: var(--ic-text-sm); font-weight: 500; color: var(--ic-text-muted); }
      .form-input { padding: 0.5rem 0.75rem; background: var(--ic-surface-2); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md); color: var(--ic-text); font-family: inherit; font-size: var(--ic-text-sm); }
      .form-input:focus { outline: none; border-color: var(--ic-accent); }
      .form-row { display: flex; align-items: center; gap: var(--ic-space-sm); }
      /* Skill lists (allowed/denied) */
      .list-section { margin-top: var(--ic-space-lg); }
      .list-title { font-size: var(--ic-text-sm); font-weight: 600; color: var(--ic-text-muted); margin-bottom: var(--ic-space-sm); }
      .list-items { display: flex; flex-wrap: wrap; gap: var(--ic-space-xs); margin-bottom: var(--ic-space-sm); }
      .list-item { display: inline-flex; align-items: center; gap: var(--ic-space-xs); background: var(--ic-surface-2); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md); padding: 0.25rem 0.5rem; font-size: var(--ic-text-xs); }
      .list-item-remove { background: none; border: none; color: var(--ic-text-dim); cursor: pointer; padding: 0; font-size: var(--ic-text-xs); line-height: 1; }
      .list-item-remove:hover { color: var(--ic-error); }
      .list-add-row { display: flex; gap: var(--ic-space-xs); max-width: 20rem; }
      .list-add-input { flex: 1; padding: 0.375rem 0.5rem; background: var(--ic-surface-2); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md); color: var(--ic-text); font-family: inherit; font-size: var(--ic-text-xs); }
      .list-add-input:focus { outline: none; border-color: var(--ic-accent); }
      .list-add-btn { padding: 0.375rem 0.75rem; background: var(--ic-accent); color: white; border: none; border-radius: var(--ic-radius-md); font-size: var(--ic-text-xs); cursor: pointer; white-space: nowrap; }
      .list-add-btn:hover { opacity: 0.9; }
      .empty-list { font-size: var(--ic-text-xs); color: var(--ic-text-dim); font-style: italic; }
      /* MCP server cards (legacy classes kept for shared style continuity) */
      .server-list { display: flex; flex-direction: column; gap: var(--ic-space-md); }
      .server-card { background: var(--ic-surface); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md); padding: var(--ic-space-md); display: flex; flex-direction: column; gap: var(--ic-space-sm); }
      .server-header { display: flex; align-items: center; justify-content: space-between; gap: var(--ic-space-sm); }
      .server-name { font-weight: 600; font-size: var(--ic-text-sm); }
      .server-meta { display: flex; align-items: center; gap: var(--ic-space-sm); }
      .server-command { font-family: ui-monospace, monospace; font-size: var(--ic-text-xs); color: var(--ic-text-dim); word-break: break-all; }
      .server-remove { background: none; border: none; color: var(--ic-text-dim); cursor: pointer; padding: 0.125rem 0.25rem; font-size: var(--ic-text-sm); line-height: 1; border-radius: var(--ic-radius-sm); }
      .server-remove:hover { color: var(--ic-error); background: var(--ic-surface-2); }
      .server-test-btn { background: var(--ic-surface-2); border: 1px solid var(--ic-border); color: var(--ic-text-muted); cursor: pointer; padding: 0.125rem 0.5rem; font-size: var(--ic-text-xs); border-radius: var(--ic-radius-sm); }
      .server-test-btn:hover:not(:disabled) { background: var(--ic-surface-3, var(--ic-surface)); color: var(--ic-text); }
      .server-test-btn:disabled { opacity: 0.6; cursor: not-allowed; }
      .server-test-result { font-size: var(--ic-text-xs); padding: 0.25rem 0.5rem; border-radius: var(--ic-radius-sm); margin-top: 0.125rem; }
      .server-test-success { color: var(--ic-success, #22c55e); background: rgba(34, 197, 94, 0.1); }
      .server-env-badge { display: inline-block; font-family: ui-monospace, monospace; font-size: var(--ic-text-xs); color: var(--ic-text-dim); background: rgba(147, 130, 220, 0.15); padding: 1px 6px; border-radius: 4px; margin-top: 2px; }
      .server-test-error { color: var(--ic-error, #ef4444); background: rgba(239, 68, 68, 0.1); word-break: break-word; }
      /* Add server form */
      .add-server-form { background: var(--ic-surface); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md); padding: var(--ic-space-md); display: flex; flex-direction: column; gap: var(--ic-space-sm); margin-top: var(--ic-space-lg); max-width: 32rem; }
      .add-server-title { font-size: var(--ic-text-sm); font-weight: 600; color: var(--ic-text-muted); }
      .add-server-row { display: flex; gap: var(--ic-space-sm); flex-wrap: wrap; }
      .add-server-input { flex: 1; min-width: 10rem; padding: 0.5rem 0.75rem; background: var(--ic-surface-2); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md); color: var(--ic-text); font-family: inherit; font-size: var(--ic-text-sm); }
      .add-server-input:focus { outline: none; border-color: var(--ic-accent); }
      .add-server-select { padding: 0.5rem 0.75rem; background: var(--ic-surface-2); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md); color: var(--ic-text); font-family: inherit; font-size: var(--ic-text-sm); }
      .add-server-btn { padding: 0.5rem 1rem; background: var(--ic-accent); color: white; border: none; border-radius: var(--ic-radius-md); font-size: var(--ic-text-sm); cursor: pointer; white-space: nowrap; }
      .add-server-btn:hover { opacity: 0.9; }
      /* Tool policy */
      .policy-section { max-width: 32rem; }
      .policy-field { display: flex; flex-direction: column; gap: var(--ic-space-xs); margin-bottom: var(--ic-space-md); }
      .policy-select { padding: 0.5rem 0.75rem; background: var(--ic-surface-2); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md); color: var(--ic-text); font-family: inherit; font-size: var(--ic-text-sm); max-width: 16rem; }
      .policy-select:focus { outline: none; border-color: var(--ic-accent); }
      /* Resolved tool set */
      .resolved-section { margin-top: var(--ic-space-lg); }
      .resolved-title { font-size: var(--ic-text-sm); font-weight: 600; color: var(--ic-text-muted); margin-bottom: var(--ic-space-sm); }
      .resolved-tools { display: flex; flex-wrap: wrap; gap: var(--ic-space-xs); }
      .resolved-denied { opacity: 0.4; text-decoration: line-through; }
      /* Add Skill panel */
      .add-skill-panel { margin-top: var(--ic-space-xl); background: var(--ic-surface); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-lg); padding: var(--ic-space-lg); }
      .add-skill-title { font-size: var(--ic-text-base); font-weight: 600; color: var(--ic-text); margin-bottom: var(--ic-space-sm); }
      .install-target { display: flex; align-items: center; gap: var(--ic-space-sm); padding: var(--ic-space-sm) var(--ic-space-md); background: var(--ic-surface-2, #1f2937); border-radius: var(--ic-radius-md); margin-bottom: var(--ic-space-lg); flex-wrap: wrap; }
      .install-target-label { font-size: var(--ic-text-sm); color: var(--ic-text-dim); white-space: nowrap; }
      .install-target-select { padding: 0.25rem 0.5rem; background: var(--ic-surface); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md); color: var(--ic-text); font-size: var(--ic-text-sm); font-family: inherit; cursor: pointer; }
      .install-target-select:focus-visible { outline: 2px solid var(--ic-accent); outline-offset: 2px; }
      .install-target-hint { font-size: var(--ic-text-xs); color: var(--ic-text-dim); font-style: italic; }
      .add-skill-methods { display: grid; grid-template-columns: 1fr 1fr; gap: var(--ic-space-md); }
      @media (max-width: 767px) {
        .add-skill-methods { grid-template-columns: 1fr; }
      }
      .add-skill-method { display: flex; flex-direction: column; gap: var(--ic-space-sm); }
      .add-skill-method-title { font-size: var(--ic-text-sm); font-weight: 600; color: var(--ic-text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
      .add-skill-method-body { flex: 1; display: flex; align-items: center; }
      .upload-skill-btn { display: block; width: 100%; padding: 0.75rem; background: var(--ic-surface); border: 2px dashed var(--ic-border); border-radius: var(--ic-radius-md); color: var(--ic-accent); font-size: var(--ic-text-sm); font-weight: 500; cursor: pointer; font-family: inherit; text-align: center; }
      .upload-skill-btn:hover { border-color: var(--ic-accent); background: color-mix(in srgb, var(--ic-accent) 5%, var(--ic-surface)); }
      .upload-skill-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .upload-skill-hint { font-size: var(--ic-text-xs); color: var(--ic-text-dim); text-align: center; }
      .import-skill-row { display: flex; gap: var(--ic-space-sm); }
      .import-skill-row input { flex: 1; min-width: 0; padding: 0.5rem 0.75rem; background: var(--ic-surface-2); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md); color: var(--ic-text); font-family: inherit; font-size: var(--ic-text-sm); }
      .import-skill-row input:focus { outline: none; border-color: var(--ic-accent); }
      .import-skill-btn { padding: 0.5rem 1rem; background: var(--ic-accent); color: white; border: none; border-radius: var(--ic-radius-md); font-size: var(--ic-text-sm); font-weight: 500; cursor: pointer; white-space: nowrap; font-family: inherit; }
      .import-skill-btn:hover { opacity: 0.9; }
      .import-skill-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .skill-delete-btn { background: none; border: none; color: var(--ic-text-dim); cursor: pointer; padding: 0; font-size: var(--ic-text-xs); line-height: 1; }
      .skill-delete-btn:hover { color: var(--ic-error); }
      /* Recent activity section (SSE live events) */
      .recent-activity { margin-top: var(--ic-space-lg); border-top: 1px solid var(--ic-border); padding-top: var(--ic-space-lg); }
      .recent-activity h3 { font-size: var(--ic-text-sm); font-weight: 600; color: var(--ic-text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--ic-space-sm); }
      .recent-activity-count { font-size: var(--ic-text-xs); color: var(--ic-text-dim); font-weight: 400; text-transform: none; letter-spacing: normal; }
      .event-list { display: flex; flex-direction: column; gap: var(--ic-space-xs); }
      .event-entry { display: flex; align-items: center; gap: var(--ic-space-sm); padding: var(--ic-space-xs) var(--ic-space-sm); background: var(--ic-surface); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md); font-size: var(--ic-text-xs); }
      .event-skill { font-family: var(--ic-font-mono, monospace); font-weight: 500; color: var(--ic-text); }
      .event-agent { color: var(--ic-text-dim); }
      .event-outcome--executed { color: #22c55e; font-weight: 500; }
      .event-outcome--rejected { color: #ef4444; font-weight: 500; }
      .event-reason { color: var(--ic-text-dim); font-style: italic; }
      .event-time { margin-left: auto; color: var(--ic-text-dim); white-space: nowrap; }
    `,
  ];

  @property({ attribute: false }) apiClient: ApiClient | null = null;
  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  @state() private _controller: SkillsController | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.rpcClient) {
      this._controller = createSkillsController(this, this.rpcClient, this.eventDispatcher);
    }
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("rpcClient") && this.rpcClient && !this._controller) {
      this._controller = createSkillsController(this, this.rpcClient, this.eventDispatcher);
    }
  }

  private _triggerFolderUpload(): void {
    const input = this.shadowRoot?.querySelector<HTMLInputElement>("#skill-folder-input");
    input?.click();
  }

  private _renderToolsTab() {
    return html`
      ${TOOL_CATEGORIES.map((cat) => html`
        <div class="category-header">${cat.label}</div>
        <div class="tool-grid">
          ${cat.tools.map((name) => html`
            <div class="tool-card">
              <div class="tool-card-header">
                <span class="tool-name">${name}</span>
              </div>
              <span class="tool-desc">${TOOL_DESCRIPTIONS[name] ?? ""}</span>
              ${TOOL_PARAM_HINTS[name] ? html`<ul class="tool-params">
                ${TOOL_PARAM_HINTS[name].map((hint) => html`<li>${hint}</li>`)}
              </ul>` : nothing}
            </div>
          `)}
        </div>
      `)}
      <p class="tool-hint">Enable or disable tools per agent in the agent editor.</p>
      <hr style="border: none; border-top: 1px solid var(--ic-border); margin: var(--ic-space-xl) 0;" />
      <div class="section-header" style="font-size: var(--ic-text-base); font-weight: 600; color: var(--ic-text); margin-bottom: var(--ic-space-sm);">Platform Tools</div>
      <p class="tool-hint" style="margin-top: 0;">
        Platform tools are always available to agents. They are governed by the tool policy and trust level.
      </p>
      ${PLATFORM_TOOL_CATEGORIES.map((cat) => html`
        <div class="category-header">${cat.label}</div>
        <div class="tool-grid">
          ${cat.tools.map((name) => html`
            <div class="tool-card">
              <div class="tool-card-header"><span class="tool-name">${name}</span></div>
              <span class="tool-desc">${PLATFORM_TOOL_DESCRIPTIONS[name] ?? ""}</span>
            </div>
          `)}
        </div>
      `)}
      <hr style="border: none; border-top: 1px solid var(--ic-border); margin: var(--ic-space-xl) 0;" />
      <div class="section-header" style="font-size: var(--ic-text-base); font-weight: 600; color: var(--ic-text); margin-bottom: var(--ic-space-sm);">Tool Policy</div>
      <div class="policy-section">
        <p class="tool-hint" style="margin-top: 0;">
          Tool policy controls which platform tools an agent can use. Profiles (minimal, coding, messaging, supervisor, full)
          define baseline sets, with allow/deny lists for fine-grained overrides.
        </p>
        <p class="tool-hint">Configure tool policy per agent in the agent editor.</p>
      </div>
    `;
  }

  private _renderDiscoveredSkills(snap: SkillsViewSnapshot) {
    const ctrl = this._controller;
    const q = snap.searchQuery;
    const filtered = q
      ? snap.discoveredSkills.filter(
          (s) =>
            s.name.toLowerCase().includes(q.toLowerCase()) ||
            s.description.toLowerCase().includes(q.toLowerCase()),
        )
      : snap.discoveredSkills;

    const hasSkills = snap.discoveredSkills.length > 0;
    const allShared = hasSkills ? filtered.filter((s) => s.source === "local") : [];
    const allAgent = hasSkills ? filtered.filter((s) => s.source !== "local") : [];
    const showShared = snap.skillScope === "all" || snap.skillScope === "shared";
    const showAgent = snap.skillScope === "all" || snap.skillScope === "local";
    const shared = showShared ? allShared : [];
    const agent = showAgent ? allAgent : [];
    const nothingToShow = shared.length === 0 && agent.length === 0;

    return html`
      ${!hasSkills || nothingToShow ? html`
        <ic-empty-state
          icon="skills"
          message=${!hasSkills ? "No prompt skills discovered" : "No skills match the current filter"}
          description=${!hasSkills ? "Upload a skill folder or import from GitHub to get started." : "Try changing the scope filter or search query."}
        ></ic-empty-state>
      ` : html`
        ${shared.length > 0 ? html`
          <div class="category-header">Shared Skills (${shared.length})</div>
          <div class="tool-grid">
            ${shared.map((skill) => this._renderSkillCard(skill, "SHARED"))}
          </div>
        ` : nothing}
        ${showAgent ? html`
          <div class="category-header">Agent Skills (${agent.length})</div>
          ${agent.length > 0 ? html`
            <div class="tool-grid">
              ${agent.map((skill) => this._renderSkillCard(skill, agentIdFromLocation(skill.location) || "AGENT"))}
            </div>
          ` : html`
            <p style="font-size: var(--ic-text-sm); color: var(--ic-text-dim); font-style: italic;">
              No agent-specific skills installed. Upload or import skills below.
            </p>
          `}
        ` : nothing}
      `}

      <!-- Add Skill panel -->
      <div class="add-skill-panel">
        <div class="add-skill-title">Add Skill</div>
        <div class="install-target">
          <span class="install-target-label">Install to:</span>
          <select class="install-target-select" .value=${snap.installScope}
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value as "shared" | "agent";
              ctrl?.setInstallScope(v);
              if (v === "agent" && !snap.installAgent) {
                ctrl?.setInstallAgent(snap.agentIds[0] ?? snap.defaultAgentId);
              }
            }}>
            <option value="shared" ?selected=${snap.installScope === "shared"}>Shared (all agents)</option>
            <option value="agent" ?selected=${snap.installScope === "agent"}>Specific agent</option>
          </select>
          ${snap.installScope === "agent" ? html`
            <select class="install-target-select" .value=${snap.installAgent}
              @change=${(e: Event) => ctrl?.setInstallAgent((e.target as HTMLSelectElement).value)}>
              ${snap.agentIds.map((id) => html`<option value=${id} ?selected=${id === snap.installAgent}>${id}</option>`)}
            </select>
          ` : nothing}
          <span class="install-target-hint">
            ${snap.installScope === "shared"
              ? "Skill will be available to all agents"
              : `Skill will only be available to ${snap.installAgent || "the selected agent"}`}
          </span>
        </div>
        <div class="add-skill-methods">
          <div class="add-skill-method">
            <div class="add-skill-method-title">Upload folder</div>
            <div class="add-skill-method-body">
              <input id="skill-folder-input" type="file" webkitdirectory hidden
                @change=${(e: Event) => ctrl?.handleFolderSelected(e.target as HTMLInputElement)} />
              <button class="upload-skill-btn" ?disabled=${snap.isUploadingSkill}
                @click=${() => this._triggerFolderUpload()}>
                ${snap.isUploadingSkill ? "Uploading..." : "+ Select Skill Folder"}
              </button>
            </div>
            <p class="upload-skill-hint">Folder must contain a SKILL.md file</p>
          </div>
          <div class="add-skill-method">
            <div class="add-skill-method-title">Import from GitHub</div>
            <div class="add-skill-method-body">
              <div class="import-skill-row" style="width: 100%;">
                <input type="text" .value=${snap.importUrl}
                  placeholder="https://github.com/owner/repo/tree/main/skills/name"
                  @input=${(e: Event) => ctrl?.setImportUrl((e.target as HTMLInputElement).value)}
                  @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); ctrl?.handleImportSkill(); } }} />
                <button class="import-skill-btn"
                  ?disabled=${snap.isImportingSkill || !snap.importUrl.trim()}
                  @click=${() => ctrl?.handleImportSkill()}>
                  ${snap.isImportingSkill ? "Importing..." : "Import"}
                </button>
              </div>
            </div>
            <p class="upload-skill-hint">Paste a GitHub URL to a skill folder</p>
          </div>
        </div>
      </div>

      <ic-confirm-dialog
        ?open=${snap.deletingSkill !== null}
        title="Delete Skill"
        message=${`Delete skill "${snap.deletingSkill}"? This will remove the skill files from disk.`}
        variant="danger"
        confirmLabel="Delete"
        @confirm=${() => ctrl?.confirmDeleteSkill()}
        @cancel=${() => ctrl?.cancelDeleteSkill()}
      ></ic-confirm-dialog>
    `;
  }

  private _renderSkillCard(skill: DiscoveredSkill, badge: string) {
    const ctrl = this._controller;
    const desc = skill.description.length > 150 ? skill.description.slice(0, 150) + "..." : skill.description;
    return html`
      <div class="tool-card">
        <div class="tool-card-header">
          <span class="tool-name">${skill.name}</span>
          <div style="display: flex; gap: 0.25rem; align-items: center;">
            ${skill.disableModelInvocation ? html`<ic-tag variant="warning">manual</ic-tag>` : nothing}
            <ic-tag variant=${badge === "SHARED" ? "info" : "accent"}>${badge}</ic-tag>
            <button class="skill-delete-btn" aria-label="Delete ${skill.name}"
              @click=${() => ctrl?.handleDeleteSkill(skill.name)}>✕</button>
          </div>
        </div>
        <span class="tool-desc">${desc}</span>
      </div>
    `;
  }

  private _renderSkillsTab(snap: SkillsViewSnapshot) {
    const ctrl = this._controller;
    return html`
      <ic-search-input placeholder="Filter skill names..."
        @search=${(e: CustomEvent<string>) => ctrl?.setSearchQuery(e.detail)}></ic-search-input>
      <div style="margin-top: var(--ic-space-md);">
        ${this._renderDiscoveredSkills(snap)}
      </div>
      <p class="tool-hint">Configure prompt skill settings (max body length, auto-inject, allowed/denied lists) per agent in the agent editor.</p>
    `;
  }

  private _renderRecentActivity(snap: SkillsViewSnapshot) {
    if (snap.recentSkillEvents.length === 0) return nothing;
    return html`
      <div class="recent-activity">
        <h3>Recent Activity <span class="recent-activity-count">(${snap.recentSkillEvents.length})</span></h3>
        <div class="event-list">
          ${snap.recentSkillEvents.slice(0, 20).map((ev) => html`
            <div class="event-entry">
              <span class="event-skill">${ev.skillName}</span>
              <span class="event-agent">${ev.agentId || "—"}</span>
              <span class=${ev.outcome === "executed" ? "event-outcome--executed" : "event-outcome--rejected"}>
                ${ev.outcome}${ev.reason ? html` <span class="event-reason">(${ev.reason})</span>` : ""}
              </span>
              <span class="event-time">${systemDateFrom(ev.timestamp).toLocaleTimeString()}</span>
            </div>
          `)}
        </div>
      </div>
    `;
  }

  private _renderTabContent(snap: SkillsViewSnapshot) {
    switch (snap.activeTab) {
      case "tools": return this._renderToolsTab();
      case "skills": return this._renderSkillsTab(snap);
      default: return nothing;
    }
  }

  override render() {
    if (!this._controller) {
      return html`<ic-skeleton-view variant="list"></ic-skeleton-view>`;
    }
    const snap = this._controller.getSnapshot();
    const ctrl = this._controller;
    if (snap.loadState === "loading") {
      return html`<ic-skeleton-view variant="list"></ic-skeleton-view>`;
    }
    if (snap.loadState === "error") {
      return html`
        <div class="error-container">
          <span class="error-message">${snap.error}</span>
          <button class="retry-btn" @click=${() => ctrl.tryLoad()}>Retry</button>
        </div>
      `;
    }
    return html`
      <div class="view-header">
        <div class="view-title">Skills & Tools</div>
        ${snap.agentIds.length > 1 ? html`
          <div style="display: flex; gap: var(--ic-space-sm); align-items: center;">
            <select class="form-input" .value=${snap.targetAgentId}
              @change=${(e: Event) => ctrl.onAgentChange((e.target as HTMLSelectElement).value)}>
              <option value="" ?selected=${snap.targetAgentId === ""}>All Agents</option>
              ${snap.agentIds.map((id) => html`<option value=${id} ?selected=${id === snap.targetAgentId}>${id}</option>`)}
            </select>
            <select class="form-input" .value=${snap.skillScope}
              @change=${(e: Event) => ctrl.setSkillScope((e.target as HTMLSelectElement).value as "all" | "local" | "shared")}>
              <option value="all" ?selected=${snap.skillScope === "all"}>All Skills</option>
              <option value="local" ?selected=${snap.skillScope === "local"}>Agent Skills</option>
              <option value="shared" ?selected=${snap.skillScope === "shared"}>Shared Skills</option>
            </select>
          </div>
        ` : nothing}
      </div>
      <ic-tabs .tabs=${SKILLS_TABS} .activeTab=${snap.activeTab}
        @tab-change=${(e: CustomEvent<string>) => ctrl.setActiveTab(e.detail)}></ic-tabs>
      <div style="margin-top: var(--ic-space-md);">
        ${this._renderTabContent(snap)}
      </div>
      ${this._renderRecentActivity(snap)}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-skills-view": IcSkillsView;
  }
}

export type { SkillsConfig };
