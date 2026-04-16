import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { ApiClient } from "../api/api-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { SseController } from "../state/sse-controller.js";
import { IcToast } from "../components/feedback/ic-toast.js";
import type { SecurityEvent, InputSecurityGuardSummary, ProviderHealthCard, FailoverEvent, AuthCooldownEntry } from "../api/types/security-types.js";

// Side-effect imports for sub-components
import "../components/nav/ic-tabs.js";
import "../components/feedback/ic-loading.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/feedback/ic-empty-state.js";
import "../components/data/ic-tag.js";
import "../components/data/ic-relative-time.js";
import "../components/data/ic-progress-bar.js";
import "../components/display/ic-connection-dot.js";
import "../components/form/ic-toggle.js";
import "../components/form/ic-secret-input.js";

// Sub-component imports
import "./security/token-manager.js";
import "./security/approval-queue.js";
import "./security/event-feed.js";

import type { IcSecurityEventFeed } from "./security/event-feed.js";
import type { IcApprovalQueue } from "./security/approval-queue.js";

type LoadState = "loading" | "loaded" | "error";

/** Maximum number of security events to retain in the feed. */
const MAX_SECURITY_EVENTS = 200;

/** Maximum number of failover events to retain. */
const MAX_FAILOVER_ENTRIES = 100;

/** Tab definitions for the security view. */
const TABS = [
  { id: "events", label: "Security Events" },
  { id: "audit", label: "Audit Log" },
  { id: "tokens", label: "API Tokens" },
  { id: "secrets", label: "Secrets" },
  { id: "rules", label: "Approval Rules" },
  { id: "pending", label: "Pending Approvals" },
  { id: "health", label: "Provider Health" },
];

/** Security config section shape (matches SecurityConfigSchema). */
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
  secrets?: {
    enabled?: boolean;
    dbPath?: string;
  };
  approvalRules?: {
    defaultMode: string;
    timeoutMs: number;
  };
}

/**
 * Security management coordinator view with 7 tabs.
 * Delegates token management, approval queue, and event/audit feeds
 * to focused sub-components. Keeps secrets tab, health tab, SSE wiring,
 * and tab routing in the coordinator.
 */
@customElement("ic-security-view")
export class IcSecurityView extends LitElement {
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

      .tab-content {
        margin-top: var(--ic-space-md);
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

      /* Secrets tab styles */
      .policy-section {
        margin-bottom: var(--ic-space-xl);
        max-width: 40rem;
      }

      .tls-row {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        font-size: var(--ic-text-sm);
      }

      .tls-label {
        font-weight: 500;
        color: var(--ic-text-muted);
        min-width: 6rem;
      }

      .tls-value {
        font-family: ui-monospace, monospace;
        color: var(--ic-text);
        font-size: var(--ic-text-xs);
      }

      /* Provider Health tab */
      .health-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: var(--ic-space-md);
      }

      @media (min-width: 768px) {
        .health-grid {
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        }
      }

