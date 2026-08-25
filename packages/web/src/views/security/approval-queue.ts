// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { RpcClient } from "../../api/rpc-client.js";
import type { WebRpcMethodMap } from "../../api/contracts.generated.js";
import { listSessionsAcrossAgents } from "../../api/session-scope.js";
import { IcToast } from "../../components/feedback/ic-toast.js";
import type { ApprovalRequest } from "../../components/domain/ic-approval-card.js";
import { systemNowMs } from "@comis/core";

// Side-effect imports for sub-components used in template
import "../../components/data/ic-tag.js";
import "../../components/data/ic-relative-time.js";
import "../../components/feedback/ic-empty-state.js";
import "../../components/domain/ic-approval-card.js";
import "../../components/form/ic-select.js";
import "../../components/form/ic-toggle.js";
import "../../components/form/ic-array-editor.js";

/** Shape of an approval request as returned by the daemon RPC. */
interface BackendApprovalRequest {
  requestId: string;
  toolName: string;
  action: string;
  params: Record<string, unknown>;
  tenantId: string;
  agentId: string;
  conversationRef: string;
  trustLevel: string;
  createdAt: number;
  timeoutMs: number;
}

interface ApprovalAuthority {
  tenantId: string;
  agentId: string;
  conversationRef: string;
}

interface ScopedApprovalRequest extends ApprovalRequest, ApprovalAuthority {}

/** Map backend approval request fields to the frontend ApprovalRequest shape. */
function mapBackendRequest(r: BackendApprovalRequest): ScopedApprovalRequest {
  return {
    id: r.requestId,
    tenantId: r.tenantId,
    agentId: r.agentId,
    conversationRef: r.conversationRef,
    action: r.action || r.toolName,
    classification: r.trustLevel === "admin" ? "low" : r.trustLevel === "user" ? "medium" : "high",
    context: JSON.stringify(r.params, null, 2),
    requestedAt: r.createdAt,
  };
}

/** Resolved approval extends the request with outcome data. */
interface ResolvedApproval extends ApprovalRequest {
  outcome: "approved" | "denied";
  reason: string;
  resolvedAt: number;
  resolvedBy: string;
}

// ---------------------------------------------------------------------------
// localStorage history persistence (TTL-based)
// ---------------------------------------------------------------------------

const HISTORY_STORAGE_KEY = "ic:approval-history";
const HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function loadHistory(): ResolvedApproval[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const entries = JSON.parse(raw) as ResolvedApproval[];
    const cutoff = systemNowMs() - HISTORY_TTL_MS;
    return entries.filter((e) => e.resolvedAt > cutoff);
  } catch {
    return [];
  }
}

function saveHistory(entries: ResolvedApproval[]): void {
  try {
    const cutoff = systemNowMs() - HISTORY_TTL_MS;
    const pruned = entries.filter((e) => e.resolvedAt > cutoff);
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(pruned));
  } catch {
    // Storage full or unavailable -- silently ignore.
  }
}

/** Security config section shape for rules display. */
interface SecurityConfig {
  logRedaction?: boolean;
  auditLog?: boolean;
  permission?: {
    enableNodePermissions?: boolean;
    allowedFsPaths?: string[];
    allowedNetHosts?: string[];
  };
  actionConfirmation?: {
    requireForDestructive?: boolean;
    requireForSensitive?: boolean;
    autoApprove?: string[];
  };
  agentToAgent?: {
    enabled?: boolean;
    maxPingPongTurns?: number;
    allowAgents?: string[];
    subAgentRetentionMs?: number;
    waitTimeoutMs?: number;
    subAgentMaxSteps?: number;
    subAgentToolGroups?: string[];
    subAgentMcpTools?: string;
  };
}

/**
 * The operator's `approvals` policy as loaded from config.
 *
 * Runtime-immutable: the section is edited in the config file and applied on
 * daemon restart, so this view renders it and never offers to write it.
 */
export interface ApprovalsConfig {
  enabled?: boolean;
  defaultMode?: string;
  rules?: Array<{
    actionPattern: string;
    mode?: string;
    timeoutMs?: number;
    minTrustLevel?: string;
  }>;
}

