// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { RpcClient } from "../../api/rpc-client.js";
import type { AgentDetail } from "../../api/types/index.js";
import { IcToast } from "../../components/feedback/ic-toast.js";
import { toYaml } from "../../utils/to-yaml.js";
import { createDirtyTracker } from "../../utils/dirty-state.js";
import "../../components/nav/ic-breadcrumb.js";
import "../../components/feedback/ic-toast.js";
import "../../components/feedback/ic-loading.js";
import "../../components/data/ic-tag.js";

// Side-effect imports to register sub-editor custom elements
import "./editors/agent-essential-editor.js";
import "./editors/agent-budget-editor.js";
import "./editors/agent-session-editor.js";
import "./editors/agent-skills-editor.js";
import "./editors/agent-heartbeat-editor.js";
import "./editors/agent-advanced-editor.js";
import "./editors/agent-context-engine-editor.js";
import "./editors/agent-streaming-editor.js";
import "./editors/agent-delivery-editor.js";
import "./editors/agent-queue-editor.js";
import "./editors/agent-auto-reply-editor.js";
import "./editors/agent-send-policy-editor.js";
import "./editors/agent-log-level-editor.js";

import { BUILTIN_TOOLS } from "./editors/editor-types.js";
import type { CatalogProvider, FieldChangeDetail } from "./editors/editor-types.js";
import type { LogLevelChangeDetail } from "./editors/agent-log-level-editor.js";

/** Default form state for a new agent. */
function createDefaultForm(): Record<string, unknown> {
  return {
    id: "",
    name: "",
    model: "",
    provider: "anthropic",
    maxSteps: 25,
    temperature: undefined,
    thinkingLevel: "medium",
    maxTokens: undefined,
    cacheRetention: undefined,
    maxContextChars: undefined,
    // Budgets
    "budgets.perExecution": undefined,
    "budgets.perHour": undefined,
    "budgets.perDay": undefined,
    // Session policy
    "session.resetMode": "daily",
    "session.dailyResetHour": 0,
    "session.timezone": "UTC",
    "session.idleTimeoutMs": undefined,
    // Skills
    "skills.discoveryPaths": "",
    "skills.toolPolicyProfile": "full",
    "skills.allowList": "",
    "skills.denyList": "",
    // Heartbeat
    "heartbeat.enabled": undefined,
    "heartbeat.intervalMs": undefined,
    "heartbeat.target.channelType": "",
    "heartbeat.target.channelId": "",
    "heartbeat.prompt": "",
    "heartbeat.showOk": undefined,
    "heartbeat.showAlerts": undefined,
    // Advanced
    "advanced.maxSteps": undefined,
    "advanced.cacheRetention": undefined,
    "advanced.maxContextChars": undefined,
    "advanced.rag.enabled": false,
    "advanced.rag.maxResults": 10,
    "advanced.rag.minScore": 0.5,
    "advanced.concurrency.maxConcurrent": 5,
    "advanced.concurrency.maxQueued": 10,
    // Circuit breaker
    "circuitBreaker.threshold": 5,
    "circuitBreaker.resetTimeoutMs": 60000,
    // Safety
    "safety.contextGuard.enabled": true,
    "safety.contextGuard.warnPct": 80,
    "safety.contextGuard.blockPct": 95,
    "safety.sdkRetry.enabled": true,
    "safety.sdkRetry.maxRetries": 3,
    "safety.sdkRetry.baseDelayMs": 2000,
    // Model failover
    "failover.fallbackModels": "",
    "failover.authProfiles": "",
    "failover.allowedModels": "",
    "failover.maxAttempts": 6,
    "failover.cooldownMs": 60000,
    // RAG trust levels
    "rag.trustLevels.system": true,
    "rag.trustLevels.learned": true,
    "rag.trustLevels.external": false,
    // Broadcast
    "broadcast.groups": "[]",
    // Additional heartbeat fields
    "heartbeat.target.chatId": "",
    "heartbeat.target.isDm": undefined,
    "heartbeat.model": "",
    "heartbeat.session": "",
    "heartbeat.allowDm": undefined,
    "heartbeat.lightContext": undefined,
    "heartbeat.ackMaxChars": undefined,
    "heartbeat.responsePrefix": "",
    "heartbeat.skipHeartbeatOnlyDelivery": undefined,
    "heartbeat.alertThreshold": undefined,
    "heartbeat.alertCooldownMs": undefined,
    "heartbeat.staleMs": undefined,
    // Advanced fields
    "advanced.elevatedReply.enabled": false,
    "advanced.elevatedReply.recipients": "",
    "advanced.tracing.enabled": false,
    "advanced.tracing.outputDir": "",
    "advanced.workspacePath": "",
    "advanced.bootstrap": "",
    "advanced.modelRoutes": "",
    "advanced.secretsAccess": "",
    // Session additional
    "session.overrides.dm": "",
    "session.overrides.group": "",
    "session.overrides.thread": "",
    "session.dmScopeMode": "",
    "session.pruning.enabled": false,
    "session.pruning.maxEntries": 100,
    "session.compaction.enabled": false,
    "session.compaction.threshold": 50,
    // Context Engine
    "contextEngine.enabled": true,
    "contextEngine.version": "pipeline",
    "contextEngine.thinkingKeepTurns": undefined,
    "contextEngine.compactionModel": "",
    "contextEngine.evictionMinAge": undefined,
    // Pipeline-mode fields
    "contextEngine.historyTurns": undefined,
    "contextEngine.observationKeepWindow": undefined,
    "contextEngine.observationTriggerChars": undefined,
    "contextEngine.observationDeactivationChars": undefined,
    "contextEngine.compactionCooldownTurns": undefined,
    "contextEngine.historyTurnOverrides": "",
    // DAG-mode fields
    "contextEngine.freshTailTurns": undefined,
    "contextEngine.contextThreshold": undefined,
    "contextEngine.leafMinFanout": undefined,
    "contextEngine.condensedMinFanout": undefined,
    "contextEngine.condensedMinFanoutHard": undefined,
    "contextEngine.incrementalMaxDepth": undefined,
    "contextEngine.leafChunkTokens": undefined,
    "contextEngine.leafTargetTokens": undefined,
    "contextEngine.condensedTargetTokens": undefined,
    "contextEngine.maxExpandTokens": undefined,
    "contextEngine.maxRecallsPerDay": undefined,
    "contextEngine.recallTimeoutMs": undefined,
    "contextEngine.largeFileTokenThreshold": undefined,
    "contextEngine.annotationKeepWindow": undefined,
    "contextEngine.annotationTriggerChars": undefined,
    "contextEngine.summaryModel": "",
    "contextEngine.summaryProvider": "",
  };
}

/**
 * Agent editor view with accordion layout, live YAML preview, and sticky save bar.
 *
 * Wizard + accordion sections (Essential always visible, expandable sections).
 * Live YAML preview panel updates as form fields change.
 * Sticky Validate + Save bar at bottom.
 *
 * @fires navigate - CustomEvent<string> with route to navigate to
 */