      .health-card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
      }

      .health-card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--ic-space-sm);
      }

      .health-card-header strong {
        font-size: var(--ic-text-sm);
      }

      .health-card-stat {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        margin-top: var(--ic-space-xs);
      }

      .failover-log {
        max-height: 300px;
        overflow-y: auto;
        margin-top: var(--ic-space-md);
      }

      .failover-entry {
        display: flex;
        flex-direction: row;
        gap: var(--ic-space-sm);
        padding: var(--ic-space-sm);
        border-bottom: 1px solid var(--ic-border);
        font-size: var(--ic-text-sm);
        align-items: center;
        flex-wrap: wrap;
      }

      .cooldown-list {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm);
        margin-top: var(--ic-space-md);
      }

      .cooldown-entry {
        display: flex;
        gap: var(--ic-space-sm);
        align-items: center;
        font-size: var(--ic-text-sm);
      }
    `,
  ];

  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property({ attribute: false }) apiClient: ApiClient | null = null;
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  private _sse: SseController | null = null;

  @state() private _loadState: LoadState = "loading";
  @state() private _error = "";
  @state() private _activeTab = "events";

  // Security events feed state (pushed to event-feed sub-component)
  @state() private _securityEvents: SecurityEvent[] = [];
  @state() private _inputGuardSummary: InputSecurityGuardSummary = { blockedAttempts: 0, patternsTriggered: [], period: "session" };

  // Config data
  @state() private _securityConfig: SecurityConfig = {};

  // Provider health state
  @state() private _providerHealth: ProviderHealthCard[] = [];
  @state() private _failoverLog: FailoverEvent[] = [];
  @state() private _authCooldowns: AuthCooldownEntry[] = [];

  private _healthReloadDebounce: ReturnType<typeof setTimeout> | null = null;

  private _scheduleHealthReload(delayMs = 300): void {
    if (this._healthReloadDebounce !== null) clearTimeout(this._healthReloadDebounce);
    this._healthReloadDebounce = setTimeout(() => {
      this._healthReloadDebounce = null;
      void this._loadProviderHealth();
    }, delayMs);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._initSse();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._healthReloadDebounce !== null) {
      clearTimeout(this._healthReloadDebounce);
      this._healthReloadDebounce = null;
    }
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("rpcClient") && this.rpcClient) {
      this._loadData();
    }
    if (changed.has("eventDispatcher") && this.eventDispatcher && !this._sse) {
      this._initSse();
    }
  }

  /** Get the event-feed sub-component from shadow DOM. */
  private get _eventFeed(): IcSecurityEventFeed | null {
    return this.shadowRoot?.querySelector("ic-security-event-feed") ?? null;
  }

  /** Get the approval-queue sub-component from shadow DOM. */
  private get _approvalQueue(): IcApprovalQueue | null {
    return this.shadowRoot?.querySelector("ic-approval-queue") ?? null;
  }

  private _initSse(): void {
    if (!this.eventDispatcher || this._sse) return;
    this._sse = new SseController(this, this.eventDispatcher, {
      "audit:event": (data) => {
        // Forward to event-feed sub-component
        this._eventFeed?.onAuditEvent(data);
        // Classify output guard events as SecurityEvent
        const auditData = data as Record<string, unknown>;
        if (auditData.actionType === "output_guard") {
          const meta = (auditData.metadata ?? {}) as Record<string, unknown>;
          const action = meta.action as string | undefined;
          const severity: SecurityEvent["severity"] = action === "redacted" ? "high" : "medium";
          const findingCount = (meta.findingCount as number) ?? 0;
          const evt: SecurityEvent = {
            id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: "output_guard",
            severity,
            message: `Output guard ${action ?? "scan"}: ${findingCount} finding(s)`,
            details: {
              findingTypes: meta.findingTypes,
              severities: meta.severities,
              action: meta.action,
              context: meta.context,
            },
            timestamp: (auditData.timestamp as number) ?? Date.now(),
            agentId: auditData.agentId as string | undefined,
          };
          this._securityEvents = [evt, ...this._securityEvents].slice(0, MAX_SECURITY_EVENTS);
        }
      },
      "approval:requested": (data) => { this._approvalQueue?.onApprovalPending(data); },
      "approval:resolved": (data) => { this._approvalQueue?.onApprovalResolved(data); },
      "security:injection_detected": (data) => {
        const d = data as Record<string, unknown>;
        const riskLevel = (d.riskLevel as string) ?? "medium";
        const severityMap: Record<string, SecurityEvent["severity"]> = { high: "high", medium: "medium", low: "low" };
        const severity = severityMap[riskLevel] ?? "medium";
        const source = (d.source as string) ?? "unknown";
        const patterns = (d.patterns as string[]) ?? [];
        const evt: SecurityEvent = {
          id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: "injection",
          severity,
          message: `Injection detected from ${source}`,
          details: { patterns, source, sessionKey: d.sessionKey },
          timestamp: Date.now(),
          agentId: d.agentId as string | undefined,
        };
        this._securityEvents = [evt, ...this._securityEvents].slice(0, MAX_SECURITY_EVENTS);
        const mergedPatterns = [...new Set([...this._inputGuardSummary.patternsTriggered, ...patterns])];
        this._inputGuardSummary = {
          ...this._inputGuardSummary,
          blockedAttempts: this._inputGuardSummary.blockedAttempts + 1,
          patternsTriggered: mergedPatterns,
        };
      },
      "security:injection_rate_exceeded": (data) => {
        const d = data as Record<string, unknown>;
        const count = d.count as number ?? 0;
        const threshold = d.threshold as number ?? 0;
        const action = (d.action as string) ?? "block";
        const evt: SecurityEvent = {
          id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: "input_guard",
          severity: "critical",
          message: `Rate limit exceeded: ${count}/${threshold} (action: ${action})`,
          details: { sessionKey: d.sessionKey, count, threshold, action },
          timestamp: Date.now(),
        };
        this._securityEvents = [evt, ...this._securityEvents].slice(0, MAX_SECURITY_EVENTS);
      },
      "security:memory_tainted": (data) => {
        const d = data as Record<string, unknown>;
        const blocked = d.blocked as boolean ?? false;
        const originalTrustLevel = (d.originalTrustLevel as string) ?? "unknown";
        const adjustedTrustLevel = (d.adjustedTrustLevel as string) ?? "unknown";
        const evt: SecurityEvent = {
          id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: "memory_tainted",
          severity: blocked ? "high" : "medium",
          message: `Memory tainted for ${d.agentId ?? "unknown"}: ${originalTrustLevel} -> ${adjustedTrustLevel}`,
          details: { patterns: d.patterns, blocked, originalTrustLevel, adjustedTrustLevel },
          timestamp: Date.now(),
          agentId: d.agentId as string | undefined,
        };
        this._securityEvents = [evt, ...this._securityEvents].slice(0, MAX_SECURITY_EVENTS);
      },
      "security:warn": (data) => {
        const d = data as Record<string, unknown>;
        const evt: SecurityEvent = {
          id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: "warn",
          severity: "medium",
          message: (d.message as string) ?? "Security warning",
          details: { category: d.category },
          timestamp: Date.now(),
          agentId: d.agentId as string | undefined,
        };
        this._securityEvents = [evt, ...this._securityEvents].slice(0, MAX_SECURITY_EVENTS);
      },
      "secret:accessed": (data) => {
        const d = data as Record<string, unknown>;
        const outcome = (d.outcome as string) ?? "unknown";
        const severityMap: Record<string, SecurityEvent["severity"]> = { denied: "high", not_found: "medium", success: "low" };
        const severity = severityMap[outcome] ?? "medium";
        const secretName = (d.secretName as string) ?? "unknown";
        const evt: SecurityEvent = {
          id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: "secret_access",
          severity,
          message: `Secret '${secretName}' ${outcome} by ${d.agentId ?? "unknown"}`,
          details: { secretName, outcome },
          timestamp: Date.now(),
          agentId: d.agentId as string | undefined,
        };
        this._securityEvents = [evt, ...this._securityEvents].slice(0, MAX_SECURITY_EVENTS);
      },
      "secret:modified": (data) => {
        const d = data as Record<string, unknown>;
        const secretName = (d.secretName as string) ?? "unknown";
        const action = (d.action as string) ?? "modified";
        const evt: SecurityEvent = {
          id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: "secret_access",
          severity: "medium",
          message: `Secret '${secretName}' ${action}`,
          details: { secretName, action },
          timestamp: Date.now(),
        };
        this._securityEvents = [evt, ...this._securityEvents].slice(0, MAX_SECURITY_EVENTS);
      },
      "provider:degraded": (data) => {
        const d = data as Record<string, unknown>;
        const provider = (d.provider as string) ?? "";
        this._providerHealth = this._providerHealth.map((card) =>
          card.providerId === provider ? { ...card, status: "degraded" as const } : card,
        );
        this._scheduleHealthReload();
      },
      "provider:recovered": (data) => {
        const d = data as Record<string, unknown>;
        const provider = (d.provider as string) ?? "";
        this._providerHealth = this._providerHealth.map((card) =>
          card.providerId === provider ? { ...card, status: "healthy" as const } : card,
        );
        this._scheduleHealthReload();
      },
      "model:auth_cooldown": (data) => {
        const d = data as { keyName: string; provider: string; cooldownMs: number; failureCount: number; timestamp: number };
        const entry: AuthCooldownEntry = {
          keyName: d.keyName,
          provider: d.provider,
          cooldownMs: d.cooldownMs,
          failureCount: d.failureCount,
          timestamp: d.timestamp,
        };
        this._authCooldowns = [entry, ...this._authCooldowns].slice(0, 50);
        this._scheduleHealthReload(500);
      },
      "model:fallback_attempt": (data) => {
        const d = data as { fromProvider: string; fromModel: string; toProvider: string; toModel: string; error: string; attemptNumber: number; timestamp: number };
        const entry: FailoverEvent = {
          fromProvider: d.fromProvider,
          fromModel: d.fromModel,
          toProvider: d.toProvider,
          toModel: d.toModel,
          error: d.error,
          attemptNumber: d.attemptNumber,
          timestamp: d.timestamp,
        };
        this._failoverLog = [entry, ...this._failoverLog].slice(0, MAX_FAILOVER_ENTRIES);
        this._scheduleHealthReload();
      },
      "model:fallback_exhausted": (data) => {
        const d = data as { provider: string; model: string; totalAttempts: number; timestamp: number };
        const entry: FailoverEvent = {
          provider: d.provider,
          model: d.model,
          totalAttempts: d.totalAttempts,
          timestamp: d.timestamp,
          exhausted: true,
        };
        this._failoverLog = [entry, ...this._failoverLog].slice(0, MAX_FAILOVER_ENTRIES);
        this._scheduleHealthReload();
      },
      "observability:token_usage": () => {
        this._scheduleHealthReload(500);
      },
    });
  }

  // --- Data loading ---

  private async _loadProviderHealth(): Promise<void> {
    if (!this.rpcClient) return;
    try {
      const result = await this.rpcClient.call<{
        providers: Array<{ provider: string; model: string; callCount: number; totalCost: number; totalCacheSaved: number; cacheHitRate: number }>;
        totalCacheSaved: number;
      }>("agent.cacheStats");

      const now = Date.now();
      const fiveMinAgo = now - 5 * 60 * 1000;

      const cards: ProviderHealthCard[] = (result.providers ?? []).map((entry) => {
        const failovers = this._failoverLog.filter(
          (f) => f.fromProvider === entry.provider || f.provider === entry.provider,
        );
        const lastFailover = failovers.length > 0
          ? Math.max(...failovers.map((f) => f.timestamp))
          : undefined;

        let status: ProviderHealthCard["status"] = "healthy";
        const activeCooldown = this._authCooldowns.find(
          (c) => c.provider === entry.provider && c.timestamp + c.cooldownMs > now,
        );
        if (activeCooldown) {
          status = "degraded";
        }
        const exhausted = this._failoverLog.find(
          (f) => f.exhausted === true && f.provider === entry.provider && f.timestamp > fiveMinAgo,
        );
        if (exhausted) {
          status = "down";
        }

        return {
          providerId: entry.provider,
          name: entry.provider,
          status,
          cacheHitRate: entry.cacheHitRate,
          failoverCount: failovers.length,
          lastFailover,
          authCooldownUntil: activeCooldown ? activeCooldown.timestamp + activeCooldown.cooldownMs : undefined,
        };
      });
      this._providerHealth = cards;
    } catch {
      // Silently ignore -- provider health is supplementary
    }
  }

  private async _loadData(): Promise<void> {
    if (!this.rpcClient) return;

    this._loadState = "loading";
    this._error = "";

    try {
      const configResult = await this.rpcClient.call<{
        config: { security?: SecurityConfig };
        sections: string[];
      }>("config.read");

      this._securityConfig = configResult.config.security ?? {};
      this._loadState = "loaded";

      void this._loadProviderHealth();
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to load security configuration";
      this._loadState = "error";
    }
  }

  private async _patchConfig(path: string, value: unknown): Promise<boolean> {
    if (!this.rpcClient) return false;
    try {
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

  // --- Secrets tab (kept in coordinator -- small, tightly coupled) ---

  private async _onSecretsEnabledChange(enabled: boolean): Promise<void> {
    const updated = { ...this._securityConfig.secrets, enabled };
    const ok = await this._patchConfig("security.secrets", updated);
    if (ok) {
      this._securityConfig = { ...this._securityConfig, secrets: updated };
    }
  }

  private _renderSecretsTab() {
    const secrets = this._securityConfig.secrets ?? {};
    return html`
      <div class="policy-section">
        <div class="section-header">Encrypted Secrets Store</div>
        <ic-toggle
          label="Enabled"
          .checked=${secrets.enabled ?? false}
          @change=${(e: CustomEvent<boolean>) => this._onSecretsEnabledChange(e.detail)}
        ></ic-toggle>
        <div style="margin-top: var(--ic-space-md);">
          <div class="tls-row">
            <span class="tls-label">DB Path</span>
            <span class="tls-value">${secrets.dbPath ?? "secrets.db"}</span>
          </div>
        </div>
      </div>
    `;
  }

  // --- Provider Health tab (kept in coordinator -- tightly coupled to SSE state) ---

  private _statusToDotStatus(status: ProviderHealthCard["status"]): string {
    switch (status) {
      case "healthy":
        return "connected";
      case "degraded":
        return "reconnecting";
      case "down":
        return "disconnected";
      default:
        return "disconnected";
    }
  }

  private _renderHealthTab() {
    const now = Date.now();
    const activeCooldowns = this._authCooldowns.filter((c) => c.timestamp + c.cooldownMs > now);

    return html`
      <div class="section-header">Provider Status</div>
      ${this._providerHealth.length === 0
        ? html`<ic-empty-state icon="cloud" message="No provider data" description="Provider health data will appear after LLM calls are made."></ic-empty-state>`
        : html`
            <div class="health-grid">
              ${this._providerHealth.map(
                (card) => html`
                  <div class="health-card">
                    <div class="health-card-header">
                      <strong>${card.name}</strong>
                      <ic-connection-dot
                        status=${this._statusToDotStatus(card.status)}
                        size="8px"
                      ></ic-connection-dot>
                    </div>
                    <ic-progress-bar
                      .value=${Math.round(card.cacheHitRate * 100)}
                      label="Cache Hit Rate"
                      .thresholds=${{ green: 101, yellow: 102 }}
                    ></ic-progress-bar>
                    <div class="health-card-stat">
                      Failovers: ${card.failoverCount}
                      ${card.lastFailover
                        ? html` &mdash; last <ic-relative-time .timestamp=${card.lastFailover}></ic-relative-time>`
                        : nothing}
                    </div>
                    ${card.authCooldownUntil && card.authCooldownUntil > now
                      ? html`
                          <div class="health-card-stat">
                            <ic-tag variant="warning">Auth cooldown</ic-tag>
                            ${Math.ceil((card.authCooldownUntil - now) / 1000)}s remaining
                          </div>
                        `
                      : nothing}
                  </div>
                `,
              )}
            </div>
          `}

      <div class="section-header" style="margin-top: var(--ic-space-xl);">Failover Event Log</div>
      ${this._failoverLog.length === 0
        ? html`<p style="font-size: var(--ic-text-sm); color: var(--ic-text-dim); font-style: italic;">No failover events recorded</p>`
        : html`
            <div class="failover-log">
              ${this._failoverLog.map(
                (f) => html`
                  <div class="failover-entry">
                    <ic-relative-time .timestamp=${f.timestamp}></ic-relative-time>
                    ${f.exhausted
                      ? html`
                          <span>${f.provider ?? "unknown"} exhausted after ${f.totalAttempts ?? "?"} attempts</span>
                          <ic-tag variant="error">EXHAUSTED</ic-tag>
                        `
                      : html`
                          <span>${f.fromProvider ?? "?"}/${f.fromModel ?? "?"} &rarr; ${f.toProvider ?? "?"}/${f.toModel ?? "?"}</span>
                          ${f.attemptNumber != null ? html`<ic-tag variant="info">#${f.attemptNumber}</ic-tag>` : nothing}
                          ${f.error ? html`<span style="color: var(--ic-text-dim);">${f.error}</span>` : nothing}
                        `}
                  </div>
                `,
              )}
            </div>
          `}

      <div class="section-header" style="margin-top: var(--ic-space-xl);">Auth Cooldowns</div>
      ${activeCooldowns.length === 0
        ? html`<p style="font-size: var(--ic-text-sm); color: var(--ic-text-dim); font-style: italic;">No active cooldowns</p>`
        : html`
            <div class="cooldown-list">
              ${activeCooldowns.map(
                (c) => html`
                  <div class="cooldown-entry">
                    <ic-tag variant="warning">${c.provider}</ic-tag>
                    <span>${c.keyName}</span>
                    <span style="color: var(--ic-text-dim);">${c.failureCount} failures</span>
                    <span>${Math.ceil((c.timestamp + c.cooldownMs - now) / 1000)}s remaining</span>
                  </div>
                `,
              )}
            </div>
          `}
    `;
  }

  // --- Main render ---

  private _renderTabContent() {
    switch (this._activeTab) {
      case "events":
        return html`<ic-security-event-feed
          activeSubTab="events"
          .securityEvents=${this._securityEvents}
          .inputGuardSummary=${this._inputGuardSummary}
        ></ic-security-event-feed>`;
      case "audit":
        return html`<ic-security-event-feed
          activeSubTab="audit"
          .securityEvents=${this._securityEvents}
          .inputGuardSummary=${this._inputGuardSummary}
        ></ic-security-event-feed>`;
      case "tokens":
        return html`<ic-token-manager .rpc=${this.rpcClient}></ic-token-manager>`;
      case "secrets":
        return this._renderSecretsTab();
      case "rules":
        return html`<ic-approval-queue
          activeSubTab="rules"
          .rpc=${this.rpcClient}
          .securityConfig=${this._securityConfig}
        ></ic-approval-queue>`;
      case "pending":
        return html`<ic-approval-queue
          activeSubTab="pending"
          .rpc=${this.rpcClient}
          .securityConfig=${this._securityConfig}
        ></ic-approval-queue>`;
      case "health":
        return this._renderHealthTab();
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
        <div class="view-title">Security</div>
      </div>
      <ic-tabs
        .tabs=${TABS}
        .activeTab=${this._activeTab}
        @tab-change=${(e: CustomEvent<string>) => { this._activeTab = e.detail; }}
      ></ic-tabs>
      <div class="tab-content">
        ${this._renderTabContent()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-security-view": IcSecurityView;
  }
}
