// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { SseController } from "../state/sse-controller.js";
import { IcToast } from "../components/feedback/ic-toast.js";

// Side-effect imports (register custom elements)
import "../components/nav/ic-tabs.js";
import "../components/feedback/ic-empty-state.js";
import "../components/feedback/ic-loading.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/data/ic-relative-time.js";
import "../components/display/ic-icon.js";
import "../components/data/ic-tag.js";
import "../components/scheduler/ic-cron-editor.js";

import type { CronJobInput } from "../components/scheduler/ic-cron-editor.js";
import type { TabDef } from "../components/nav/ic-tabs.js";

/* ------------------------------------------------------------------ */
/*  Local types -- DO NOT import from @comis/scheduler              */
/* ------------------------------------------------------------------ */

interface SchedulerCronJob {
  id: string;
  name: string;
  agentId: string;
  schedule: { kind: string; expr?: string; tz?: string; everyMs?: number; at?: string };
  payload: { kind: string; message?: string; text?: string };
  sessionTarget: string;
  enabled: boolean;
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  consecutiveErrors: number;
  createdAtMs: number;
  deliveryTarget?: {
    channelId: string;
    userId: string;
    tenantId: string;
    channelType?: string;
  };
}

interface ExecutionRecord {
  jobId: string;
  jobName: string;
  agentId: string;
  timestamp: number;
  success: boolean | "pending";
  durationMs?: number;
  error?: string;
}

interface HeartbeatRecord {
  checksRun: number;
  alertsRaised: number;
  timestamp: number;
}

interface ExtractedTask {
  taskId: string;
  title: string;
  priority: string;
  confidence: number;
  sessionKey: string;
  timestamp: number;
  status: "pending" | "completed" | "dismissed";
}

interface HeartbeatAgentCard {
  agentId: string;
  enabled: boolean;
  intervalMs: number;
  lastRunMs: number;
  nextDueMs: number;
  consecutiveErrors: number;
  backoffUntilMs: number;
  tickStartedAtMs: number;
  lastAlertMs: number;
  lastErrorKind: "transient" | "permanent" | null;
}

interface HeartbeatAlertRecord {
  agentId: string;
  classification: "transient" | "permanent";
  reason: string;
  consecutiveErrors: number;
  backoffMs: number;
  timestamp: number;
}

interface HeartbeatDeliveryRecord {
  agentId: string;
  channelType: string;
  outcome: "delivered" | "skipped" | "failed";
  level: "ok" | "alert" | "critical";
  reason?: string;
  durationMs: number;
  timestamp: number;
}

/* ------------------------------------------------------------------ */
/*  Tab definitions                                                    */
/* ------------------------------------------------------------------ */