@customElement("ic-agent-editor")
export class IcAgentEditor extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--ic-space-lg);
        flex-wrap: wrap;
        gap: var(--ic-space-sm);
      }

      .header-left {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
      }

      .title {
        font-size: 1.5rem;
        font-weight: 700;
        margin: 0;
      }

      /* Two-panel layout */
      .editor-layout {
        display: grid;
        grid-template-columns: 3fr 2fr;
        gap: var(--ic-space-lg);
        margin-bottom: 4rem; /* Space for sticky bar */
      }

      .form-panel {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-md);
      }

      .yaml-panel {
        position: sticky;
        top: var(--ic-space-md);
        align-self: start;
      }

      .yaml-header {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: var(--ic-space-sm);
      }

      .yaml-preview {
        background: var(--ic-bg, #0d1117);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
        font-family: var(--ic-font-mono, monospace);
        font-size: var(--ic-text-xs);
        color: var(--ic-text);
        white-space: pre-wrap;
        word-break: break-word;
        overflow-y: auto;
        max-height: 80vh;
        line-height: 1.5;
      }

      /* Accordion sections */
      .section-card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        overflow: hidden;
      }

      .section-card details {
        border: none;
      }

      .section-card details summary {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        padding: var(--ic-space-md) var(--ic-space-lg);
        font-size: var(--ic-text-sm);
        font-weight: 600;
        cursor: pointer;
        user-select: none;
        transition: background var(--ic-transition);
        list-style: none;
      }

      .section-card details summary::-webkit-details-marker {
        display: none;
      }

      .section-card details summary::before {
        content: "";
        display: inline-block;
        width: 0;
        height: 0;
        border-left: 5px solid var(--ic-text-dim);
        border-top: 4px solid transparent;
        border-bottom: 4px solid transparent;
        transition: transform var(--ic-transition);
        flex-shrink: 0;
      }

      .section-card details[open] summary::before {
        transform: rotate(90deg);
      }

      .section-card details summary:hover {
        background: var(--ic-surface-2);
      }

      .section-content {
        padding: 0 var(--ic-space-lg) var(--ic-space-lg);
      }

      .section-label {
        font-size: var(--ic-text-sm);
        font-weight: 600;
      }

      /* Essential section (no toggle) */
      .essential-header {
        padding: var(--ic-space-md) var(--ic-space-lg);
        font-size: var(--ic-text-sm);
        font-weight: 600;
        border-bottom: 1px solid var(--ic-border);
      }

      .essential-content {
        padding: var(--ic-space-lg);
      }

      /* Sticky save bar */
      .save-bar {
        position: sticky;
        bottom: 0;
        z-index: 10;
        background: var(--ic-surface);
        border-top: 1px solid var(--ic-border);
        padding: var(--ic-space-md) var(--ic-space-lg);
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin: 0 calc(-1 * var(--ic-space-lg, 1.5rem));
        padding-left: var(--ic-space-lg, 1.5rem);
        padding-right: var(--ic-space-lg, 1.5rem);
      }

      .save-bar-left {
        display: flex;
        gap: var(--ic-space-sm);
        align-items: center;
      }

      .save-bar-right {
        display: flex;
        gap: var(--ic-space-sm);
        align-items: center;
      }

      .btn {
        padding: var(--ic-space-sm) var(--ic-space-lg);
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        border: 1px solid var(--ic-border);
        transition: background var(--ic-transition), border-color var(--ic-transition);
      }

      .btn--cancel {
        background: transparent;
        color: var(--ic-text);
      }

      .btn--cancel:hover {
        background: var(--ic-surface-2);
      }

      .btn--secondary {
        background: transparent;
        color: var(--ic-text);
        border-color: var(--ic-border);
      }

      .btn--secondary:hover {
        background: var(--ic-surface-2);
        border-color: var(--ic-accent);
      }

      .btn--primary {
        background: var(--ic-accent);
        color: #fff;
        border-color: var(--ic-accent);
      }

      .btn--primary:hover {
        background: var(--ic-accent-hover);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .error-bar {
        background: color-mix(in srgb, var(--ic-error) 15%, transparent);
        border: 1px solid var(--ic-error);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm) var(--ic-space-md);
        color: var(--ic-error);
        font-size: var(--ic-text-sm);
        margin-bottom: var(--ic-space-md);
      }

      .validation-errors {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
      }

      .validation-error {
        color: var(--ic-error);
        font-size: var(--ic-text-xs);
      }

      .validation-success {
        color: var(--ic-success, #22c55e);
        font-size: var(--ic-text-sm);
      }

      .dirty-indicator {
        font-size: var(--ic-text-xs);
        color: var(--ic-warning, #f59e0b);
        font-style: italic;
      }

      /* Responsive */
      @media (max-width: 1023px) {
        .editor-layout {
          grid-template-columns: 1fr;
        }

        .yaml-panel {
          position: static;
        }
      }

      @media (max-width: 767px) {
        .header {
          flex-direction: column;
          align-items: flex-start;
        }
      }
    `,
  ];

  /** RPC client injected from app.ts. */
  @property({ attribute: false }) rpcClient: RpcClient | null = null;

  /** Agent ID from route params. "new" for create mode. */
  @property() agentId = "";

  @state() private _loadState: "loading" | "loaded" | "error" = "loading";
  @state() private _saving = false;
  @state() private _validating = false;
  @state() private _error = "";
  @state() private _validationErrors: string[] = [];
  @state() private _validationSuccess = false;
  @state() private _form: Record<string, unknown> = createDefaultForm();
  @state() private _expanded: Set<string> = new Set(["budget"]);
  @state() private _catalogProviders: CatalogProvider[] = [];

  /** System-wide streaming config loaded via config.read. */
  @state() private _streamingConfig: Record<string, unknown> = {};
  /** System-wide delivery queue config loaded via config.read. */
  @state() private _deliveryQueueConfig: Record<string, unknown> = {};
  /** System-wide delivery mirror config loaded via config.read. */
  @state() private _deliveryMirrorConfig: Record<string, unknown> = {};
  /** System-wide queue config loaded via config.read. */
  @state() private _queueConfig: Record<string, unknown> = {};
  /** System-wide auto-reply engine config loaded via config.read. */
  @state() private _autoReplyConfig: Record<string, unknown> = {};
  /** System-wide send policy config loaded via config.read. */
  @state() private _sendPolicyConfig: Record<string, unknown> = {};
  /** Module name of last successfully applied log level (for indicator). */
  @state() private _logLevelApplied = "";

  /** Dirty-state tracker for unsaved change detection and navigation guards. */
  private _dirtyTracker = createDirtyTracker();

  /** Whether we are creating a new agent. */
  get _isNew(): boolean {
    return !this.agentId || this.agentId === "new";
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._dirtyTracker.attach();
    window.addEventListener("hashchange", this._boundHashChangeGuard);
    if (this.rpcClient) {
      this._loadModelCatalog();
      this._loadTopLevelConfig();
    }
    if (this._isNew) {
      this._loadState = "loaded";
    } else if (this.rpcClient) {
      this._loadAgent();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._dirtyTracker.detach();
    window.removeEventListener("hashchange", this._boundHashChangeGuard);
  }

  /** Bound hashchange handler for navigation guard. */
  private _boundHashChangeGuard = (): void => {
    if (this._dirtyTracker.isDirty && !this._navigatingAfterSave) {
      if (!this._dirtyTracker.confirmNavigation()) {
        // User cancelled -- restore previous hash (the agent editor URL)
        const editPath = this._isNew ? "agents/new/edit" : `agents/${this.agentId}/edit`;
        history.replaceState(null, "", `#/${editPath}`);
      }
    }
    this._navigatingAfterSave = false;
  };

  /** Flag to skip dirty check when navigating after a successful save or intentional cancel. */
  private _navigatingAfterSave = false;

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("rpcClient") && this.rpcClient) {
      if (this._catalogProviders.length === 0) this._loadModelCatalog();
      this._loadTopLevelConfig();
      if (!this._isNew && this._loadState === "loading") this._loadAgent();
    }
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
      // Non-fatal -- dropdown will show current model as raw ID
    }
  }

  /** Load system-wide streaming and delivery config from config.read RPC. */
  async _loadTopLevelConfig(): Promise<void> {
    if (!this.rpcClient) return;
    try {
      const result = await this.rpcClient.call<{ config: Record<string, unknown>; sections: string[] }>("config.read");
      const cfg = result.config;
      this._streamingConfig = (cfg.streaming as Record<string, unknown>) ?? {};
      this._deliveryQueueConfig = (cfg.deliveryQueue as Record<string, unknown>) ?? {};
      this._deliveryMirrorConfig = (cfg.deliveryMirror as Record<string, unknown>) ?? {};
      this._queueConfig = (cfg.queue as Record<string, unknown>) ?? {};
      this._autoReplyConfig = (cfg.autoReplyEngine as Record<string, unknown>) ?? {};
      this._sendPolicyConfig = (cfg.sendPolicy as Record<string, unknown>) ?? {};
    } catch {
      // Non-fatal -- sections will show defaults
    }
  }

  /** Handle config-change events from system-wide sub-editors (streaming, delivery). */
  private async _handleConfigChange(e: CustomEvent<{ section: string; key: string; value: unknown }>): Promise<void> {
    const { section, key, value } = e.detail;
    try {
      await this.rpcClient!.call("config.patch", { section, key, value });
      // Update local state to reflect the change
      if (section === "streaming") this._streamingConfig = { ...this._streamingConfig, [key]: value };
      else if (section === "deliveryQueue") this._deliveryQueueConfig = { ...this._deliveryQueueConfig, [key]: value };
      else if (section === "deliveryMirror") this._deliveryMirrorConfig = { ...this._deliveryMirrorConfig, [key]: value };
      else if (section === "queue") this._queueConfig = { ...this._queueConfig, [key]: value };
      else if (section === "autoReplyEngine") this._autoReplyConfig = { ...this._autoReplyConfig, [key]: value };
      else if (section === "sendPolicy") this._sendPolicyConfig = { ...this._sendPolicyConfig, [key]: value };
      IcToast.show("Saved", "success");
    } catch (err) {
      IcToast.show(err instanceof Error ? err.message : "Failed to save", "error");
    }
  }

  /** Handle log-level-change events from the log level editor. */
  private async _handleLogLevelChange(e: CustomEvent<LogLevelChangeDetail>): Promise<void> {
    const { module, level } = e.detail;
    try {
      const params: Record<string, string> = { level };
      if (module) params.module = module;
      await this.rpcClient!.call("daemon.setLogLevel", params);
      this._logLevelApplied = module ?? "__global__";
      IcToast.show(`Log level ${module ? `${module}: ` : ""}${level}`, "success");
      setTimeout(() => { this._logLevelApplied = ""; }, 3000);
    } catch (err) {
      IcToast.show(err instanceof Error ? err.message : "Failed to set log level", "error");
    }
  }

  /** Load existing agent config for edit mode. */
  async _loadAgent(): Promise<void> {
    if (!this.rpcClient) {
      this._loadState = "error";
      this._error = "Not connected";
      return;
    }
    this._loadState = "loading";
    try {
      const result = await this.rpcClient.call<{ agentId: string; config: Record<string, unknown> }>(
        "agents.get",
        { agentId: this.agentId },
      );
      const agent = this._mapConfigToDetail(result.agentId, result.config);
      this._populateForm(agent);
      this._loadState = "loaded";
    } catch (e) {
      this._loadState = "error";
      this._error = e instanceof Error ? e.message : "Failed to load agent";
    }
  }

  /** Map raw PerAgentConfig from RPC to the AgentDetail shape _populateForm expects. */
  private _mapConfigToDetail(agentId: string, cfg: Record<string, unknown>): AgentDetail {
    const cb = cfg.circuitBreaker as Record<string, unknown> | undefined;
    const cg = cfg.contextGuard as Record<string, unknown> | undefined;
    const sr = cfg.sdkRetry as Record<string, unknown> | undefined;
    const rag = cfg.rag as Record<string, unknown> | undefined;
    const mf = cfg.modelFailover as Record<string, unknown> | undefined;
    const sess = cfg.session as Record<string, unknown> | undefined;
    const rp = sess?.resetPolicy as Record<string, unknown> | undefined;
    const conc = cfg.concurrency as Record<string, unknown> | undefined;
    const sk = cfg.skills as Record<string, unknown> | undefined;
    const tp = sk?.toolPolicy as Record<string, unknown> | undefined;
    const ce = cfg.contextEngine as Record<string, unknown> | undefined;

    return {
      id: agentId,
      name: cfg.name as string | undefined,
      provider: (cfg.provider as string) ?? "anthropic",
      model: (cfg.model as string) ?? "",
      status: "active",
      maxSteps: cfg.maxSteps as number | undefined,
      temperature: cfg.temperature as number | undefined,
      thinkingLevel: cfg.thinkingLevel as string | undefined,
      maxTokens: cfg.maxTokens as number | undefined,
      cacheRetention: cfg.cacheRetention as number | undefined,
      maxContextChars: cfg.maxContextChars as number | undefined,
      budgets: cfg.budgets as AgentDetail["budgets"],
      circuitBreaker: cb ? {
        state: "closed" as const,
        failures: 0,
        threshold: (cb.failureThreshold as number) ?? 5,
        resetTimeoutMs: (cb.resetTimeoutMs as number) ?? 60000,
      } : undefined,
      safety: {
        contextGuard: cg ? {
          enabled: (cg.enabled as boolean) ?? true,
          warnPct: (cg.warnPercent as number) ?? 80,
          blockPct: (cg.blockPercent as number) ?? 95,
        } : undefined,
        sdkRetry: sr ? {
          enabled: (sr.enabled as boolean) ?? true,
          maxRetries: (sr.maxRetries as number) ?? 3,
          baseDelayMs: (sr.baseDelayMs as number) ?? 2000,
        } : undefined,
      },
      rag: rag ? {
        enabled: (rag.enabled as boolean) ?? false,
        maxResults: rag.maxResults as number | undefined,
        maxContextChars: rag.maxContextChars as number | undefined,
        minScore: rag.minScore as number | undefined,
        trustLevels: rag.includeTrustLevels as string[] | undefined,
      } : undefined,
      modelFailover: mf ? {
        fallbackModels: (mf.fallbackModels as Array<Record<string, unknown>> | undefined)?.map(
          (m) => `${m.provider}:${m.modelId}`,
        ),
        authProfiles: mf.authProfiles as unknown[] | undefined,
        allowedModels: mf.allowedModels as string[] | undefined,
        maxAttempts: mf.maxAttempts as number | undefined,
        cooldownInitialMs: mf.cooldownInitialMs as number | undefined,
        cooldownMultiplier: mf.cooldownMultiplier as number | undefined,
        cooldownCapMs: mf.cooldownCapMs as number | undefined,
      } : undefined,
      sessionPolicy: rp ? {
        resetMode: rp.mode as string | undefined,
        dailyResetHour: rp.dailyResetHour as number | undefined,
        timezone: (rp.dailyResetTimezone as string) ?? "UTC",
        idleTimeoutMs: rp.idleTimeoutMs as number | undefined,
      } : undefined,
      concurrency: conc ? {
        maxConcurrent: (conc.maxConcurrentRuns as number) ?? 5,
        maxQueued: (conc.maxQueuedPerSession as number) ?? 10,
      } : undefined,
      skills: sk ? {
        discoveryPaths: sk.discoveryPaths as string[] | undefined,
        toolPolicyProfile: tp?.profile as string | undefined,
        allowList: tp?.allow as string[] | undefined,
        denyList: tp?.deny as string[] | undefined,
        builtinTools: sk.builtinTools as Record<string, boolean> | undefined,
      } : undefined,
      broadcastGroups: cfg.broadcastGroups as AgentDetail["broadcastGroups"],
      heartbeat: (() => {
        const sched = cfg.scheduler as Record<string, unknown> | undefined;
        const hb = sched?.heartbeat as Record<string, unknown> | undefined;
        if (!hb) return undefined;
        const hbTarget = hb.target as Record<string, unknown> | undefined;
        return {
          enabled: hb.enabled as boolean | undefined,
          intervalMs: hb.intervalMs as number | undefined,
          showOk: hb.showOk as boolean | undefined,
          showAlerts: hb.showAlerts as boolean | undefined,
          target: hbTarget ? {
            channelType: hbTarget.channelType as string | undefined,
            channelId: hbTarget.channelId as string | undefined,
            chatId: hbTarget.chatId as string | undefined,
            isDm: hbTarget.isDm as boolean | undefined,
          } : undefined,
          prompt: hb.prompt as string | undefined,
          model: hb.model as string | undefined,
          session: hb.session as string | undefined,
          allowDm: hb.allowDm as boolean | undefined,
          lightContext: hb.lightContext as boolean | undefined,
          ackMaxChars: hb.ackMaxChars as number | undefined,
          responsePrefix: hb.responsePrefix as string | undefined,
          skipHeartbeatOnlyDelivery: hb.skipHeartbeatOnlyDelivery as boolean | undefined,
          alertThreshold: hb.alertThreshold as number | undefined,
          alertCooldownMs: hb.alertCooldownMs as number | undefined,
          staleMs: hb.staleMs as number | undefined,
        };
      })(),
      advanced: {
        elevatedReply: cfg.elevatedReply,
        tracing: cfg.tracing,
        workspacePath: cfg.workspacePath,
        bootstrap: cfg.bootstrap,
        modelRoutes: cfg.modelRoutes,
        secretsAccess: (cfg.secrets as Record<string, unknown> | undefined)?.allowedPatterns,
      },
      contextEngine: ce ? {
        enabled: ce.enabled as boolean | undefined,
        version: ce.version as string | undefined,
        thinkingKeepTurns: ce.thinkingKeepTurns as number | undefined,
        compactionModel: ce.compactionModel as string | undefined,
        evictionMinAge: ce.evictionMinAge as number | undefined,
        historyTurns: ce.historyTurns as number | undefined,
        observationKeepWindow: ce.observationKeepWindow as number | undefined,
        observationTriggerChars: ce.observationTriggerChars as number | undefined,
        observationDeactivationChars: ce.observationDeactivationChars as number | undefined,
        compactionCooldownTurns: ce.compactionCooldownTurns as number | undefined,
        historyTurnOverrides: ce.historyTurnOverrides as Record<string, number> | undefined,
        freshTailTurns: ce.freshTailTurns as number | undefined,
        contextThreshold: ce.contextThreshold as number | undefined,
        leafMinFanout: ce.leafMinFanout as number | undefined,
        condensedMinFanout: ce.condensedMinFanout as number | undefined,
        condensedMinFanoutHard: ce.condensedMinFanoutHard as number | undefined,
        incrementalMaxDepth: ce.incrementalMaxDepth as number | undefined,
        leafChunkTokens: ce.leafChunkTokens as number | undefined,
        leafTargetTokens: ce.leafTargetTokens as number | undefined,
        condensedTargetTokens: ce.condensedTargetTokens as number | undefined,
        maxExpandTokens: ce.maxExpandTokens as number | undefined,
        maxRecallsPerDay: ce.maxRecallsPerDay as number | undefined,
        recallTimeoutMs: ce.recallTimeoutMs as number | undefined,
        largeFileTokenThreshold: ce.largeFileTokenThreshold as number | undefined,
        annotationKeepWindow: ce.annotationKeepWindow as number | undefined,
        annotationTriggerChars: ce.annotationTriggerChars as number | undefined,
        summaryModel: ce.summaryModel as string | undefined,
        summaryProvider: ce.summaryProvider as string | undefined,
      } : undefined,
    } as AgentDetail;
  }

  /** Populate flat form from nested AgentDetail. */
  private _populateForm(agent: AgentDetail): void {
    const form = createDefaultForm();
    form.id = agent.id;
    form.name = agent.name ?? "";
    form.model = agent.model ?? "";
    form.provider = agent.provider ?? "anthropic";
    form.maxSteps = agent.maxSteps ?? 25;
    form.temperature = agent.temperature;
    form.thinkingLevel = agent.thinkingLevel ?? "medium";
    form.maxTokens = agent.maxTokens;
    form.cacheRetention = agent.cacheRetention;
    form.maxContextChars = agent.maxContextChars;

    if (agent.budgets) {
      form["budgets.perExecution"] = agent.budgets.perExecution;
      form["budgets.perHour"] = agent.budgets.perHour;
      form["budgets.perDay"] = agent.budgets.perDay;
    }

    if (agent.circuitBreaker) {
      form["circuitBreaker.threshold"] = agent.circuitBreaker.threshold ?? 5;
      form["circuitBreaker.resetTimeoutMs"] = agent.circuitBreaker.resetTimeoutMs ?? 60000;
    }

    if (agent.safety?.contextGuard) {
      form["safety.contextGuard.enabled"] = agent.safety.contextGuard.enabled;
      form["safety.contextGuard.warnPct"] = agent.safety.contextGuard.warnPct;
      form["safety.contextGuard.blockPct"] = agent.safety.contextGuard.blockPct;
    }

    if (agent.safety?.sdkRetry) {
      form["safety.sdkRetry.enabled"] = agent.safety.sdkRetry.enabled;
      form["safety.sdkRetry.maxRetries"] = agent.safety.sdkRetry.maxRetries;
      form["safety.sdkRetry.baseDelayMs"] = agent.safety.sdkRetry.baseDelayMs;
    }

    if (agent.modelFailover) {
      form["failover.fallbackModels"] = (agent.modelFailover.fallbackModels ?? []).join("\n");
      form["failover.authProfiles"] = agent.modelFailover.authProfiles?.length
        ? JSON.stringify(agent.modelFailover.authProfiles, null, 2)
        : "";
      form["failover.allowedModels"] = (agent.modelFailover.allowedModels ?? []).join("\n");
      form["failover.maxAttempts"] = agent.modelFailover.maxAttempts ?? 6;
      form["failover.cooldownMs"] = agent.modelFailover.cooldownInitialMs ?? 60000;
    }

    if (agent.rag) {
      form["advanced.rag.enabled"] = agent.rag.enabled;
      form["advanced.rag.maxResults"] = agent.rag.maxResults ?? 10;
      form["advanced.rag.minScore"] = agent.rag.minScore ?? 0.5;
      if (agent.rag.trustLevels) {
        form["rag.trustLevels.system"] = agent.rag.trustLevels.includes("system");
        form["rag.trustLevels.learned"] = agent.rag.trustLevels.includes("learned");
        form["rag.trustLevels.external"] = agent.rag.trustLevels.includes("external");
      }
    }

    if (agent.sessionPolicy) {
      form["session.resetMode"] = agent.sessionPolicy.resetMode ?? "daily";
      form["session.dailyResetHour"] = agent.sessionPolicy.dailyResetHour ?? 0;
      form["session.timezone"] = agent.sessionPolicy.timezone ?? "UTC";
      form["session.idleTimeoutMs"] = agent.sessionPolicy.idleTimeoutMs;
    }

    if (agent.concurrency) {
      form["advanced.concurrency.maxConcurrent"] = agent.concurrency.maxConcurrent ?? 5;
      form["advanced.concurrency.maxQueued"] = agent.concurrency.maxQueued ?? 10;
    }

    {
      const sk = agent.skills;
      form["skills.discoveryPaths"] = (sk?.discoveryPaths ?? []).join("\n");
      form["skills.toolPolicyProfile"] = sk?.toolPolicyProfile ?? "full";
      form["skills.allowList"] = (sk?.allowList ?? []).join("\n");
      form["skills.denyList"] = (sk?.denyList ?? []).join("\n");
      const bt = sk?.builtinTools;
      for (const tool of BUILTIN_TOOLS) {
        // Schema defaults: all true except browser
        (form as Record<string, unknown>)[`skills.builtin.${tool}`] = bt ? (bt[tool] ?? false) : tool !== "browser";
      }
    }

    if (agent.broadcastGroups) {
      form["broadcast.groups"] = JSON.stringify(agent.broadcastGroups, null, 2);
    }

    const hb = agent.heartbeat;
    form["heartbeat.enabled"] = hb?.enabled ?? true;
    form["heartbeat.intervalMs"] = hb?.intervalMs;
    form["heartbeat.showOk"] = hb?.showOk;
    form["heartbeat.showAlerts"] = hb?.showAlerts;
    if (hb?.target) {
      form["heartbeat.target.channelType"] = hb.target.channelType ?? "";
      form["heartbeat.target.channelId"] = hb.target.channelId ?? "";
      form["heartbeat.target.chatId"] = hb.target.chatId ?? "";
      form["heartbeat.target.isDm"] = hb.target.isDm;
    }
    form["heartbeat.prompt"] = hb?.prompt ?? "";
    form["heartbeat.model"] = hb?.model ?? "";
    form["heartbeat.session"] = hb?.session ?? "";
    form["heartbeat.allowDm"] = hb?.allowDm;
    form["heartbeat.lightContext"] = hb?.lightContext;
    form["heartbeat.ackMaxChars"] = hb?.ackMaxChars;
    form["heartbeat.responsePrefix"] = hb?.responsePrefix ?? "";
    form["heartbeat.skipHeartbeatOnlyDelivery"] = hb?.skipHeartbeatOnlyDelivery;
    form["heartbeat.alertThreshold"] = hb?.alertThreshold;
    form["heartbeat.alertCooldownMs"] = hb?.alertCooldownMs;
    form["heartbeat.staleMs"] = hb?.staleMs;

    if (agent.advanced) {
      const adv = agent.advanced as Record<string, unknown>;
      if (adv.elevatedReply && typeof adv.elevatedReply === "object") {
        const er = adv.elevatedReply as Record<string, unknown>;
        form["advanced.elevatedReply.enabled"] = er.enabled ?? false;
        form["advanced.elevatedReply.recipients"] = Array.isArray(er.recipients) ? (er.recipients as string[]).join("\n") : "";
      }
      if (adv.tracing && typeof adv.tracing === "object") {
        const tr = adv.tracing as Record<string, unknown>;
        form["advanced.tracing.enabled"] = tr.enabled ?? false;
        form["advanced.tracing.outputDir"] = tr.outputDir ?? "";
      }
      form["advanced.workspacePath"] = adv.workspacePath ?? "";
      if (adv.bootstrap !== undefined) {
        form["advanced.bootstrap"] = typeof adv.bootstrap === "string" ? adv.bootstrap : JSON.stringify(adv.bootstrap, null, 2);
      }
      if (adv.modelRoutes !== undefined) {
        form["advanced.modelRoutes"] = typeof adv.modelRoutes === "string" ? adv.modelRoutes : JSON.stringify(adv.modelRoutes, null, 2);
      }
      if (adv.secretsAccess !== undefined) {
        form["advanced.secretsAccess"] = Array.isArray(adv.secretsAccess) ? (adv.secretsAccess as string[]).join("\n") : String(adv.secretsAccess);
      }
    }

    // Context Engine
    const ceDetail = (agent as unknown as Record<string, unknown>).contextEngine as Record<string, unknown> | undefined;
    if (ceDetail) {
      form["contextEngine.enabled"] = ceDetail.enabled ?? true;
      form["contextEngine.version"] = ceDetail.version ?? "pipeline";
      form["contextEngine.thinkingKeepTurns"] = ceDetail.thinkingKeepTurns;
      form["contextEngine.compactionModel"] = ceDetail.compactionModel ?? "";
      form["contextEngine.evictionMinAge"] = ceDetail.evictionMinAge;
      // Pipeline fields
      form["contextEngine.historyTurns"] = ceDetail.historyTurns;
      form["contextEngine.observationKeepWindow"] = ceDetail.observationKeepWindow;
      form["contextEngine.observationTriggerChars"] = ceDetail.observationTriggerChars;
      form["contextEngine.observationDeactivationChars"] = ceDetail.observationDeactivationChars;
      form["contextEngine.compactionCooldownTurns"] = ceDetail.compactionCooldownTurns;
      form["contextEngine.historyTurnOverrides"] = ceDetail.historyTurnOverrides
        ? JSON.stringify(ceDetail.historyTurnOverrides, null, 2)
        : "";
      // DAG fields
      form["contextEngine.freshTailTurns"] = ceDetail.freshTailTurns;
      form["contextEngine.contextThreshold"] = ceDetail.contextThreshold;
      form["contextEngine.leafMinFanout"] = ceDetail.leafMinFanout;
      form["contextEngine.condensedMinFanout"] = ceDetail.condensedMinFanout;
      form["contextEngine.condensedMinFanoutHard"] = ceDetail.condensedMinFanoutHard;
      form["contextEngine.incrementalMaxDepth"] = ceDetail.incrementalMaxDepth;
      form["contextEngine.leafChunkTokens"] = ceDetail.leafChunkTokens;
      form["contextEngine.leafTargetTokens"] = ceDetail.leafTargetTokens;
      form["contextEngine.condensedTargetTokens"] = ceDetail.condensedTargetTokens;
      form["contextEngine.maxExpandTokens"] = ceDetail.maxExpandTokens;
      form["contextEngine.maxRecallsPerDay"] = ceDetail.maxRecallsPerDay;
      form["contextEngine.recallTimeoutMs"] = ceDetail.recallTimeoutMs;
      form["contextEngine.largeFileTokenThreshold"] = ceDetail.largeFileTokenThreshold;
      form["contextEngine.annotationKeepWindow"] = ceDetail.annotationKeepWindow;
      form["contextEngine.annotationTriggerChars"] = ceDetail.annotationTriggerChars;
      form["contextEngine.summaryModel"] = ceDetail.summaryModel ?? "";
      form["contextEngine.summaryProvider"] = ceDetail.summaryProvider ?? "";
    }

    this._form = form;
  }

  /** Update a form field and trigger re-render. */
  _updateField(key: string, value: unknown): void {
    this._form = { ...this._form, [key]: value };
    this._dirtyTracker.markDirty(key);
    this._validationSuccess = false;
    this._validationErrors = [];
  }

  /** Get a form field with a default value. */
  _getField<T>(key: string, defaultValue: T): T {
    const val = this._form[key];
    return (val !== undefined && val !== null ? val : defaultValue) as T;
  }

  /** Handle field-change events from sub-editors. */
  private _handleFieldChange(e: CustomEvent<FieldChangeDetail>): void {
    this._updateField(e.detail.key, e.detail.value);
  }

  /** Reconstruct nested PerAgentConfig payload from flat form for RPC call. */
  _buildPayload(): Record<string, unknown> {
    const f = this._form;
    const payload: Record<string, unknown> = {
      name: f.name || undefined,
      model: f.model || undefined,
      provider: f.provider || undefined,
      maxSteps: f.maxSteps !== undefined ? Number(f.maxSteps) : undefined,
      temperature: f.temperature !== undefined && f.temperature !== "" ? Number(f.temperature) : undefined,
      thinkingLevel: f.thinkingLevel || undefined,
      maxTokens: f.maxTokens !== undefined && f.maxTokens !== "" ? Number(f.maxTokens) : undefined,
      cacheRetention: f.cacheRetention !== undefined && f.cacheRetention !== "" ? f.cacheRetention : undefined,
      maxContextChars: f.maxContextChars !== undefined && f.maxContextChars !== "" ? Number(f.maxContextChars) : undefined,
    };

    // Budgets
    const budgets: Record<string, unknown> = {};
    if (f["budgets.perExecution"] !== undefined && f["budgets.perExecution"] !== "") budgets.perExecution = Number(f["budgets.perExecution"]);
    if (f["budgets.perHour"] !== undefined && f["budgets.perHour"] !== "") budgets.perHour = Number(f["budgets.perHour"]);
    if (f["budgets.perDay"] !== undefined && f["budgets.perDay"] !== "") budgets.perDay = Number(f["budgets.perDay"]);
    if (Object.keys(budgets).length > 0) payload.budgets = budgets;

    // Circuit breaker
    payload.circuitBreaker = {
      failureThreshold: Number(f["circuitBreaker.threshold"]) || 5,
      resetTimeoutMs: Number(f["circuitBreaker.resetTimeoutMs"]) || 60000,
    };

    // Context guard
    payload.contextGuard = {
      enabled: Boolean(f["safety.contextGuard.enabled"]),
      warnPercent: Number(f["safety.contextGuard.warnPct"]) || 80,
      blockPercent: Number(f["safety.contextGuard.blockPct"]) || 95,
    };

    // SDK retry
    payload.sdkRetry = {
      enabled: Boolean(f["safety.sdkRetry.enabled"]),
      maxRetries: Number(f["safety.sdkRetry.maxRetries"]) || 3,
      baseDelayMs: Number(f["safety.sdkRetry.baseDelayMs"]) || 2000,
    };

    // Model failover
    const foFallback = this._textareaToArray(f["failover.fallbackModels"] as string);
    const foAllowed = this._textareaToArray(f["failover.allowedModels"] as string);
    const foAuthRaw = (f["failover.authProfiles"] as string) || "";
    const modelFailover: Record<string, unknown> = {
      fallbackModels: foFallback.map((line) => {
        const [provider, ...rest] = line.split(":");
        return { provider, modelId: rest.join(":") || provider };
      }).filter((m) => m.modelId),
      allowedModels: foAllowed,
      maxAttempts: Number(f["failover.maxAttempts"]) || 6,
      cooldownInitialMs: Number(f["failover.cooldownMs"]) || 60000,
    };
    if (foAuthRaw) {
      try { modelFailover.authProfiles = JSON.parse(foAuthRaw); } catch { /* skip invalid JSON */ }
    }
    if (foFallback.length > 0 || foAllowed.length > 0 || foAuthRaw) {
      payload.modelFailover = modelFailover;
    }

    // RAG
    const ragPayload: Record<string, unknown> = {
      enabled: Boolean(f["advanced.rag.enabled"]),
      maxResults: Number(f["advanced.rag.maxResults"]) || 10,
      minScore: Number(f["advanced.rag.minScore"]) || 0.5,
      includeTrustLevels: [
        ...(f["rag.trustLevels.system"] ? ["system"] : []),
        ...(f["rag.trustLevels.learned"] ? ["learned"] : []),
        ...(f["rag.trustLevels.external"] ? ["external"] : []),
      ],
    };
    payload.rag = ragPayload;

    // Session
    const resetPolicy: Record<string, unknown> = {
      mode: f["session.resetMode"] || "daily",
      dailyResetHour: Number(f["session.dailyResetHour"]) || 0,
      dailyResetTimezone: f["session.timezone"] || "UTC",
    };
    if (f["session.idleTimeoutMs"] !== undefined && f["session.idleTimeoutMs"] !== "") {
      resetPolicy.idleTimeoutMs = Number(f["session.idleTimeoutMs"]);
    }
    const session: Record<string, unknown> = { resetPolicy };
    if (f["session.pruning.enabled"]) {
      session.pruning = {
        enabled: true,
        maxEntries: Number(f["session.pruning.maxEntries"]) || 100,
      };
    }
    if (f["session.compaction.enabled"]) {
      session.compaction = {
        enabled: true,
        threshold: Number(f["session.compaction.threshold"]) || 50,
      };
    }
    payload.session = session;

    // Concurrency
    payload.concurrency = {
      maxConcurrentRuns: Number(f["advanced.concurrency.maxConcurrent"]) || 1,
      maxQueuedPerSession: Number(f["advanced.concurrency.maxQueued"]) || 50,
    };

    // Skills
    const discoveryPaths = this._textareaToArray(f["skills.discoveryPaths"] as string);
    const allowList = this._textareaToArray(f["skills.allowList"] as string);
    const denyList = this._textareaToArray(f["skills.denyList"] as string);
    const builtinTools: Record<string, boolean> = {};
    for (const tool of BUILTIN_TOOLS) {
      builtinTools[tool] = Boolean(f[`skills.builtin.${tool}`]);
    }
    payload.skills = {
      discoveryPaths: discoveryPaths.length > 0 ? discoveryPaths : undefined,
      builtinTools,
      toolPolicy: {
        profile: f["skills.toolPolicyProfile"] || "full",
        allow: allowList.length > 0 ? allowList : [],
        deny: denyList.length > 0 ? denyList : [],
      },
    };

    // Heartbeat
    const heartbeat: Record<string, unknown> = {};
    if (f["heartbeat.enabled"] !== undefined && f["heartbeat.enabled"] !== "") heartbeat.enabled = Boolean(f["heartbeat.enabled"]);
    if (f["heartbeat.intervalMs"] !== undefined && f["heartbeat.intervalMs"] !== "") heartbeat.intervalMs = Number(f["heartbeat.intervalMs"]);
    if (f["heartbeat.showOk"] !== undefined && f["heartbeat.showOk"] !== "") heartbeat.showOk = Boolean(f["heartbeat.showOk"]);
    if (f["heartbeat.showAlerts"] !== undefined && f["heartbeat.showAlerts"] !== "") heartbeat.showAlerts = Boolean(f["heartbeat.showAlerts"]);

    const hbTarget: Record<string, unknown> = {};
    if (f["heartbeat.target.channelType"]) hbTarget.channelType = f["heartbeat.target.channelType"];
    if (f["heartbeat.target.channelId"]) hbTarget.channelId = f["heartbeat.target.channelId"];
    if (f["heartbeat.target.chatId"]) hbTarget.chatId = f["heartbeat.target.chatId"];
    if (f["heartbeat.target.isDm"] !== undefined && f["heartbeat.target.isDm"] !== "") hbTarget.isDm = Boolean(f["heartbeat.target.isDm"]);
    if (Object.keys(hbTarget).length > 0) heartbeat.target = hbTarget;

    if (f["heartbeat.prompt"]) heartbeat.prompt = f["heartbeat.prompt"];
    if (f["heartbeat.model"]) heartbeat.model = f["heartbeat.model"];
    if (f["heartbeat.session"]) heartbeat.session = f["heartbeat.session"];
    if (f["heartbeat.allowDm"] !== undefined && f["heartbeat.allowDm"] !== "") heartbeat.allowDm = Boolean(f["heartbeat.allowDm"]);
    if (f["heartbeat.lightContext"] !== undefined && f["heartbeat.lightContext"] !== "") heartbeat.lightContext = Boolean(f["heartbeat.lightContext"]);
    if (f["heartbeat.ackMaxChars"] !== undefined && f["heartbeat.ackMaxChars"] !== "") heartbeat.ackMaxChars = Number(f["heartbeat.ackMaxChars"]);
    if (f["heartbeat.responsePrefix"]) heartbeat.responsePrefix = f["heartbeat.responsePrefix"];
    if (f["heartbeat.skipHeartbeatOnlyDelivery"] !== undefined && f["heartbeat.skipHeartbeatOnlyDelivery"] !== "") heartbeat.skipHeartbeatOnlyDelivery = Boolean(f["heartbeat.skipHeartbeatOnlyDelivery"]);
    if (f["heartbeat.alertThreshold"] !== undefined && f["heartbeat.alertThreshold"] !== "") heartbeat.alertThreshold = Number(f["heartbeat.alertThreshold"]);
    if (f["heartbeat.alertCooldownMs"] !== undefined && f["heartbeat.alertCooldownMs"] !== "") heartbeat.alertCooldownMs = Number(f["heartbeat.alertCooldownMs"]);
    if (f["heartbeat.staleMs"] !== undefined && f["heartbeat.staleMs"] !== "") heartbeat.staleMs = Number(f["heartbeat.staleMs"]);

    if (Object.keys(heartbeat).length > 0) {
      payload.scheduler = { heartbeat };
    }

    // Broadcast groups
    try {
      const groups = JSON.parse((f["broadcast.groups"] as string) || "[]");
      if (Array.isArray(groups) && groups.length > 0) payload.broadcastGroups = groups;
    } catch {
      // Invalid JSON -- skip
    }

    // Elevated reply
    if (f["advanced.elevatedReply.enabled"]) {
      payload.elevatedReply = { enabled: true };
    }

    // Tracing
    if (f["advanced.tracing.enabled"]) {
      payload.tracing = {
        enabled: true,
        outputDir: (f["advanced.tracing.outputDir"] as string) || "~/.comis/traces",
      };
    }

    // Workspace path
    if (f["advanced.workspacePath"]) {
      payload.workspacePath = f["advanced.workspacePath"];
    }

    // Bootstrap
    if (f["advanced.bootstrap"]) {
      try { payload.bootstrap = JSON.parse(f["advanced.bootstrap"] as string); } catch { /* skip invalid JSON */ }
    }

    // Model routes
    if (f["advanced.modelRoutes"]) {
      try { payload.modelRoutes = JSON.parse(f["advanced.modelRoutes"] as string); } catch { /* skip invalid JSON */ }
    }

    // Secrets access
    const secretPatterns = this._textareaToArray(f["advanced.secretsAccess"] as string);
    if (secretPatterns.length > 0) {
      payload.secrets = { allowedPatterns: secretPatterns };
    }

    // Context Engine
    const ce: Record<string, unknown> = {};
    if (f["contextEngine.enabled"] !== undefined) ce.enabled = Boolean(f["contextEngine.enabled"]);
    const ceVersion = f["contextEngine.version"] as string;
    if (ceVersion) ce.version = ceVersion;

    // Shared fields
    if (f["contextEngine.thinkingKeepTurns"] !== undefined && f["contextEngine.thinkingKeepTurns"] !== "") {
      ce.thinkingKeepTurns = Number(f["contextEngine.thinkingKeepTurns"]);
    }
    if (f["contextEngine.compactionModel"]) ce.compactionModel = f["contextEngine.compactionModel"];
    if (f["contextEngine.evictionMinAge"] !== undefined && f["contextEngine.evictionMinAge"] !== "") {
      ce.evictionMinAge = Number(f["contextEngine.evictionMinAge"]);
    }

    // Pipeline-mode fields (only include when version is pipeline)
    if (ceVersion === "pipeline") {
      if (f["contextEngine.historyTurns"] !== undefined && f["contextEngine.historyTurns"] !== "") {
        ce.historyTurns = Number(f["contextEngine.historyTurns"]);
      }
      if (f["contextEngine.observationKeepWindow"] !== undefined && f["contextEngine.observationKeepWindow"] !== "") {
        ce.observationKeepWindow = Number(f["contextEngine.observationKeepWindow"]);
      }
      if (f["contextEngine.observationTriggerChars"] !== undefined && f["contextEngine.observationTriggerChars"] !== "") {
        ce.observationTriggerChars = Number(f["contextEngine.observationTriggerChars"]);
      }
      if (f["contextEngine.observationDeactivationChars"] !== undefined && f["contextEngine.observationDeactivationChars"] !== "") {
        ce.observationDeactivationChars = Number(f["contextEngine.observationDeactivationChars"]);
      }
      if (f["contextEngine.compactionCooldownTurns"] !== undefined && f["contextEngine.compactionCooldownTurns"] !== "") {
        ce.compactionCooldownTurns = Number(f["contextEngine.compactionCooldownTurns"]);
      }
      const htoRaw = (f["contextEngine.historyTurnOverrides"] as string) || "";
      if (htoRaw) {
        try { ce.historyTurnOverrides = JSON.parse(htoRaw); } catch { /* skip invalid JSON */ }
      }
    }

    // DAG-mode fields (only include when version is dag)
    if (ceVersion === "dag") {
      if (f["contextEngine.freshTailTurns"] !== undefined && f["contextEngine.freshTailTurns"] !== "") {
        ce.freshTailTurns = Number(f["contextEngine.freshTailTurns"]);
      }
      if (f["contextEngine.contextThreshold"] !== undefined && f["contextEngine.contextThreshold"] !== "") {
        ce.contextThreshold = Number(f["contextEngine.contextThreshold"]);
      }
      if (f["contextEngine.leafMinFanout"] !== undefined && f["contextEngine.leafMinFanout"] !== "") {
        ce.leafMinFanout = Number(f["contextEngine.leafMinFanout"]);
      }
      if (f["contextEngine.condensedMinFanout"] !== undefined && f["contextEngine.condensedMinFanout"] !== "") {
        ce.condensedMinFanout = Number(f["contextEngine.condensedMinFanout"]);
      }
      if (f["contextEngine.condensedMinFanoutHard"] !== undefined && f["contextEngine.condensedMinFanoutHard"] !== "") {
        ce.condensedMinFanoutHard = Number(f["contextEngine.condensedMinFanoutHard"]);
      }
      if (f["contextEngine.incrementalMaxDepth"] !== undefined && f["contextEngine.incrementalMaxDepth"] !== "") {
        ce.incrementalMaxDepth = Number(f["contextEngine.incrementalMaxDepth"]);
      }
      if (f["contextEngine.leafChunkTokens"] !== undefined && f["contextEngine.leafChunkTokens"] !== "") {
        ce.leafChunkTokens = Number(f["contextEngine.leafChunkTokens"]);
      }
      if (f["contextEngine.leafTargetTokens"] !== undefined && f["contextEngine.leafTargetTokens"] !== "") {
        ce.leafTargetTokens = Number(f["contextEngine.leafTargetTokens"]);
      }
      if (f["contextEngine.condensedTargetTokens"] !== undefined && f["contextEngine.condensedTargetTokens"] !== "") {
        ce.condensedTargetTokens = Number(f["contextEngine.condensedTargetTokens"]);
      }
      if (f["contextEngine.maxExpandTokens"] !== undefined && f["contextEngine.maxExpandTokens"] !== "") {
        ce.maxExpandTokens = Number(f["contextEngine.maxExpandTokens"]);
      }
      if (f["contextEngine.maxRecallsPerDay"] !== undefined && f["contextEngine.maxRecallsPerDay"] !== "") {
        ce.maxRecallsPerDay = Number(f["contextEngine.maxRecallsPerDay"]);
      }
      if (f["contextEngine.recallTimeoutMs"] !== undefined && f["contextEngine.recallTimeoutMs"] !== "") {
        ce.recallTimeoutMs = Number(f["contextEngine.recallTimeoutMs"]);
      }
      if (f["contextEngine.largeFileTokenThreshold"] !== undefined && f["contextEngine.largeFileTokenThreshold"] !== "") {
        ce.largeFileTokenThreshold = Number(f["contextEngine.largeFileTokenThreshold"]);
      }
      if (f["contextEngine.annotationKeepWindow"] !== undefined && f["contextEngine.annotationKeepWindow"] !== "") {
        ce.annotationKeepWindow = Number(f["contextEngine.annotationKeepWindow"]);
      }
      if (f["contextEngine.annotationTriggerChars"] !== undefined && f["contextEngine.annotationTriggerChars"] !== "") {
        ce.annotationTriggerChars = Number(f["contextEngine.annotationTriggerChars"]);
      }
      if (f["contextEngine.summaryModel"]) ce.summaryModel = f["contextEngine.summaryModel"];
      if (f["contextEngine.summaryProvider"]) ce.summaryProvider = f["contextEngine.summaryProvider"];
    }

    if (Object.keys(ce).length > 0) payload.contextEngine = ce;

    return payload;
  }

  /** Convert newline-separated textarea value to array. */
  private _textareaToArray(value: string): string[] {
    if (!value) return [];
    return value.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  /** Validate fields client-side and server-side (Zod schema). */
  async _handleValidate(): Promise<void> {
    this._validating = true;
    this._validationErrors = [];
    this._validationSuccess = false;

    const errors: string[] = [];

    // Client-side checks
    if (this._isNew && !this._form.id) errors.push("Agent ID is required");
    if (!this._form.provider) errors.push("Provider is required");
    if (!this._form.model) errors.push("Model is required");

    const maxSteps = Number(this._form.maxSteps);
    if (this._form.maxSteps !== undefined && this._form.maxSteps !== "" && (isNaN(maxSteps) || maxSteps < 1)) {
      errors.push("Max Steps must be a positive integer");
    }

    const temp = this._form.temperature;
    if (temp !== undefined && temp !== "") {
      const t = Number(temp);
      if (isNaN(t) || t < 0 || t > 2) errors.push("Temperature must be between 0 and 2");
    }

    if (errors.length > 0) {
      this._validationErrors = errors;
      this._validating = false;
      return;
    }

    // Server-side validation via dry-run agents.update parse
    if (this.rpcClient && !this._isNew) {
      try {
        const payload = this._buildPayload();
        await this.rpcClient.call("agents.update", {
          agentId: this.agentId,
          config: payload,
          dryRun: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Parse Zod validation errors from the response
        try {
          const parsed = JSON.parse(msg.replace(/^RPC error \(\d+\): /, ""));
          if (Array.isArray(parsed)) {
            for (const issue of parsed) {
              const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
              errors.push(path ? `${path}: ${issue.message}` : issue.message);
            }
          } else {
            errors.push(msg);
          }
        } catch {
          errors.push(msg);
        }
      }
    }

    this._validationErrors = errors;
    this._validationSuccess = errors.length === 0;
    this._validating = false;

    if (errors.length === 0) {
      IcToast.show("Configuration is valid", "success");
    }
  }

  /** Save handler: create or update agent. */
  async _handleSave(): Promise<void> {
    if (!this.rpcClient) {
      this._error = "Not connected";
      return;
    }

    // Validate required fields
    if (this._isNew && !this._form.id) {
      this._error = "Agent ID is required";
      return;
    }

    this._saving = true;
    this._error = "";

    try {
      const payload = this._buildPayload();

      if (this._isNew) {
        const result = await this.rpcClient.call<{ agentId: string }>("agents.create", { agentId: this._form.id, config: payload });
        this._dirtyTracker.markClean();
        this._navigatingAfterSave = true;
        IcToast.show("Agent created successfully", "success");
        this.dispatchEvent(new CustomEvent("navigate", { detail: `agents/${result?.agentId ?? this._form.id}`, bubbles: true, composed: true }));
      } else {
        await this.rpcClient.call("agents.update", { agentId: this.agentId, config: payload });
        this._dirtyTracker.markClean();
        this._navigatingAfterSave = true;
        IcToast.show("Agent updated successfully", "success");
        this.dispatchEvent(new CustomEvent("navigate", { detail: `agents/${this.agentId}`, bubbles: true, composed: true }));
      }
    } catch (e) {
      this._error = e instanceof Error ? e.message : "Save failed";
      IcToast.show(this._error, "error");
    } finally {
      this._saving = false;
    }
  }

  /** Cancel handler: navigate back (prompts if dirty). */
  _handleCancel(): void {
    if (!this._dirtyTracker.confirmNavigation()) return;
    this._dirtyTracker.markClean();
    this._navigatingAfterSave = true;
    const route = this._isNew ? "agents" : `agents/${this.agentId}`;
    this.dispatchEvent(new CustomEvent("navigate", { detail: route, bubbles: true, composed: true }));
  }

  /** Build a preview-friendly config object for YAML rendering. */
  private _buildYamlPreview(): Record<string, unknown> {
    const f = this._form;
    const preview: Record<string, unknown> = {};

    if (f.id) preview.agentId = f.id;
    if (f.name) preview.name = f.name;
    if (f.provider) preview.provider = f.provider;
    if (f.model) preview.model = f.model;
    if (f.temperature !== undefined && f.temperature !== "") preview.temperature = Number(f.temperature);
    if (f.maxSteps !== undefined && f.maxSteps !== "") preview.maxSteps = Number(f.maxSteps);
    if (f.thinkingLevel && f.thinkingLevel !== "none") preview.thinkingLevel = f.thinkingLevel;
    if (f.maxTokens !== undefined && f.maxTokens !== "") preview.maxTokens = Number(f.maxTokens);

    // Budgets
    const budgets: Record<string, unknown> = {};
    if (f["budgets.perExecution"] !== undefined && f["budgets.perExecution"] !== "") budgets.perExecution = Number(f["budgets.perExecution"]);
    if (f["budgets.perHour"] !== undefined && f["budgets.perHour"] !== "") budgets.perHour = Number(f["budgets.perHour"]);
    if (f["budgets.perDay"] !== undefined && f["budgets.perDay"] !== "") budgets.perDay = Number(f["budgets.perDay"]);
    if (Object.keys(budgets).length > 0) preview.budgets = budgets;

    // Session
    if (f["session.resetMode"] && f["session.resetMode"] !== "daily") {
      preview.session = { resetMode: f["session.resetMode"] };
    }

    // Skills
    if (f["skills.toolPolicyProfile"] && f["skills.toolPolicyProfile"] !== "minimal") {
      preview.skills = { toolPolicy: f["skills.toolPolicyProfile"] };
    }

    // Heartbeat
    if (f["heartbeat.enabled"]) {
      const hb: Record<string, unknown> = { enabled: true };
      if (f["heartbeat.intervalMs"]) hb.intervalMs = Number(f["heartbeat.intervalMs"]);
      if (f["heartbeat.target.channelType"]) hb.targetChannel = f["heartbeat.target.channelType"];
      preview.heartbeat = hb;
    }

    // Context Engine
    const ceEnabled = f["contextEngine.enabled"];
    const ceVersion = f["contextEngine.version"] as string;
    if (ceEnabled !== undefined) {
      const cePrev: Record<string, unknown> = {
        enabled: Boolean(ceEnabled),
        version: ceVersion || "pipeline",
      };
      if (f["contextEngine.thinkingKeepTurns"] !== undefined && f["contextEngine.thinkingKeepTurns"] !== "") {
        cePrev.thinkingKeepTurns = Number(f["contextEngine.thinkingKeepTurns"]);
      }
      if (f["contextEngine.compactionModel"]) cePrev.compactionModel = f["contextEngine.compactionModel"];
      if (f["contextEngine.evictionMinAge"] !== undefined && f["contextEngine.evictionMinAge"] !== "") {
        cePrev.evictionMinAge = Number(f["contextEngine.evictionMinAge"]);
      }
      if (ceVersion === "dag" && f["contextEngine.freshTailTurns"] !== undefined && f["contextEngine.freshTailTurns"] !== "") {
        cePrev.freshTailTurns = Number(f["contextEngine.freshTailTurns"]);
      }
      if (ceVersion === "pipeline" && f["contextEngine.historyTurns"] !== undefined && f["contextEngine.historyTurns"] !== "") {
        cePrev.historyTurns = Number(f["contextEngine.historyTurns"]);
      }
      preview.contextEngine = cePrev;
    }

    return preview;
  }

  // --- Main render ---

  override render() {
    if (this._loadState === "loading") {
      return html`<ic-loading mode="skeleton" lines="8"></ic-loading>`;
    }

    if (this._loadState === "error") {
      return html`
        <div class="error-bar">${this._error}</div>
        <button class="btn btn--secondary" @click=${() => this._loadAgent()}>Retry</button>
      `;
    }

    const title = this._isNew ? "Create Agent" : `Edit Agent: ${this.agentId}`;

    return html`
      <div class="header">
        <div class="header-left">
          <ic-breadcrumb
            .items=${[
              { label: "Agents", route: "agents" },
              ...(this._isNew ? [{ label: "Create" }] : [{ label: this.agentId, route: `agents/${this.agentId}` }, { label: "Edit" }]),
            ]}
            @navigate=${(e: CustomEvent<string>) => this._navigate(e.detail)}
          ></ic-breadcrumb>
          <h1 class="title">${title}</h1>
        </div>
      </div>

      ${this._error ? html`<div class="error-bar">${this._error}</div>` : nothing}

      <div class="editor-layout">
        <div class="form-panel">
          <!-- Essential section (always visible, no accordion) -->
          <div class="section-card">
            <div class="essential-header">Essential</div>
            <div class="essential-content">
              <ic-agent-essential-editor
                .form=${this._form}
                .isNew=${this._isNew}
                .agentId=${this.agentId}
                .catalogProviders=${this._catalogProviders}
                @field-change=${this._handleFieldChange}
              ></ic-agent-essential-editor>
            </div>
          </div>

          ${this._renderAccordionSection("budget", "Budget", html`
            <ic-agent-budget-editor
              .form=${this._form}
              @field-change=${this._handleFieldChange}
            ></ic-agent-budget-editor>
          `)}
          ${this._renderAccordionSection("session", "Session Policy", html`
            <ic-agent-session-editor
              .form=${this._form}
              @field-change=${this._handleFieldChange}
            ></ic-agent-session-editor>
          `)}
          ${this._renderAccordionSection("skills", "Skills", html`
            <ic-agent-skills-editor
              .form=${this._form}
              @field-change=${this._handleFieldChange}
            ></ic-agent-skills-editor>
          `)}
          ${this._renderAccordionSection("heartbeat", "Heartbeat", html`
            <ic-agent-heartbeat-editor
              .form=${this._form}
              @field-change=${this._handleFieldChange}
            ></ic-agent-heartbeat-editor>
          `)}
          ${this._renderAccordionSection("advanced", "Advanced", html`
            <ic-agent-advanced-editor
              .form=${this._form}
              @field-change=${this._handleFieldChange}
            ></ic-agent-advanced-editor>
          `)}
          ${this._renderAccordionSection("contextEngine", "Context Engine", html`
            <ic-agent-context-engine-editor
              .form=${this._form}
              @field-change=${this._handleFieldChange}
            ></ic-agent-context-engine-editor>
          `)}
          ${this._renderAccordionSection("streaming", "Streaming (System-Wide)", html`
            <ic-agent-streaming-editor
              .config=${this._streamingConfig}
              @config-change=${this._handleConfigChange}
            ></ic-agent-streaming-editor>
          `)}
          ${this._renderAccordionSection("delivery", "Delivery (System-Wide)", html`
            <ic-agent-delivery-editor
              .deliveryQueueConfig=${this._deliveryQueueConfig}
              .deliveryMirrorConfig=${this._deliveryMirrorConfig}
              @config-change=${this._handleConfigChange}
            ></ic-agent-delivery-editor>
          `)}
          ${this._renderAccordionSection("queue", "Queue / Overflow (System-Wide)", html`
            <ic-agent-queue-editor
              .config=${this._queueConfig}
              @config-change=${this._handleConfigChange}
            ></ic-agent-queue-editor>
          `)}
          ${this._renderAccordionSection("autoReply", "Auto-Reply (System-Wide)", html`
            <ic-agent-auto-reply-editor
              .config=${this._autoReplyConfig}
              @config-change=${this._handleConfigChange}
            ></ic-agent-auto-reply-editor>
          `)}
          ${this._renderAccordionSection("sendPolicy", "Send Policy (System-Wide)", html`
            <ic-agent-send-policy-editor
              .config=${this._sendPolicyConfig}
              @config-change=${this._handleConfigChange}
            ></ic-agent-send-policy-editor>
          `)}
          ${this._renderAccordionSection("logLevel", "Log Levels (Runtime)", html`
            <ic-agent-log-level-editor
              .rpcClient=${this.rpcClient}
              .applied=${this._logLevelApplied}
              @log-level-change=${this._handleLogLevelChange}
            ></ic-agent-log-level-editor>
          `)}
        </div>
        <div class="yaml-panel">
          <div class="yaml-header">YAML Preview</div>
          <pre class="yaml-preview">${toYaml(this._buildYamlPreview())}</pre>
        </div>
      </div>

      <div class="save-bar">
        <div class="save-bar-left">
          <button
            class="btn btn--secondary"
            ?disabled=${this._validating}
            @click=${() => this._handleValidate()}
          >Validate</button>
          ${this._validationErrors.length > 0 ? html`
            <div class="validation-errors">
              ${this._validationErrors.map((err) => html`<span class="validation-error">${err}</span>`)}
            </div>
          ` : nothing}
          ${this._validationSuccess ? html`
            <span class="validation-success">Valid</span>
          ` : nothing}
        </div>
        <div class="save-bar-right">
          ${this._dirtyTracker.isDirty ? html`<span class="dirty-indicator">unsaved changes</span>` : nothing}
          <button
            class="btn btn--cancel"
            @click=${() => this._handleCancel()}
          >Cancel</button>
          <button
            class="btn btn--primary"
            ?disabled=${this._saving}
            @click=${() => this._handleSave()}
          >Save</button>
        </div>
      </div>
    `;
  }

  private _navigate(path: string): void {
    this.dispatchEvent(
      new CustomEvent("navigate", { detail: path, bubbles: true, composed: true }),
    );
  }

  // --- Accordion section helper ---

  private _renderAccordionSection(key: string, label: string, content: unknown) {
    return html`
      <div class="section-card">
        <details ?open=${this._expanded.has(key)} @toggle=${(e: Event) => this._handleToggle(key, e)}>
          <summary><span class="section-label">${label}</span></summary>
          <div class="section-content">
            ${content}
          </div>
        </details>
      </div>
    `;
  }

  private _handleToggle(key: string, e: Event): void {
    const details = e.target as HTMLDetailsElement;
    const newSet = new Set(this._expanded);
    if (details.open) {
      newSet.add(key);
    } else {
      newSet.delete(key);
    }
    this._expanded = newSet;
  }
}