/**
 * Approval handling, rules configuration, and history sub-component.
 * Renders the pending approvals queue, rules configuration tabs,
 * and resolved approval history.
 *
 * @fires approvals-changed - Dispatched after approval resolution
 */
@customElement("ic-approval-queue")
export class IcApprovalQueue extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .section-header {
        font-size: var(--ic-text-base);
        font-weight: 600;
        color: var(--ic-text);
        margin-top: var(--ic-space-lg);
        margin-bottom: var(--ic-space-sm);
      }

      .section-header:first-child {
        margin-top: 0;
      }

      .policy-section {
        margin-bottom: var(--ic-space-xl);
        max-width: 40rem;
      }

      .queue-header {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        margin-bottom: var(--ic-space-md);
      }

      .queue-count {
        background: var(--ic-accent);
        color: white;
        font-size: var(--ic-text-xs);
        font-weight: 600;
        padding: 0.125rem 0.5rem;
        border-radius: var(--ic-radius-md);
        min-width: 1.25rem;
        text-align: center;
      }

      .queue-list {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-md);
      }

      .history-divider {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        margin: var(--ic-space-xl) 0 var(--ic-space-md);
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
        font-weight: 600;
      }

      .history-divider::after {
        content: "";
        flex: 1;
        height: 1px;
        background: var(--ic-border);
      }

      .history-grid {
        display: grid;
        grid-template-columns: 7rem 8rem 6rem 5rem 1fr 8rem 6rem;
        width: 100%;
      }

      .history-grid .header-cell {
        padding: var(--ic-space-xs) var(--ic-space-sm);
        font-size: var(--ic-text-xs);
        font-weight: 600;
        color: var(--ic-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border-bottom: 2px solid var(--ic-border);
        background: var(--ic-surface);
      }

      .history-grid .data-cell {
        padding: var(--ic-space-xs) var(--ic-space-sm);
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        display: flex;
        align-items: center;
        border-bottom: 1px solid var(--ic-border);
        min-height: 2.25rem;
      }

      .history-grid .data-cell--muted {
        color: var(--ic-text-muted);
      }

      .rules-form {
        max-width: 32rem;
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-md);
      }

      .save-btn,
      .action-btn {
        padding: 0.5rem 1rem;
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        font-family: inherit;
        align-self: flex-start;
      }

      .save-btn:hover,
      .action-btn:hover {
        opacity: 0.9;
      }

      .form-field {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
        margin-bottom: var(--ic-space-sm);
      }

      .form-label {
        font-size: var(--ic-text-sm);
        font-weight: 500;
        color: var(--ic-text-muted);
      }

      .form-hint {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      .number-input {
        width: 8rem;
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
      }

      .number-input:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .bulk-actions {
        display: flex;
        flex-direction: row;
        gap: var(--ic-space-sm);
        margin-bottom: var(--ic-space-md);
        flex-wrap: wrap;
      }

      .action-btn--success {
        background: var(--ic-success, #22c55e);
        color: white;
      }

      .action-btn--danger {
        background: var(--ic-error, #ef4444);
        color: white;
      }

      .action-btn:disabled,
      .action-btn--success:disabled,
      .action-btn--danger:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ];

  @property({ attribute: false }) rpc!: RpcClient;
  @property({ attribute: false }) securityConfig: SecurityConfig = {};
  @property({ attribute: false }) approvalsConfig: ApprovalsConfig = {};
  @property({ type: String }) activeSubTab: "rules" | "pending" = "pending";

  @state() private _pendingApprovals: ScopedApprovalRequest[] = [];
  @state() private _resolvedApprovals: ResolvedApproval[] = [];

  override connectedCallback(): void {
    super.connectedCallback();
    this._resolvedApprovals = loadHistory();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("rpc") && this.rpc) {
      void this._loadApprovals();
    }
  }

  private async _loadApprovals(): Promise<void> {
    if (!this.rpc) return;
    try {
      const targets = await listSessionsAcrossAgents(this.rpc);
      const results = await Promise.all(targets.map((target) =>
        this.rpc.call<{ requests: BackendApprovalRequest[]; total: number }>(
          "admin.approval.pending",
          {
            tenant_id: target.tenantId,
            agent_id: target.agentId,
            conversation_ref: target.conversationRef,
          },
        )
      ));
      const requests = new Map<string, ScopedApprovalRequest>();
      for (const result of results) {
        for (const request of result.requests) {
          requests.set(request.requestId, mapBackendRequest(request));
        }
      }
      this._pendingApprovals = [...requests.values()];
    } catch {
      // Silently ignore -- parent handles top-level error state
    }
  }

  /** Called by parent when SSE approval:requested event fires. */
  public onApprovalPending(data: unknown): void {
    const detail = data as BackendApprovalRequest;
    if (!detail?.requestId) return;
    this._pendingApprovals = [mapBackendRequest(detail), ...this._pendingApprovals];
  }

  /** Called by parent when SSE approval:resolved event fires. */
  public onApprovalResolved(data: unknown): void {
    const detail = data as BackendApprovalRequest & { approved: boolean; approvedBy: string; reason?: string; resolvedAt: number };
    const id = detail?.requestId;
    if (!id) return;
    this._pendingApprovals = this._pendingApprovals.filter((a) => a.id !== id);
    const mapped = mapBackendRequest(detail);
    const resolved: ResolvedApproval = {
      ...mapped,
      outcome: detail.approved ? "approved" : "denied",
      reason: detail.reason ?? "",
      resolvedAt: detail.resolvedAt ?? systemNowMs(),
      resolvedBy: detail.approvedBy ?? "system",
    };
    this._resolvedApprovals = [resolved, ...this._resolvedApprovals];
    saveHistory(this._resolvedApprovals);
  }

  private async _handleApprove(e: CustomEvent<{ id: string; reason: string }>): Promise<void> {
    if (!this.rpc) return;
    const { id, reason } = e.detail;
    const request = this._pendingApprovals.find((approval) => approval.id === id);
    if (!request) {
      IcToast.show("Approval request is no longer pending", "error");
      return;
    }
    try {
      await this.rpc.call("admin.approval.resolve", {
        requestId: id,
        tenant_id: request.tenantId,
        agent_id: request.agentId,
        conversation_ref: request.conversationRef,
        approved: true,
        approvedBy: "operator",
        reason,
      });
      this._pendingApprovals = this._pendingApprovals.filter((a) => a.id !== id);
      const resolved: ResolvedApproval = { ...request, outcome: "approved", reason, resolvedAt: systemNowMs(), resolvedBy: "operator" };
      this._resolvedApprovals = [resolved, ...this._resolvedApprovals];
      saveHistory(this._resolvedApprovals);
      IcToast.show("Approval granted", "success");
      this.dispatchEvent(new CustomEvent("approvals-changed", { bubbles: true, composed: true }));
    } catch (err) {
      IcToast.show(err instanceof Error ? err.message : "Failed to approve request", "error");
    }
  }

  private async _handleDeny(e: CustomEvent<{ id: string; reason: string }>): Promise<void> {
    if (!this.rpc) return;
    const { id, reason } = e.detail;
    const request = this._pendingApprovals.find((approval) => approval.id === id);
    if (!request) {
      IcToast.show("Approval request is no longer pending", "error");
      return;
    }
    try {
      await this.rpc.call("admin.approval.resolve", {
        requestId: id,
        tenant_id: request.tenantId,
        agent_id: request.agentId,
        conversation_ref: request.conversationRef,
        approved: false,
        approvedBy: "operator",
        reason,
      });
      this._pendingApprovals = this._pendingApprovals.filter((a) => a.id !== id);
      const resolved: ResolvedApproval = { ...request, outcome: "denied", reason, resolvedAt: systemNowMs(), resolvedBy: "operator" };
      this._resolvedApprovals = [resolved, ...this._resolvedApprovals];
      saveHistory(this._resolvedApprovals);
      IcToast.show("Approval denied", "success");
      this.dispatchEvent(new CustomEvent("approvals-changed", { bubbles: true, composed: true }));
    } catch (err) {
      IcToast.show(err instanceof Error ? err.message : "Failed to deny request", "error");
    }
  }

  private async _handleResolveAll(approved: boolean): Promise<void> {
    if (!this.rpc || this._pendingApprovals.length === 0) return;
    try {
      const pending = this._pendingApprovals;
      const reason = approved ? "Bulk approved by operator" : "Bulk denied by operator";
      const outcomes = await Promise.allSettled(pending.map((request) =>
        this.rpc.call("admin.approval.resolve", {
          requestId: request.id,
          tenant_id: request.tenantId,
          agent_id: request.agentId,
          conversation_ref: request.conversationRef,
          approved,
          approvedBy: "operator",
          reason,
        })
      ));
      const unresolved: ScopedApprovalRequest[] = [];
      let resolvedCount = 0;
      for (const [index, outcome] of outcomes.entries()) {
        const approval = pending[index];
        if (!approval) continue;
        if (outcome.status === "rejected") {
          unresolved.push(approval);
          continue;
        }
        resolvedCount += 1;
        const resolved: ResolvedApproval = {
          ...approval,
          outcome: approved ? "approved" : "denied",
          reason,
          resolvedAt: systemNowMs(),
          resolvedBy: "operator",
        };
        this._resolvedApprovals = [resolved, ...this._resolvedApprovals];
      }
      this._pendingApprovals = unresolved;
      saveHistory(this._resolvedApprovals);
      const failedCount = outcomes.length - resolvedCount;
      IcToast.show(
        failedCount === 0
          ? `${resolvedCount} approval(s) ${approved ? "approved" : "denied"}`
          : `${resolvedCount} approval(s) resolved; ${failedCount} failed`,
        failedCount === 0 ? "success" : "error",
      );
      if (resolvedCount > 0) {
        this.dispatchEvent(new CustomEvent("approvals-changed", { bubbles: true, composed: true }));
      }
    } catch (err) {
      IcToast.show(err instanceof Error ? err.message : "Bulk operation failed", "error");
    }
  }

  private async _handleClearDenialCache(): Promise<void> {
    if (!this.rpc) return;
    try {
      const sessions = await listSessionsAcrossAgents(this.rpc);
      const targets = new Map<string, ApprovalAuthority>();
      for (const target of [...sessions, ...this._pendingApprovals]) {
        targets.set(
          JSON.stringify([target.tenantId, target.agentId, target.conversationRef]),
          target,
        );
      }
      await Promise.all([...targets.values()].map((target) =>
        this.rpc.call("admin.approval.clearDenialCache", {
          tenant_id: target.tenantId,
          agent_id: target.agentId,
          conversation_ref: target.conversationRef,
        })
      ));
      IcToast.show("Denial cache cleared", "success");
    } catch (err) {
      IcToast.show(err instanceof Error ? err.message : "Failed to clear denial cache", "error");
    }
  }

  private async _patchConfig(path: string, value: unknown): Promise<boolean> {
    if (!this.rpc) return false;
    try {
      const dotIdx = path.indexOf(".");
      const section = dotIdx > 0 ? path.slice(0, dotIdx) : path;
      const key = dotIdx > 0 ? path.slice(dotIdx + 1) : undefined;
      await this.rpc.call("config.patch", {
        section,
        key,
        value: value as WebRpcMethodMap["config.patch"]["params"]["value"],
      });
      IcToast.show("Configuration updated", "success");
      return true;
    } catch (err) {
      IcToast.show(err instanceof Error ? err.message : "Failed to update configuration", "error");
      return false;
    }
  }

  private async _onActionConfirmationChange(field: string, value: unknown): Promise<void> {
    const updated = { ...this.securityConfig.actionConfirmation, [field]: value };
    await this._patchConfig("security.actionConfirmation", updated);
  }

  private async _onAgentToAgentEnabledChange(enabled: boolean): Promise<void> {
    const updated = { ...this.securityConfig.agentToAgent, enabled };
    await this._patchConfig("security.agentToAgent", updated);
  }

  private async _onAgentToAgentAllowChange(allowAgents: string[]): Promise<void> {
    const updated = { ...this.securityConfig.agentToAgent, allowAgents };
    await this._patchConfig("security.agentToAgent", updated);
  }

  private async _onPermissionToggleChange(enabled: boolean): Promise<void> {
    const updated = { ...this.securityConfig.permission, enableNodePermissions: enabled };
    await this._patchConfig("security.permission", updated);
  }

  private async _onPermissionPathsChange(field: string, items: string[]): Promise<void> {
    const updated = { ...this.securityConfig.permission, [field]: items };
    await this._patchConfig("security.permission", updated);
  }

  private _renderHistoryRow(resolved: ResolvedApproval) {
    const outcomeVariant = resolved.outcome === "approved" ? "success" : "error";
    const classVariant = { low: "success", medium: "warning", high: "error", critical: "error" }[resolved.classification] ?? "default";
    return html`
      <div class="data-cell" role="cell">${resolved.agentId}</div>
      <div class="data-cell" role="cell">${resolved.action}</div>
      <div class="data-cell" role="cell"><ic-tag variant=${classVariant}>${resolved.classification}</ic-tag></div>
      <div class="data-cell" role="cell"><ic-tag variant=${outcomeVariant}>${resolved.outcome}</ic-tag></div>
      <div class="data-cell data-cell--muted" role="cell">${resolved.reason || "---"}</div>
      <div class="data-cell data-cell--muted" role="cell"><ic-relative-time .timestamp=${resolved.resolvedAt}></ic-relative-time></div>
      <div class="data-cell data-cell--muted" role="cell">${resolved.resolvedBy}</div>
    `;
  }

  private _renderRulesContent() {
    const ac = this.securityConfig.actionConfirmation ?? {};
    const a2a = this.securityConfig.agentToAgent ?? {};
    const perm = this.securityConfig.permission ?? {};
    const approvals = this.approvalsConfig ?? {};
    const rules = approvals.rules ?? [];

    return html`
      <div class="policy-section">
        <div class="section-header">Action Confirmation</div>
        <ic-toggle label="Require for destructive actions"
          .checked=${ac.requireForDestructive ?? true}
          @change=${(e: CustomEvent<boolean>) => this._onActionConfirmationChange("requireForDestructive", e.detail)}
        ></ic-toggle>
        <div style="margin-top: var(--ic-space-sm);">
          <ic-toggle label="Require for sensitive actions"
            .checked=${ac.requireForSensitive ?? false}
            @change=${(e: CustomEvent<boolean>) => this._onActionConfirmationChange("requireForSensitive", e.detail)}
          ></ic-toggle>
        </div>
        <div style="margin-top: var(--ic-space-md);">
          <ic-array-editor label="Auto-approve list" .items=${ac.autoApprove ?? []} placeholder="Action name to auto-approve"
            @change=${(e: CustomEvent<string[]>) => this._onActionConfirmationChange("autoApprove", e.detail)}
          ></ic-array-editor>
        </div>
      </div>

      <div class="policy-section">
        <div class="section-header">Agent-to-Agent Policy</div>
        <ic-toggle label="Enable cross-agent messaging"
          .checked=${a2a.enabled ?? true}
          @change=${(e: CustomEvent<boolean>) => this._onAgentToAgentEnabledChange(e.detail)}
        ></ic-toggle>
        <div style="margin-top: var(--ic-space-md);">
          <ic-array-editor label="Allowed agents" .items=${a2a.allowAgents ?? []} placeholder="Agent ID"
            @change=${(e: CustomEvent<string[]>) => this._onAgentToAgentAllowChange(e.detail)}
          ></ic-array-editor>
        </div>
      </div>

      <div class="policy-section">
        <div class="section-header">Permissions</div>
        <ic-toggle label="Enable Node.js permission model"
          .checked=${perm.enableNodePermissions ?? false}
          @change=${(e: CustomEvent<boolean>) => this._onPermissionToggleChange(e.detail)}
        ></ic-toggle>
        <div style="margin-top: var(--ic-space-md);">
          <ic-array-editor label="Allowed filesystem paths" .items=${perm.allowedFsPaths ?? []} placeholder="/path/to/allow"
            @change=${(e: CustomEvent<string[]>) => this._onPermissionPathsChange("allowedFsPaths", e.detail)}
          ></ic-array-editor>
        </div>
        <div style="margin-top: var(--ic-space-md);">
          <ic-array-editor label="Allowed network hosts" .items=${perm.allowedNetHosts ?? []} placeholder="hostname or IP"
            @change=${(e: CustomEvent<string[]>) => this._onPermissionPathsChange("allowedNetHosts", e.detail)}
          ></ic-array-editor>
        </div>
      </div>

      <div class="policy-section">
        <div class="section-header">Approval Policy</div>
        <div class="rules-form">
          <span class="form-hint">
            Edited in the operator config file under <code>approvals</code> and applied on
            daemon restart. A request reaching the gate is matched against these rules in
            order; the first match decides it, and an unmatched action falls to the default.
          </span>
          <div class="form-field">
            <label class="form-label">Gate</label>
            <span>${approvals.enabled ? "Enabled" : "Disabled"}</span>
          </div>
          <div class="form-field">
            <label class="form-label">Unmatched actions</label>
            <span>${approvals.defaultMode ?? "require"}</span>
          </div>
          ${rules.length === 0
            ? html`<span class="form-hint">No rules configured — every gated action is put to a human.</span>`
            : html`
              <div class="form-field">
                <label class="form-label">Rules</label>
                ${rules.map((rule) => html`
                  <div class="data-cell" role="row">
                    <code>${rule.actionPattern}</code>
                    <ic-tag variant=${rule.mode === "deny" ? "error" : rule.mode === "auto" ? "warning" : "default"}
                      >${rule.mode ?? "auto"}</ic-tag>
                    ${(rule.mode ?? "auto") === "auto"
                      ? html`<span class="form-hint">needs ${rule.minTrustLevel ?? "admin"} trust</span>`
                      : nothing}
                  </div>
                `)}
              </div>
            `}
        </div>
      </div>
    `;
  }

  private _renderPendingContent() {
    const sorted = [...this._pendingApprovals].sort((a, b) => b.requestedAt - a.requestedAt);

    return html`
      <div class="queue-header">
        <span>Pending</span>
        <span class="queue-count">${this._pendingApprovals.length}</span>
      </div>
      <div class="bulk-actions">
        <button class="action-btn action-btn--success" ?disabled=${this._pendingApprovals.length === 0}
          @click=${() => this._handleResolveAll(true)}>Approve All (${this._pendingApprovals.length})</button>
        <button class="action-btn action-btn--danger" ?disabled=${this._pendingApprovals.length === 0}
          @click=${() => this._handleResolveAll(false)}>Deny All (${this._pendingApprovals.length})</button>
        <button class="action-btn" @click=${() => this._handleClearDenialCache()}>Clear Denial Cache</button>
      </div>
      ${sorted.length === 0
        ? html`<ic-empty-state icon="security" message="No pending approvals" description="Approval requests will appear here as they arrive."></ic-empty-state>`
        : html`
            <div class="queue-list">
              ${sorted.map((a) => html`
                <ic-approval-card .approval=${a}
                  @approve=${(e: CustomEvent<{ id: string; reason: string }>) => this._handleApprove(e)}
                  @deny=${(e: CustomEvent<{ id: string; reason: string }>) => this._handleDeny(e)}
                ></ic-approval-card>
              `)}
            </div>
          `}

      <div class="history-divider">Recent History</div>
      ${this._resolvedApprovals.length === 0
        ? html`<p style="font-size: var(--ic-text-sm); color: var(--ic-text-dim); font-style: italic;">No resolved approvals in the last 7 days.</p>`
        : html`
            <div class="history-grid" role="table" aria-label="Resolved approvals">
              <div class="header-cell" role="columnheader">Agent</div>
              <div class="header-cell" role="columnheader">Action</div>
              <div class="header-cell" role="columnheader">Risk</div>
              <div class="header-cell" role="columnheader">Outcome</div>
              <div class="header-cell" role="columnheader">Reason</div>
              <div class="header-cell" role="columnheader">Resolved At</div>
              <div class="header-cell" role="columnheader">Resolved By</div>
              ${this._resolvedApprovals.map((r) => this._renderHistoryRow(r))}
            </div>
          `}
    `;
  }

  override render() {
    if (this.activeSubTab === "rules") {
      return this._renderRulesContent();
    }
    return this._renderPendingContent();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-approval-queue": IcApprovalQueue;
  }
}