const TAB_DEFS: TabDef[] = [
  { id: "cron-jobs", label: "Cron Jobs" },
  { id: "heartbeat", label: "Heartbeat" },
  { id: "extracted-tasks", label: "Extracted Tasks" },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatSchedule(schedule: SchedulerCronJob["schedule"]): string {
  switch (schedule.kind) {
    case "cron":
      return schedule.expr ?? "cron";
    case "every": {
      const ms = schedule.everyMs ?? 0;
      if (ms >= 3_600_000) return `Every ${Math.round(ms / 3_600_000)}h`;
      if (ms >= 60_000) return `Every ${Math.round(ms / 60_000)}m`;
      return `Every ${Math.round(ms / 1000)}s`;
    }
    case "at":
      return schedule.at ? new Date(schedule.at).toLocaleString() : "one-shot";
    default:
      return schedule.kind;
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(ts: number): string {
  if (ts <= 0) return "--";
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatIntervalMs(ms: number): string {
  if (ms >= 3_600_000) return `Every ${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `Every ${Math.round(ms / 60_000)}m`;
  return `Every ${Math.round(ms / 1000)}s`;
}

/**
 * Convert a SchedulerCronJob to CronJobInput for the ic-cron-editor.
 */
function jobToCronInput(job: SchedulerCronJob): CronJobInput {
  return {
    id: job.id,
    name: job.name,
    agentId: job.agentId,
    schedule: {
      kind: job.schedule.kind as "cron" | "every" | "at",
      expr: job.schedule.expr,
      tz: job.schedule.tz,
      everyMs: job.schedule.everyMs,
      at: job.schedule.at,
    },
    message: job.payload?.message ?? job.payload?.text ?? "",
    enabled: job.enabled,
    maxConcurrent: 1,
    sessionTarget: (job.sessionTarget ?? "main") as "main" | "isolated",
    deliveryTarget: job.deliveryTarget,
  };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

/**
 * Scheduler dashboard view with 3 tabs: Cron Jobs, Heartbeat, Extracted Tasks.
 *
 * Loads job data via cron.list RPC. Supports create/edit via ic-cron-editor overlay
 * (cron.add / cron.update RPC), delete via cron.remove RPC, heartbeat toggle via
 * config.read / config.set RPC, and real-time SSE updates for execution history,
 * heartbeat checks, and extracted tasks.
 */
@customElement("ic-scheduler-view")
export class IcSchedulerView extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .scheduler-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--ic-space-lg);
      }

      .scheduler-header h2 {
        margin: 0;
        font-size: var(--ic-text-lg);
        font-weight: 600;
        color: var(--ic-text);
      }

      .btn-primary {
        background: var(--ic-accent);
        color: #fff;
        border: none;
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm) var(--ic-space-lg);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        font-weight: 500;
        cursor: pointer;
        transition: background var(--ic-transition);
      }

      .btn-primary:hover {
        filter: brightness(1.1);
      }

      /* Error message */
      .error-message {
        color: var(--ic-error, #f87171);
        font-size: var(--ic-text-sm);
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: rgba(127, 29, 29, 0.12);
        border: 1px solid #7f1d1d;
        border-radius: var(--ic-radius-md);
        margin-bottom: var(--ic-space-md);
      }

      /* Job grid table (div-based for happy-dom compat) */
      .job-grid {
        display: grid;
        grid-template-columns: minmax(100px, 2fr) minmax(80px, 1fr) minmax(80px, 1fr) minmax(80px, 1fr) 80px minmax(60px, 1fr) auto;
        width: 100%;
      }

      .grid-header {
        display: contents;
      }

      .grid-header .cell {
        background: var(--ic-surface);
        padding: var(--ic-space-sm) var(--ic-space-md);
        font-size: var(--ic-text-xs);
        font-weight: 600;
        color: var(--ic-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border-bottom: 1px solid var(--ic-border);
      }

      .grid-row {
        display: contents;
        cursor: pointer;
      }

      .grid-row .cell {
        padding: var(--ic-space-sm) var(--ic-space-md);
        font-size: var(--ic-text-sm);
        border-bottom: 1px solid var(--ic-border);
        color: var(--ic-text);
        display: flex;
        align-items: center;
        transition: background var(--ic-transition);
      }

      .grid-row:hover .cell {
        background: var(--ic-surface-2);
      }

      /* Status dot */
      .status-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }

      .status-dot--active {
        background: #22c55e;
      }

      .status-dot--inactive {
        background: var(--ic-text-dim, #6b7280);
      }

      .status-dot--error {
        background: #ef4444;
      }

      .status-info {
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs);
      }

      .error-count {
        font-size: var(--ic-text-xs);
        color: #ef4444;
      }

      /* Delete button */
      .btn-delete {
        background: transparent;
        border: none;
        color: var(--ic-text-dim);
        font-size: var(--ic-text-xs);
        cursor: pointer;
        padding: 4px 8px;
        border-radius: var(--ic-radius-sm, 0.25rem);
        transition: color var(--ic-transition), background var(--ic-transition);
        font-family: inherit;
      }

      .btn-delete:hover {
        color: #ef4444;
        background: rgba(239, 68, 68, 0.1);
      }

      /* Run / Trigger action buttons */
      .btn-run {
        background: transparent;
        border: 1px solid var(--ic-accent);
        color: var(--ic-accent);
        font-size: var(--ic-text-xs);
        cursor: pointer;
        padding: 4px 8px;
        border-radius: var(--ic-radius-sm, 0.25rem);
        transition: color var(--ic-transition), background var(--ic-transition);
        font-family: inherit;
      }

      .btn-run:hover {
        background: var(--ic-accent);
        color: #fff;
      }

      .btn-run:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .btn-run:disabled:hover {
        background: transparent;
        color: var(--ic-accent);
      }

      .action-group {
        display: flex;
        gap: var(--ic-space-xs);
      }

      /* Recent executions */
      .executions-section {
        margin-top: var(--ic-space-xl, 2rem);
      }

      .executions-section h3 {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-muted);
        margin: 0 0 var(--ic-space-sm);
      }

      .execution-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .execution-entry {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        padding: var(--ic-space-xs) var(--ic-space-sm);
        font-size: var(--ic-text-xs);
        border-radius: var(--ic-radius-sm, 0.25rem);
      }

      .execution-entry:hover {
        background: var(--ic-surface);
      }

      .exec-timestamp {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        color: var(--ic-text-dim);
        min-width: 5rem;
      }

      .exec-job {
        color: var(--ic-text);
        font-weight: 500;
      }

      .exec-result--success {
        color: #22c55e;
      }

      .exec-result--fail {
        color: #ef4444;
      }

      .exec-result--pending {
        color: var(--ic-text-dim);
      }

      .exec-duration {
        color: var(--ic-text-dim);
      }

      .exec-error {
        color: var(--ic-text-dim);
        font-style: italic;
      }

      .no-data {
        color: var(--ic-text-dim);
        font-size: var(--ic-text-sm);
        padding: var(--ic-space-md) 0;
      }

      /* Heartbeat tab -- per-agent cards */
      .hb-summary-bar {
        display: flex;
        align-items: center;
        gap: var(--ic-space-md);
        padding: var(--ic-space-sm) 0 var(--ic-space-md);
        font-size: var(--ic-text-sm);
        color: var(--ic-text-dim);
      }

      .hb-summary-bar span {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
      }

      .hb-card-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: var(--ic-space-md);
      }

      .hb-card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
      }

      .hb-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--ic-space-sm);
      }

      .hb-card-agent {
        font-weight: 600;
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .hb-card-row {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      .hb-card-label {
        min-width: 70px;
        color: var(--ic-text-muted);
      }

      .hb-running-indicator {
        color: var(--ic-accent);
        font-size: var(--ic-text-xs);
        font-style: italic;
      }

      /* Recent alerts / deliveries */
      .hb-recent-section {
        margin-top: var(--ic-space-lg);
      }

      .hb-recent-section h3 {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-muted);
        margin: 0 0 var(--ic-space-sm);
      }

      .hb-event-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .hb-event-entry {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        padding: var(--ic-space-xs) var(--ic-space-sm);
        font-size: var(--ic-text-xs);
        border-radius: var(--ic-radius-sm, 0.25rem);
      }

      .hb-event-entry:hover {
        background: var(--ic-surface);
      }

      .hb-event-ts {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        color: var(--ic-text-dim);
        min-width: 5rem;
      }

      .hb-event-agent {
        font-weight: 500;
        color: var(--ic-text);
      }

      .hb-event-reason {
        color: var(--ic-text-dim);
        font-style: italic;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 20rem;
      }

      .hb-event-duration {
        color: var(--ic-text-dim);
      }

      .alerts-highlight {
        color: #ef4444;
        font-weight: 600;
      }

      /* Extracted tasks grid table */
      .task-grid {
        display: grid;
        grid-template-columns: minmax(150px, 3fr) 100px 100px auto;
        width: 100%;
      }

      .task-grid .grid-header .cell,
      .task-grid .grid-row .cell {
        /* Inherit from .grid-header/.grid-row above */
      }

      .priority-tag {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 9999px;
        font-size: var(--ic-text-xs);
        font-weight: 500;
      }

      .priority-tag--high {
        background: rgba(239, 68, 68, 0.15);
        color: #ef4444;
      }

      .priority-tag--medium {
        background: rgba(234, 179, 8, 0.15);
        color: #eab308;
      }

      .priority-tag--low {
        background: rgba(34, 197, 94, 0.15);
        color: #22c55e;
      }

      .btn-sm {
        background: transparent;
        border: 1px solid var(--ic-border);
        color: var(--ic-text-muted);
        font-size: var(--ic-text-xs);
        cursor: pointer;
        padding: 2px 8px;
        border-radius: var(--ic-radius-sm, 0.25rem);
        font-family: inherit;
        transition: color var(--ic-transition), border-color var(--ic-transition);
      }

      .btn-sm:hover {
        color: var(--ic-text);
        border-color: var(--ic-text-muted);
      }

      .task-actions {
        display: flex;
        gap: var(--ic-space-xs);
      }

      /* Editor overlay */
      .editor-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
      }

      .editor-panel {
        max-width: 32rem;
        width: 100%;
        max-height: 90vh;
        overflow-y: auto;
        margin: var(--ic-space-md);
      }

      .editor-error {
        color: #ef4444;
        font-size: var(--ic-text-sm);
        padding: var(--ic-space-sm);
        text-align: center;
      }

      /* Agent selector pills */
      .agent-selector {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        margin-bottom: var(--ic-space-md);
        flex-wrap: wrap;
      }

      .agent-selector-label {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        font-weight: 500;
      }

      .agent-pill {
        background: transparent;
        border: 1px solid var(--ic-border);
        border-radius: 9999px;
        padding: var(--ic-space-xs) var(--ic-space-md);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        color: var(--ic-text-muted);
        cursor: pointer;
        transition: background var(--ic-transition), border-color var(--ic-transition), color var(--ic-transition);
      }

      .agent-pill:hover {
        border-color: var(--ic-text-muted);
        color: var(--ic-text);
      }

      .agent-pill--active {
        background: var(--ic-accent);
        border-color: var(--ic-accent);
        color: #fff;
      }

      .agent-pill--active:hover {
        filter: brightness(1.1);
      }

      .agent-status {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        margin-bottom: var(--ic-space-sm);
      }

      .agent-status .status-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
    `,
  ];

  /* ---- Public properties ---- */

  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property({ attribute: false }) routeParams: Record<string, string> = {};
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  /* ---- Internal state ---- */

  @state() private _jobs: SchedulerCronJob[] = [];
  @state() private _loading = true;
  @state() private _error = "";
  @state() private _activeTab = "cron-jobs";
  @state() private _executions: ExecutionRecord[] = [];
  @state() private _heartbeats: HeartbeatRecord[] = [];
  @state() private _heartbeatEnabled = false;
  @state() private _heartbeatIntervalMs = 300_000;
  @state() private _extractedTasks: ExtractedTask[] = [];
  @state() private _editorOpen = false;
  @state() private _editingJob: SchedulerCronJob | null = null;
  @state() private _editorError = "";
  @state() private _configAgentIds: string[] = [];
  @state() private _selectedAgentId = "";
  @state() private _cronEnabled: boolean | null = null;
  @state() private _cronJobCount = 0;
  @state() private _heartbeatAgents: HeartbeatAgentCard[] = [];
  @state() private _heartbeatAlerts: HeartbeatAlertRecord[] = [];
  @state() private _heartbeatDeliveries: HeartbeatDeliveryRecord[] = [];

  private _rpcStatusUnsubs: (() => void)[] = [];
  private _sse: SseController | null = null;
  private _jobsLoaded = false;

  /* ---- Lifecycle ---- */

  override connectedCallback(): void {
    super.connectedCallback();
    // Note: _loadAll() is NOT called here -- rpcClient is typically
    // null at this point. The updated() callback handles loading once
    // the client property is set.
    this._initSse();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const unsub of this._rpcStatusUnsubs) {
      unsub();
    }
    this._rpcStatusUnsubs = [];
  }

  override updated(changed: Map<string, unknown>): void {
    // Retry data loading when rpcClient is set after initial render
    if (changed.has("rpcClient") && this.rpcClient && !this._jobsLoaded) {
      this._loadAll();
      const unsub = this.rpcClient.onStatusChange((status) => {
        if (status === "connected" && !this._jobsLoaded) {
          this._error = "";
          this._loadAll();
        }
      });
      this._rpcStatusUnsubs.push(unsub);
    }
    // Auto-open editor for specific job from route params
    if (
      (changed.has("routeParams") || changed.has("_jobs")) &&
      this.routeParams.jobId &&
      this._jobsLoaded
    ) {
      const job = this._jobs.find((j) => j.id === this.routeParams.jobId);
      if (job && !this._editorOpen) {
        this._editingJob = job;
        this._editorOpen = true;
        this._editorError = "";
      }
    }
    if (changed.has("eventDispatcher") && this.eventDispatcher && !this._sse) {
      this._initSse();
    }
  }

  /* ---- SSE subscription via SseController ---- */

  private _initSse(): void {
    if (!this.eventDispatcher || this._sse) return;
    this._sse = new SseController(this, this.eventDispatcher, {
      "scheduler:job_started": (data) => {
        const d = data as { jobId: string; jobName?: string; agentId?: string; timestamp?: number };
        const record: ExecutionRecord = {
          jobId: d.jobId,
          jobName: d.jobName ?? d.jobId,
          agentId: d.agentId ?? "",
          timestamp: d.timestamp ?? Date.now(),
          success: "pending",
        };
        this._executions = [record, ...this._executions].slice(0, 50);
      },
      "scheduler:job_completed": (data) => {
        const d = data as { jobId: string; jobName?: string; agentId?: string; timestamp?: number; success?: boolean; durationMs?: number; error?: string };
        const pendingIdx = this._executions.findIndex(
          (r) => r.jobId === d.jobId && r.success === "pending",
        );
        if (pendingIdx >= 0) {
          const updated = [...this._executions];
          updated[pendingIdx] = {
            ...updated[pendingIdx],
            success: d.success ?? true,
            durationMs: d.durationMs,
            error: d.error,
            timestamp: d.timestamp ?? updated[pendingIdx].timestamp,
          };
          this._executions = updated;
        } else {
          const record: ExecutionRecord = {
            jobId: d.jobId,
            jobName: d.jobName ?? d.jobId,
            agentId: d.agentId ?? "",
            timestamp: d.timestamp ?? Date.now(),
            success: d.success ?? true,
            durationMs: d.durationMs,
            error: d.error,
          };
          this._executions = [record, ...this._executions].slice(0, 50);
        }
      },
      "scheduler:heartbeat_delivered": (data) => {
        const d = data as { agentId?: string; channelType?: string; outcome?: string; level?: string; reason?: string; durationMs?: number; timestamp?: number };
        const record: HeartbeatDeliveryRecord = {
          agentId: d.agentId ?? "",
          channelType: d.channelType ?? "",
          outcome: (d.outcome as "delivered" | "skipped" | "failed") ?? "delivered",
          level: (d.level as "ok" | "alert" | "critical") ?? "ok",
          reason: d.reason,
          durationMs: d.durationMs ?? 0,
          timestamp: d.timestamp ?? Date.now(),
        };
        this._heartbeatDeliveries = [record, ...this._heartbeatDeliveries].slice(0, 50);
      },
      "scheduler:heartbeat_alert": (data) => {
        const d = data as { agentId?: string; consecutiveErrors?: number; classification?: string; reason?: string; backoffMs?: number; timestamp?: number };
        const record: HeartbeatAlertRecord = {
          agentId: d.agentId ?? "",
          classification: (d.classification as "transient" | "permanent") ?? "transient",
          reason: d.reason ?? "",
          consecutiveErrors: d.consecutiveErrors ?? 0,
          backoffMs: d.backoffMs ?? 0,
          timestamp: d.timestamp ?? Date.now(),
        };
        this._heartbeatAlerts = [record, ...this._heartbeatAlerts].slice(0, 50);
        this._updateAgentFromAlert(record);
      },
      "scheduler:task_extracted": (data) => {
        const d = data as { taskId?: string; title?: string; priority?: string; confidence?: number; sessionKey?: string; timestamp?: number };
        const task: ExtractedTask = {
          taskId: d.taskId ?? `task-${Date.now()}`,
          title: d.title ?? "Untitled task",
          priority: d.priority ?? "medium",
          confidence: d.confidence ?? 0,
          sessionKey: d.sessionKey ?? "",
          timestamp: d.timestamp ?? Date.now(),
          status: "pending",
        };
        this._extractedTasks = [task, ...this._extractedTasks];
      },
    });
  }

  /* ---- Data loading ---- */

  private _loadAll(): void {
    // Agent IDs must resolve first - _selectedAgentId gates _loadJobs and _loadCronStatus.
    // Heartbeat loads are independent and can run in parallel.
    this._loadAgentIds().then(() => {
      Promise.allSettled([
        this._loadJobs(),
        this._loadCronStatus(),
      ]);
    });
    // These don't depend on _selectedAgentId - fire immediately
    Promise.allSettled([
      this._loadHeartbeatConfig(),
      this._loadHeartbeatStates(),
    ]);
  }

  private async _loadJobs(): Promise<void> {
    if (!this.rpcClient) {
      this._loading = false;
      return;
    }
    try {
      const result = await this.rpcClient.call<{ jobs: SchedulerCronJob[] } | SchedulerCronJob[]>("cron.list", {
        _agentId: this._selectedAgentId || undefined,
      });
      this._jobs = Array.isArray(result) ? result : (result.jobs ?? []);
      this._jobsLoaded = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load jobs";
      if (msg.includes("not enabled")) {
        this._cronEnabled = false;
        this._error = "";
      } else {
        this._error = msg;
      }
    } finally {
      this._loading = false;
    }
  }

  private async _loadHeartbeatConfig(): Promise<void> {
    if (!this.rpcClient) return;
    try {
      const config = await this.rpcClient.call<Record<string, unknown>>("config.read", { section: "scheduler" });
      const heartbeat = config?.heartbeat as { enabled?: boolean; intervalMs?: number } | undefined;
      if (heartbeat) {
        this._heartbeatEnabled = heartbeat.enabled ?? false;
        this._heartbeatIntervalMs = heartbeat.intervalMs ?? 300_000;
      }
    } catch {
      // config.read may not exist in all deployments -- silently ignore
    }
  }

  private async _loadAgentIds(): Promise<void> {
    if (!this.rpcClient) return;
    try {
      const config = await this.rpcClient.call<Record<string, unknown>>("config.read", { section: "agents" });
      if (config && typeof config === "object") {
        this._configAgentIds = Object.keys(config);
      }
    } catch {
      // silently ignore -- agent dropdown will derive from existing jobs
    }
    if (this._configAgentIds.length > 0 && !this._selectedAgentId) {
      this._selectedAgentId = this._configAgentIds[0];
    }
  }

  private async _loadCronStatus(): Promise<void> {
    if (!this.rpcClient || !this._selectedAgentId) return;
    try {
      const result = await this.rpcClient.call<{ running: boolean; jobCount: number }>(
        "cron.status", { _agentId: this._selectedAgentId },
      );
      this._cronEnabled = result?.running ?? null;
      this._cronJobCount = result?.jobCount ?? 0;
    } catch {
      this._cronEnabled = null;
    }
  }

  private async _loadHeartbeatStates(): Promise<void> {
    if (!this.rpcClient) return;
    try {
      const result = await this.rpcClient.call<{ agents: HeartbeatAgentCard[] }>(
        "heartbeat.states", {},
      );
      this._heartbeatAgents = result?.agents ?? [];
    } catch {
      // heartbeat.states may not exist in older daemons -- silently ignore
    }
  }

  private _updateAgentFromAlert(alert: HeartbeatAlertRecord): void {
    const idx = this._heartbeatAgents.findIndex(a => a.agentId === alert.agentId);
    if (idx < 0) return;
    const updated = [...this._heartbeatAgents];
    updated[idx] = {
      ...updated[idx],
      consecutiveErrors: alert.consecutiveErrors,
      lastAlertMs: alert.timestamp,
      lastErrorKind: alert.classification,
    };
    this._heartbeatAgents = updated;
  }

  private _onAgentSelect(agentId: string): void {
    if (agentId === this._selectedAgentId) return;
    this._selectedAgentId = agentId;
    this._jobs = [];
    this._executions = [];
    this._error = "";
    this._loading = true;
    this._jobsLoaded = false;
    this._loadJobs();
    this._loadCronStatus();
  }

  /* ---- CRUD methods ---- */

  private async _handleEditorSave(e: CustomEvent<CronJobInput>): Promise<void> {
    if (!this.rpcClient) return;
    const jobData = e.detail;
    this._editorError = "";

    if (this._editingJob) {
      // Edit mode -- optimistic update
      const originalJobs = [...this._jobs];
      const idx = this._jobs.findIndex((j) => j.id === this._editingJob!.id);
      if (idx >= 0) {
        const updatedJob: SchedulerCronJob = {
          ...this._jobs[idx],
          name: jobData.name,
          agentId: jobData.agentId,
          schedule: jobData.schedule,
          payload: { kind: "agent_turn", message: jobData.message },
          sessionTarget: jobData.sessionTarget,
          enabled: jobData.enabled,
          deliveryTarget: jobData.deliveryTarget,
        };
        const updated = [...this._jobs];
        updated[idx] = updatedJob;
        this._jobs = updated;
      }
      try {
        await this.rpcClient.call("cron.update", { jobId: this._editingJob.id, _agentId: this._selectedAgentId, ...jobData });
        this._editorOpen = false;
        this._editingJob = null;
      } catch (err) {
        this._jobs = originalJobs;
        this._editorError = err instanceof Error ? err.message : "Failed to update job";
      }
    } else {
      // Create mode -- optimistic update
      const tempJob: SchedulerCronJob = {
        id: jobData.id,
        name: jobData.name,
        agentId: jobData.agentId,
        schedule: jobData.schedule,
        payload: { kind: "agent_turn", message: jobData.message },
        sessionTarget: jobData.sessionTarget,
        enabled: jobData.enabled,
        consecutiveErrors: 0,
        createdAtMs: Date.now(),
        deliveryTarget: jobData.deliveryTarget,
      };
      this._jobs = [...this._jobs, tempJob];
      try {
        const result = await this.rpcClient.call<{ jobId: string }>("cron.add", { ...jobData, _agentId: this._selectedAgentId, _deliveryTarget: jobData.deliveryTarget });
        // Update the temp job with the server-returned ID if different
        if (result?.jobId && result.jobId !== tempJob.id) {
          const idx = this._jobs.findIndex((j) => j.id === tempJob.id);
          if (idx >= 0) {
            const updated = [...this._jobs];
            updated[idx] = { ...updated[idx], id: result.jobId };
            this._jobs = updated;
          }
        }
        this._editorOpen = false;
        this._editingJob = null;
      } catch (err) {
        this._jobs = this._jobs.filter((j) => j.id !== tempJob.id);
        this._editorError = err instanceof Error ? err.message : "Failed to create job";
      }
    }
  }

  private async _handleDeleteJob(jobId: string): Promise<void> {
    if (!this.rpcClient) return;
    if (!window.confirm("Delete this job?")) return;

    const originalJobs = [...this._jobs];
    this._jobs = this._jobs.filter((j) => j.id !== jobId);

    try {
      await this.rpcClient.call("cron.remove", { jobId, _agentId: this._selectedAgentId });
    } catch (err) {
      this._jobs = originalJobs;
      this._error = err instanceof Error ? err.message : "Failed to delete job";
    }
  }

  private async _handleToggleHeartbeat(): Promise<void> {
    if (!this.rpcClient) return;
    const newValue = !this._heartbeatEnabled;
    this._heartbeatEnabled = newValue;
    try {
      await this.rpcClient.call("config.set", {
        section: "scheduler",
        path: "heartbeat.enabled",
        value: newValue,
      });
    } catch (err) {
      this._heartbeatEnabled = !newValue;
      this._error = err instanceof Error ? err.message : "Failed to toggle heartbeat";
    }
  }

  private _handleCompleteTask(taskId: string): void {
    this._extractedTasks = this._extractedTasks.map((t) =>
      t.taskId === taskId ? { ...t, status: "completed" as const } : t,
    );
  }

  private _handleDismissTask(taskId: string): void {
    this._extractedTasks = this._extractedTasks.map((t) =>
      t.taskId === taskId ? { ...t, status: "dismissed" as const } : t,
    );
  }

  private async _handleRunJob(jobName: string): Promise<void> {
    if (!this.rpcClient) return;
    try {
      await this.rpcClient.call("cron.run", { jobName, _agentId: this._selectedAgentId });
      IcToast.show("Job triggered", "success");
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to run job";
    }
  }

  private async _handleTriggerHeartbeat(agentId: string): Promise<void> {
    if (!this.rpcClient) return;
    try {
      await this.rpcClient.call("heartbeat.trigger", { agentId });
      IcToast.show("Heartbeat triggered for " + agentId, "success");
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to trigger heartbeat";
    }
  }

  /* ---- Editor helpers ---- */

  private _openCreateEditor(): void {
    this._editingJob = null;
    this._editorOpen = true;
    this._editorError = "";
  }

  private _openEditEditor(job: SchedulerCronJob): void {
    this._editingJob = job;
    this._editorOpen = true;
    this._editorError = "";
  }

  private _closeEditor(): void {
    this._editorOpen = false;
    this._editingJob = null;
    this._editorError = "";
  }

  private _closeEditorOnBackdrop(e: Event): void {
    if (e.target === e.currentTarget) {
      this._closeEditor();
    }
  }

  private _onTabChange(e: CustomEvent<string>): void {
    this._activeTab = e.detail;
  }

  /* ---- Computed getters ---- */

  private get _editingJobInput(): CronJobInput | null {
    if (!this._editingJob) return null;
    return jobToCronInput(this._editingJob);
  }

  private get _agentIds(): string[] {
    const ids = new Set([...this._configAgentIds, ...this._jobs.map((j) => j.agentId)]);
    const arr = Array.from(ids);
    // Put selected agent first so cron editor defaults to it
    if (this._selectedAgentId) {
      const idx = arr.indexOf(this._selectedAgentId);
      if (idx > 0) {
        arr.splice(idx, 1);
        arr.unshift(this._selectedAgentId);
      }
    }
    return arr;
  }

  /* ---- Render ---- */

  private _renderAgentSelector() {
    if (this._configAgentIds.length <= 1 && this._jobs.length === 0) return nothing;

    return html`
      <div class="agent-selector" role="radiogroup" aria-label="Select agent">
        <span class="agent-selector-label">Agent:</span>
        ${this._configAgentIds.map(
          (id) => html`
            <button
              class="agent-pill ${id === this._selectedAgentId ? "agent-pill--active" : ""}"
              role="radio"
              aria-checked=${id === this._selectedAgentId ? "true" : "false"}
              @click=${() => this._onAgentSelect(id)}
            >${id}</button>
          `,
        )}
      </div>
    `;
  }

  private _renderAgentStatus() {
    if (this._cronEnabled === null) return nothing;

    const dotClass = this._cronEnabled ? "status-dot status-dot--active" : "status-dot status-dot--inactive";
    const label = this._cronEnabled
      ? `Cron scheduler running (${this._cronJobCount} job${this._cronJobCount !== 1 ? "s" : ""})`
      : `Cron scheduler not enabled for '${this._selectedAgentId}'`;

    return html`
      <div class="agent-status">
        <span class=${dotClass}></span>
        <span>${label}</span>
      </div>
    `;
  }

  private _renderJobRow(job: SchedulerCronJob) {
    const dotClass = job.enabled
      ? job.consecutiveErrors > 0 ? "status-dot status-dot--error" : "status-dot status-dot--active"
      : "status-dot status-dot--inactive";
    return html`
      <div class="grid-row" role="row" @click=${() => this._openEditEditor(job)}>
        <div class="cell" role="cell">${job.name || job.id}</div>
        <div class="cell" role="cell">${formatSchedule(job.schedule)}</div>
        <div class="cell" role="cell">
          ${job.lastRunAtMs && job.lastRunAtMs > 0
            ? html`<ic-relative-time .timestamp=${job.lastRunAtMs}></ic-relative-time>`
            : "Never"}
        </div>
        <div class="cell" role="cell">
          ${job.enabled && job.nextRunAtMs && job.nextRunAtMs > 0
            ? html`<ic-relative-time .timestamp=${job.nextRunAtMs}></ic-relative-time>`
            : "(off)"}
        </div>
        <div class="cell" role="cell">
          <span class="status-info">
            <span class=${dotClass}></span>
            ${job.consecutiveErrors > 0
              ? html`<span class="error-count">${job.consecutiveErrors} errors</span>`
              : nothing}
          </span>
        </div>
        <div class="cell" role="cell">
          ${job.deliveryTarget
            ? html`<ic-tag variant="info">${job.deliveryTarget.channelType ?? "channel"}</ic-tag>`
            : html`<span style="color:var(--ic-text-dim)">local</span>`}
        </div>
        <div class="cell" role="cell">
          <div class="action-group">
            <button
              class="btn-run"
              ?disabled=${!job.enabled}
              title=${job.enabled ? "Execute this job now" : "Enable job to run"}
              @click=${(e: Event) => {
                e.stopPropagation();
                this._handleRunJob(job.name || job.id);
              }}
            >Run</button>
            <button
              class="btn-edit"
              title="Edit this job"
              @click=${(e: Event) => {
                e.stopPropagation();
                this._openEditEditor(job);
              }}
            >Edit</button>
            <button
              class="btn-delete"
              @click=${(e: Event) => {
                e.stopPropagation();
                this._handleDeleteJob(job.id);
              }}
            >Delete</button>
          </div>
        </div>
      </div>
    `;
  }

  private _renderCronJobsTab() {
    return html`
      ${this._renderAgentSelector()}
      ${this._renderAgentStatus()}
      ${this._loading
        ? html`<ic-skeleton-view variant="list"></ic-skeleton-view>`
        : this._jobs.length === 0
          ? html`
              <ic-empty-state
                icon="clock"
                message="No scheduled jobs"
                description="Configure cron jobs or heartbeat checks for your agents."
              >
                <button class="cta-btn" style="background:var(--ic-accent);color:#fff;border:none;border-radius:var(--ic-radius-md);padding:0.5rem 1rem;cursor:pointer;font-family:inherit;font-size:var(--ic-text-sm)" @click=${() => { window.location.hash = "#/config"; }}>Open Settings</button>
              </ic-empty-state>
            `
          : html`
              <div class="job-grid" role="table">
                <div class="grid-header" role="row">
                  <div class="cell" role="columnheader">Name</div>
                  <div class="cell" role="columnheader">Schedule</div>
                  <div class="cell" role="columnheader">Last Run</div>
                  <div class="cell" role="columnheader">Next Run</div>
                  <div class="cell" role="columnheader">Status</div>
                  <div class="cell" role="columnheader">Deliver</div>
                  <div class="cell" role="columnheader">Actions</div>
                </div>
                ${this._jobs.map((job) => this._renderJobRow(job))}
              </div>

              ${this._renderRecentExecutions()}
            `}
    `;
  }

  private _renderRecentExecutions() {
    return html`
      <div class="executions-section">
        <h3>Recent Executions</h3>
        ${this._executions.length === 0
          ? html`<div class="no-data">No recent executions</div>`
          : html`
              <div class="execution-list">
                ${this._executions.map(
                  (exec) => html`
                    <div class="execution-entry">
                      <span class="exec-timestamp">${formatTimestamp(exec.timestamp)}</span>
                      <span class="exec-job">${exec.jobName || exec.jobId}</span>
                      <span class=${exec.success === "pending"
                        ? "exec-result--pending"
                        : exec.success
                          ? "exec-result--success"
                          : "exec-result--fail"}>${exec.success === "pending" ? "..." : exec.success ? "OK" : "FAIL"}</span>
                      ${exec.durationMs != null
                        ? html`<span class="exec-duration">(${formatMs(exec.durationMs)})</span>`
                        : nothing}
                      ${exec.error
                        ? html`<span class="exec-error">${exec.error}</span>`
                        : nothing}
                    </div>
                  `,
                )}
              </div>
            `}
      </div>
    `;
  }

  private _renderHeartbeatTab() {
    if (this._heartbeatAgents.length === 0) {
      // Fall back to global heartbeat info if no per-agent data
      if (this._heartbeatEnabled || this._heartbeats.length > 0) {
        return html`
          <div class="hb-summary-bar">
            <span>Global heartbeat: ${this._heartbeatEnabled ? "enabled" : "disabled"}</span>
            <span>Interval: ${formatIntervalMs(this._heartbeatIntervalMs)}</span>
          </div>
          <ic-empty-state
            icon="scheduler"
            message="No heartbeat agents"
            description="Configure heartbeat in agent settings to see per-agent status."
          ></ic-empty-state>
        `;
      }
      return html`
        <ic-empty-state
          icon="scheduler"
          message="No heartbeat agents"
          description="Configure heartbeat in agent settings to see per-agent status."
        ></ic-empty-state>
      `;
    }

    const now = Date.now();
    const enabledCount = this._heartbeatAgents.filter(a => a.enabled).length;
    const backoffCount = this._heartbeatAgents.filter(a => a.backoffUntilMs > now).length;
    const errorCount = this._heartbeatAgents.filter(a => a.consecutiveErrors > 0).length;

    return html`
      <div class="hb-summary-bar">
        <span>${enabledCount} agent${enabledCount !== 1 ? "s" : ""} enabled</span>
        ${backoffCount > 0
          ? html`<span class="alerts-highlight">${backoffCount} in backoff</span>`
          : nothing}
        ${errorCount > 0
          ? html`<span class="alerts-highlight">${errorCount} with errors</span>`
          : nothing}
      </div>

      <div class="hb-card-grid">
        ${this._heartbeatAgents.map(agent => this._renderHeartbeatCard(agent, now))}
      </div>

      ${this._heartbeatAlerts.length > 0
        ? html`
            <div class="hb-recent-section">
              <h3>Recent Alerts</h3>
              <div class="hb-event-list">
                ${this._heartbeatAlerts.slice(0, 20).map(
                  alert => html`
                    <div class="hb-event-entry">
                      <span class="hb-event-ts">${formatTimestamp(alert.timestamp)}</span>
                      <span class="hb-event-agent">${alert.agentId}</span>
                      <ic-tag variant=${alert.classification === "permanent" ? "error" : "warning"}>${alert.classification}</ic-tag>
                      <span class="hb-event-reason">${alert.reason}</span>
                      ${alert.backoffMs > 0 ? html`<span class="hb-event-duration">(backoff ${formatIntervalMs(alert.backoffMs)})</span>` : nothing}
                    </div>
                  `,
                )}
              </div>
            </div>
          `
        : nothing}

      ${this._heartbeatDeliveries.length > 0
        ? html`
            <div class="hb-recent-section">
              <h3>Recent Deliveries</h3>
              <div class="hb-event-list">
                ${this._heartbeatDeliveries.slice(0, 20).map(
                  del => html`
                    <div class="hb-event-entry">
                      <span class="hb-event-ts">${formatTimestamp(del.timestamp)}</span>
                      <span class="hb-event-agent">${del.agentId}</span>
                      <ic-tag variant=${del.outcome === "delivered" ? "success" : del.outcome === "failed" ? "error" : "warning"}>${del.outcome}</ic-tag>
                      <span>${del.channelType}</span>
                      <span class="hb-event-duration">(${formatMs(del.durationMs)})</span>
                    </div>
                  `,
                )}
              </div>
            </div>
          `
        : nothing}
    `;
  }

  private _renderHeartbeatCard(agent: HeartbeatAgentCard, now: number) {
    const inBackoff = agent.backoffUntilMs > now;
    const hasErrors = agent.consecutiveErrors > 0;
    const isRunning = agent.tickStartedAtMs > 0;

    let statusLabel: string;
    let statusVariant: string;
    if (!agent.enabled) {
      statusLabel = "disabled";
      statusVariant = "default";
    } else if (inBackoff) {
      statusLabel = "backoff";
      statusVariant = "warning";
    } else if (hasErrors) {
      statusLabel = "error";
      statusVariant = "error";
    } else {
      statusLabel = "healthy";
      statusVariant = "success";
    }

    return html`
      <div class="hb-card">
        <div class="hb-card-header">
          <span class="hb-card-agent">${agent.agentId}</span>
          <ic-tag variant=${statusVariant}>${statusLabel}</ic-tag>
        </div>
        <div class="hb-card-row">
          <span class="hb-card-label">Interval:</span>
          <span>${formatIntervalMs(agent.intervalMs)}</span>
        </div>
        <div class="hb-card-row">
          <span class="hb-card-label">Last run:</span>
          ${agent.lastRunMs > 0
            ? html`<ic-relative-time .timestamp=${agent.lastRunMs}></ic-relative-time>`
            : html`<span>--</span>`}
        </div>
        <div class="hb-card-row">
          <span class="hb-card-label">Next due:</span>
          ${agent.nextDueMs > 0
            ? html`<ic-relative-time .timestamp=${agent.nextDueMs}></ic-relative-time>`
            : html`<span>--</span>`}
        </div>
        ${hasErrors
          ? html`
              <div class="hb-card-row">
                <span class="hb-card-label">Errors:</span>
                <span class="alerts-highlight">${agent.consecutiveErrors}${agent.lastErrorKind ? ` (${agent.lastErrorKind})` : ""}</span>
              </div>
            `
          : nothing}
        ${isRunning
          ? html`<span class="hb-running-indicator">running...</span>`
          : nothing}
        <button
          class="btn-run"
          ?disabled=${!agent.enabled}
          title=${agent.enabled ? "Trigger heartbeat check now" : "Enable heartbeat to trigger"}
          @click=${() => this._handleTriggerHeartbeat(agent.agentId)}
          style="margin-top:var(--ic-space-xs);align-self:flex-start"
        >Trigger</button>
      </div>
    `;
  }

  private _renderExtractedTasksTab() {
    if (this._extractedTasks.length === 0) {
      return html`
        <ic-empty-state
          icon="scheduler"
          message="No extracted tasks"
          description="Tasks will appear when agents extract them from conversations."
        ></ic-empty-state>
      `;
    }

    return html`
      <div class="task-grid" role="table">
        <div class="grid-header" role="row">
          <div class="cell" role="columnheader">Title</div>
          <div class="cell" role="columnheader">Priority</div>
          <div class="cell" role="columnheader">Status</div>
          <div class="cell" role="columnheader">Actions</div>
        </div>
        ${this._extractedTasks.map((task) => this._renderTaskRow(task))}
      </div>
    `;
  }

  private _renderTaskRow(task: ExtractedTask) {
    const priorityClass = `priority-tag priority-tag--${task.priority}`;
    return html`
      <div class="grid-row" role="row">
        <div class="cell" role="cell">${task.title}</div>
        <div class="cell" role="cell">
          <span class=${priorityClass}>${task.priority}</span>
        </div>
        <div class="cell" role="cell">${task.status}</div>
        <div class="cell" role="cell">
          ${task.status === "pending"
            ? html`
                <div class="task-actions">
                  <button class="btn-sm btn-complete" @click=${() => this._handleCompleteTask(task.taskId)}>Complete</button>
                  <button class="btn-sm btn-dismiss" @click=${() => this._handleDismissTask(task.taskId)}>Dismiss</button>
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  private _renderEditorOverlay() {
    if (!this._editorOpen) return nothing;

    return html`
      <div class="editor-overlay" @click=${this._closeEditorOnBackdrop}>
        <div class="editor-panel" @click=${(e: Event) => e.stopPropagation()}>
          <ic-cron-editor
            .job=${this._editingJobInput}
            .mode=${this._editingJob ? "edit" : "create"}
            .agents=${this._agentIds}
            @save=${this._handleEditorSave}
            @cancel=${() => this._closeEditor()}
          ></ic-cron-editor>
          ${this._editorError
            ? html`<div class="editor-error">${this._editorError}</div>`
            : nothing}
        </div>
      </div>
    `;
  }

  override render() {
    return html`
      <div class="scheduler-header">
        <h2>Scheduler</h2>
        <button class="btn-primary" @click=${() => this._openCreateEditor()}>+ New Job</button>
      </div>

      ${this._error ? html`<div class="error-message">${this._error}</div>` : nothing}

      <ic-tabs
        .tabs=${TAB_DEFS}
        .activeTab=${this._activeTab}
        @tab-change=${this._onTabChange}
      >
        <div slot="cron-jobs">${this._renderCronJobsTab()}</div>
        <div slot="heartbeat">${this._renderHeartbeatTab()}</div>
        <div slot="extracted-tasks">${this._renderExtractedTasksTab()}</div>
      </ic-tabs>

      ${this._renderEditorOverlay()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-scheduler-view": IcSchedulerView;
  }
}
