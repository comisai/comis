// SPDX-License-Identifier: Apache-2.0
import type { BackgroundTaskOrigin } from "../domain/background-task-origin.js";
import type { McpServerEntry } from "../config/schema-integrations.js";
import type { InjectionRule } from "../security/provider-catalog/index.js";

/**
 * InfraEvents: Config, plugin, hook, auth, diagnostic,
 * media, scheduler, system, and metrics events.
 *
 * Find events by prefix: approval:*, config:*, plugin:*, hook:*, auth:*,
 * diagnostic:*, media:*, scheduler:*, observability:metrics, system:*
 */
export interface InfraEvents {
  // -------------------------------------------------------------------------
  // Approval gate events
  // -------------------------------------------------------------------------

  /** A privileged action requires operator approval before proceeding */
  "approval:requested": {
    requestId: string;
    /**
     * Short, renderer-safe approval id (12-char base62) minted by the
     * approval gate. REQUIRED on the event so renderer prompts and the
     * `/approve <id>` / `/deny <id>` slash commands share the same id, and
     * the full `requestId` never reaches renderers (§4.2, §6.4.1).
     *
     * Build coupling: the SOLE emit site that mints + supplies `shortId`
     * lives in `approval/approval-gate.ts` — this schema only declares the
     * required field.
     */
    shortId: string;
    toolName: string;
    action: string;
    params: Record<string, unknown>;
    agentId: string;
    sessionKey: string;
    trustLevel: string;
    createdAt: number;
    timeoutMs: number;
    /** Distributed trace id when the request is created inside a request
     *  context. Optional — `restorePending()` preserves `shortId` but may
     *  omit `traceId` after a graceful restart (§4.2). */
    traceId?: string;
    /** Channel type of the originating request (e.g., "telegram", "discord"). Used by the activity-renderer approval path. */
    channelType?: string;
  };

  /** An approval request was resolved (approved, denied, or timed out) */
  "approval:resolved": {
    requestId: string;
    approved: boolean;
    approvedBy: string;
    reason?: string;
    resolvedAt: number;
  };

  /** Config patch applied via RPC */
  "config:patched": {
    section: string;
    key?: string;
    patchedBy: string;
    timestamp: number;
  };

  /**
   * In-memory config subtree replaced atomically after a successful
   * skipRestart-true persist. Coalesced with 500ms trailing-edge debounce
   * so bulk operations (e.g. skill-install adding N MCPs) produce ONE event
   * with combined diffs.
   *
   * - `path`: the subtree key that was swapped. Closed literal union;
   *   additional swap paths may be added in future.
   * - `added`: McpServerEntry[] inserted into integrations.mcp.servers since
   *   last emit.
   * - `removed`: McpServerEntry[] removed from integrations.mcp.servers since
   *   last emit.
   * - `timestamp`: ms-epoch of the emit (NOT the underlying persist -- the
   *   debounce delays it by up to 500ms).
   */
  "config:mutated": {
    path: "integrations.mcp.servers";
    added: McpServerEntry[];
    removed: McpServerEntry[];
    timestamp: number;
  };

  // Three plugin / hook lifecycle event-bus events were removed from this
  // map. They had zero non-test subscribers; the only emit sites were
  // inside PluginRegistry and HookRunner themselves. Plugin lifecycle is
  // now consumed exclusively through the in-tree PluginRegistry interface
  // (register / unregister / getHooksByName / deactivateAll).

  // -------------------------------------------------------------------------
  // Auth events
  // -------------------------------------------------------------------------

  /** Provider auth token rotated (OAuth refresh) */
  "auth:token_rotated": {
    provider: string;
    /** Canonical "<provider>:<identity>" form. */
    profileId: string;
    expiresAtMs: number;
    timestamp: number;
  };

  /**
   * OAuth profile bootstrapped from environment variable on first
   * store-empty access. Fires once per process per provider.
   */
  "auth:profile_bootstrapped": {
    provider: string;
    profileId: string;
    /** Semi-redacted email (e.g. "mo…e@gmail.com") or "id-<base64url>" fallback. */
    identity: string;
    timestamp: number;
  };

  /**
   * OAuth profile added to the credential store by an external writer
   * (CLI `auth login` or wizard step 04). Emitted by OAuthTokenManager's
   * file watcher after a chokidar `change`/`add` event invalidates the
   * cache and the store list reveals a new profile.
   *
   * `source: "external"` indicates the writer is outside this manager
   * instance.
   */
  "auth:profile_added": {
    provider: string;
    profileId: string;
    /** Semi-redacted email (e.g. "mo…e@gmail.com") or "id-<base64url>" fallback. */
    identity: string;
    source: "external";
    timestamp: number;
  };

  /**
   * OAuth refresh failed terminally (e.g. refresh_token_reused, network
   * error after retries, timeout). Emitted with coarse errorKind because
   * pi-ai swallows the original cause.
   */
  "auth:refresh_failed": {
    provider: string;
    profileId: string;
    /** Coarse classification: refresh_token_reused | network | timeout | refresh_failed. */
    errorKind: string;
    /** Operator action recommendation. */
    hint: string;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Diagnostic events
  // -------------------------------------------------------------------------

  /** Full message lifecycle diagnostic with timing and cost */
  "diagnostic:message_processed": {
    messageId: string;
    channelId: string;
    channelType: string;
    agentId: string;
    sessionKey: string;
    /**
     * The turn's trajectory id (=== traceId, the `comis explain` key). OPTIONAL —
     * present when a request context is active at emit (the common turn path).
     * Carried on the payload so the Verified Learning correction writer
     * (setup-learning-reactions.ts) can record the prior completed trajectory for
     * a single-agent turn WITHOUT reading ALS (the emit runs outside the
     * executor's runWithContext scope — CR-02).
     */
    traceId?: string;
    receivedAt: number;
    executionDurationMs: number;
    deliveryDurationMs: number;
    totalDurationMs: number;
    tokensUsed: number;
    cost: number;
    success: boolean;
    finishReason: string;
    timestamp: number;
  };

  /** Outbound webhook delivery result */
  "diagnostic:webhook_delivered": {
    webhookId: string;
    source: string;
    event: string;
    statusCode: number;
    success: boolean;
    durationMs: number;
    error: string | undefined;
    timestamp: number;
  };

  /** Periodic channel health snapshot */
  "diagnostic:channel_health": {
    channels: Array<{
      channelId: string;
      channelType: string;
      lastActiveAt: number;
      messagesSent: number;
      messagesReceived: number;
    }>;
    timestamp: number;
  };

  /** Periodic billing summary */
  "diagnostic:billing_snapshot": {
    providers: Array<{
      provider: string;
      totalCost: number;
      totalTokens: number;
      callCount: number;
    }>;
    totalCost: number;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Media file extraction events
  // -------------------------------------------------------------------------

  /** File text extracted from document attachment */
  "media:file_extracted": {
    fileName: string;
    mimeType: string;
    chars: number;
    truncated: boolean;
    durationMs: number;
    timestamp: number;
  };

  /** Media file persisted to workspace directory */
  "media:file_persisted": {
    relativePath: string;
    mimeType: string;
    sizeBytes: number;
    mediaKind: string;
    agentId: string;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Scheduler events (cron, heartbeat, task extraction)
  // -------------------------------------------------------------------------

  /** Scheduler: cron job started execution */
  "scheduler:job_started": {
    jobId: string;
    jobName: string;
    agentId: string;
    timestamp: number;
  };

  /** Scheduler: cron job auto-suspended after exceeding maxConsecutiveErrors */
  "scheduler:job_suspended": {
    jobId: string;
    jobName: string;
    agentId: string;
    consecutiveErrors: number;
    lastError: string;
    timestamp: number;
    /** Delivery target for notifying the user (from job config). */
    deliveryTarget?: {
      channelId: string;
      userId: string;
      tenantId: string;
      channelType?: string;
    };
  };

  /** Scheduler: cron job completed execution */
  "scheduler:job_completed": {
    jobId: string;
    jobName: string;
    agentId: string;
    durationMs: number;
    success: boolean;
    error?: string;
    timestamp: number;
  };

  /** Scheduler: cron job result ready for delivery to originating channel */
  "scheduler:job_result": {
    jobId: string;
    jobName: string;
    agentId: string;
    result: string;
    success: boolean;
    /** Absent for deliveryTarget-less system_event jobs (the memory-cron
     *  __SENTINEL__ class — live finding 2026-06-11: their WORK rides this
     *  event and must fire even with nothing to deliver). The delivery
     *  listener already guards via `deliveryTarget?.channelType`. */
    deliveryTarget?: {
      channelId: string;
      userId: string;
      tenantId: string;
      channelType?: string;
    };
    timestamp: number;
    /** Payload kind from the cron job — determines delivery strategy (agent execution vs raw text). */
    payloadKind?: "system_event" | "agent_turn";
    /** Session history strategy propagated from the CronJob. */
    sessionStrategy?: "fresh" | "rolling" | "accumulate";
    /** Number of recent turns to keep for rolling strategy. */
    maxHistoryTurns?: number;
    /** Schedule cadence in ms when known. Populated only for schedule.kind === "every"
     *  (where everyMs is a literal). Undefined for cron-expression and one-shot ("at")
     *  schedules — deriving cadence from a cron expression would require parsing and is
     *  intentionally out of scope for this field. Used by the cron handler to warn when
     *  long-cadence jobs run with a cache-wasting sessionStrategy. */
    cadenceMs?: number;
    /** Per-cron-job model override from CronPayload.agent_turn.model. */
    cronJobModel?: string;
    /** Per-cron-job cache retention override from CronJob config. */
    cacheRetention?: "none" | "short" | "long";
    /** Per-cron-job tool policy override (opt-in). Resolution in the handler:
     *  job.toolPolicy > agentConfig.toolPolicy > passthrough `{ profile: "full" }`.
     *  Opt-in by design; omitting preserves pre-existing tool set. */
    toolPolicy?: { profile: string; allow: string[]; deny: string[] };
    /** Callback for agent_turn jobs to report execution result back to the scheduler.
     *  Called by the event handler after agent execution completes. */
    onComplete?: (result: { status: "ok" | "error"; error?: string }) => void;
  };

  /** Scheduler: heartbeat check performed */
  "scheduler:heartbeat_check": {
    checksRun: number;
    alertsRaised: number;
    timestamp: number;
  };

  /** Scheduler: heartbeat notification delivery attempted */
  "scheduler:heartbeat_delivered": {
    agentId: string;
    channelType: string;
    channelId: string;
    chatId: string;
    level: "ok" | "alert" | "critical";
    outcome: "delivered" | "skipped" | "failed";
    reason?: string;
    durationMs: number;
    timestamp: number;
  };

  /** Scheduler: heartbeat failure alert emitted */
  "scheduler:heartbeat_alert": {
    agentId: string;
    consecutiveErrors: number;
    classification: "transient" | "permanent";
    reason: string;
    backoffMs: number;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Process metrics and system events
  // -------------------------------------------------------------------------

  /** Process metrics collected (RSS, event loop lag, handles) */
  "observability:metrics": {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    eventLoopDelayMs: {
      min: number;
      max: number;
      mean: number;
      p50: number;
      p99: number;
    };
    activeHandles: number;
    uptimeSeconds: number;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Observability admin events
  // -------------------------------------------------------------------------

  /** Observability data reset by admin */
  "observability:reset": {
    admin: string;
    table: "all" | "token_usage" | "delivery" | "diagnostics" | "channels";
    rowsDeleted: { tokenUsage: number; delivery: number; diagnostics: number; channels: number };
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Agent hot-add/remove lifecycle events
  // -------------------------------------------------------------------------

  /** Agent hot-added to running daemon without restart */
  "agent:hot_added": { agentId: string; timestamp: number };

  /** Agent hot-removed from running daemon without restart */
  "agent:hot_removed": { agentId: string; timestamp: number };

  // -------------------------------------------------------------------------
  // MCP server events
  // -------------------------------------------------------------------------

  /** MCP server tool list changed via tools/list_changed notification */
  "mcp:server:tools_changed": {
    serverName: string;
    previousToolCount: number;
    currentToolCount: number;
    addedTools: string[];
    removedTools: string[];
    timestamp: number;
  };

  /** An MCP tool result exceeded its source-profile maxChars and was truncated
   *  by the bridge. Lets operators see which servers/tools return verbose blobs.
   *  originalSize/truncatedSize are character counts (post-sanitize, pre-wrap).
   *  The payload carries only sizes + identifiers — never the (untrusted)
   *  truncated content (never log bodies). */
  "mcp:server:result_truncated": {
    server: string;
    tool: string;
    originalSize: number;
    truncatedSize: number;
    traceId: string;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // MCP server connection lifecycle events
  // -------------------------------------------------------------------------

  /** MCP server connection lost (transport closed or error) */
  "mcp:server:disconnected": {
    serverName: string;
    reason: "transport_closed" | "transport_error" | "client_closed" | "client_error" | "keepalive_failed";
    timestamp: number;
  };

  /** MCP server reconnection attempt started */
  "mcp:server:reconnecting": {
    serverName: string;
    attempt: number;
    maxAttempts: number;
    nextDelayMs: number;
    timestamp: number;
  };

  /** MCP server reconnection succeeded */
  "mcp:server:reconnected": {
    serverName: string;
    attempt: number;
    toolCount: number;
    durationMs: number;
    timestamp: number;
  };

  /** MCP server reconnection failed after all attempts exhausted */
  "mcp:server:reconnect_failed": {
    serverName: string;
    attempts: number;
    lastError: string;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Notification events
  // -------------------------------------------------------------------------

  /** Notification enqueued for delivery */
  "notification:enqueued": {
    agentId: string;
    priority: "low" | "normal" | "high" | "critical";
    channelType: string;
    channelId: string;
    origin: string;
    timestamp: number;
  };

  /** Notification successfully delivered to channel */
  "notification:delivered": {
    agentId: string;
    channelType: string;
    channelId: string;
    messageId: string;
    durationMs: number;
    timestamp: number;
  };

  /** Notification suppressed (not delivered) */
  "notification:suppressed": {
    agentId: string;
    reason: "quiet_hours" | "rate_limited" | "duplicate" | "no_channel";
    priority: "low" | "normal" | "high" | "critical";
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Background task lifecycle events
  // -------------------------------------------------------------------------

  /** Tool execution promoted to background task after timeout */
  "background_task:promoted": {
    agentId: string;
    taskId: string;
    toolName: string;
    timestamp: number;
  };

  /** Background task completed successfully. `origin` carries originating
   *  session attribution so subscribers (the completion runner) can
   *  re-enter the right session without a synchronous round-trip through
   *  the manager. */
  "background_task:completed": {
    agentId: string;
    taskId: string;
    toolName: string;
    durationMs: number;
    origin: BackgroundTaskOrigin;
    timestamp: number;
  };

  /** Background task failed (timeout, error, or daemon restart).
   *  `origin` is populated for in-process failures and for restart-recovery
   *  failures (recoverOnStartup re-emits with origin from the persisted JSON). */
  "background_task:failed": {
    agentId: string;
    taskId: string;
    toolName: string;
    error: string;
    durationMs: number;
    origin: BackgroundTaskOrigin;
    timestamp: number;
  };

  /** Background completion runner is about to invoke executor.execute() on
   *  the originating session (latency-instrumentation hook). Subscribers
   *  may compute the delta from background_task:completed.timestamp to
   *  this event for SLO tracking (target: p95 ≤ 1000ms over 50 trials). */
  "background_task:reentered": {
    taskId: string;
    agentId: string;
    sessionKey: string;
    hopCount: number;
    /** traceId from task.origin for operator log continuity.
     *  null when no trace was active at promote() time. Carried through so
     *  subscribers (and operator log lines) preserve the originating trace
     *  across the background_task:completed → :reentered boundary. */
    traceId: string | null;
    timestamp: number;
  };

  /** Background task cancelled by user or system */
  "background_task:cancelled": {
    agentId: string;
    taskId: string;
    toolName: string;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // System lifecycle events
  // -------------------------------------------------------------------------

  // The "system:shutdown" event-bus event was removed from this map. Its
  // production subscribers (across daemon.ts, channels-helpers.ts,
  // setup-tools.ts, setup-channels-runtime.ts, setup-cross-session-events.ts)
  // had ZERO production emitters — every teardown silently no-op'd in
  // production until the systemd KillMode reaped the process. Teardowns now
  // flow directly through setupShutdown's ShutdownDeps (no event-bus
  // indirection). approval-gate.ts:156 + :339 retain the literal
  // "system:shutdown" string as a denial-reason sentinel — that string is
  // NOT this event.

  /** Unhandled error from a system component */
  "system:error": { error: Error; source: string };

  // -------------------------------------------------------------------------
  // Secret management audit events
  // -------------------------------------------------------------------------

  /** Secret access audit event (per-agent scoping) */
  "secret:accessed": {
    secretName: string;
    agentId: string;
    outcome: "success" | "denied" | "not_found";
    timestamp: number;
  };

  /**
   * Secret written to or removed from the live SecretManager (metadata only — never the value).
   *
   * For `action: "upserted"` on a NEW key: the value is immediately available
   * via `secretManager.get()` — live-applied to the shared Map (additive, no restart).
   *
   * For `action: "upserted"` on an EXISTING key (rotation): the Map holds the OLD value
   * until the daemon restarts (SIGUSR2 is scheduled); do NOT call `secretManager.get()`
   * in response to this event expecting the new value. A future change will make rotation
   * live-apply too, at which point this note becomes obsolete.
   *
   * For `action: "removed"`: the key is no longer in the Map (removed before emit).
   */
  "secret:changed": {
    /** Key name (identifier — not a credential value) */
    name: string;
    /** What happened: "upserted" for set/add/update; "removed" for delete */
    action: "upserted" | "removed";
    /** ms-epoch timestamp */
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Security warning events
  // -------------------------------------------------------------------------

  /** Security warning event (e.g., agent accessing secrets without explicit allow config) */
  "security:warn": {
    category: string;
    agentId: string;
    message: string;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Health budget events
  // -------------------------------------------------------------------------

  /**
   * Per-errorKind threshold exceeded in a sliding window. Emitted by the
   * health aggregator (packages/observability/src/health-aggregator)
   * ONCE per window cross — not per subsequent event in the same window.
   *
   * `kind` is one of the 10 errorKind closed-union members (or a synthetic
   * mapping for events that lack a typed errorKind field — see
   * SYNTHETIC_ERROR_KIND_MAP).
   */
  "health:budget_exceeded": {
    /** errorKind that crossed the threshold. */
    kind: string;
    /** Count of events observed within the window. */
    count: number;
    /** Window length in milliseconds. */
    windowMs: number;
    /** Timestamp of the threshold crossing (ms epoch). */
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Lifecycle reaction events
  // -------------------------------------------------------------------------

  /** Agent processing phase changed (e.g., thinking -> tool_use -> generating) */
  "reaction:phase_changed": {
    messageId: string;
    channelType: string;
    channelId: string;
    chatId: string;
    phase: string;
    emoji: string;
    previousPhase?: string;
    timestamp: number;
  };

  /** Agent processing stall detected (soft or hard threshold exceeded) */
  "reaction:stall_detected": {
    messageId: string;
    channelType: string;
    channelId: string;
    chatId: string;
    phase: string;
    severity: "soft" | "hard";
    stallMs: number;
    timestamp: number;
  };

  /** Agent processing reached terminal state (done or error) */
  "reaction:terminal": {
    messageId: string;
    channelType: string;
    channelId: string;
    chatId: string;
    phase: "done" | "error";
    emoji: string;
    timestamp: number;
  };

  /** Lifecycle reaction emoji removed (cleanup after hold period) */
  "reaction:cleanup": {
    messageId: string;
    channelType: string;
    channelId: string;
    chatId: string;
    removedEmoji: string;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Credential broker events
  // -------------------------------------------------------------------------

  /** Broker resolved a binding for a CONNECT request */
  "broker:session_opened": {
    sessionId: string;
    agentId: string;
    host: string;
    presetId?: string;
    timestamp: number;
  };

  /** Broker session torn down (normal or error) */
  "broker:session_closed": {
    sessionId: string;
    agentId: string;
    durationMs: number;
    reason: "teardown" | "error";
    timestamp: number;
  };

  /** Broker received a proxy CONNECT request */
  "broker:request": {
    sessionId: string;
    host: string;
    path: string;
    method: string;
    timestamp: number;
  };

  /** Broker injected credentials into a request */
  "broker:injected": {
    sessionId: string;
    host: string;
    /** Closed union matching InjectionRule["kind"] — not open string */
    ruleKind: InjectionRule["kind"];
    timestamp: number;
  };

  /** Broker denied a request (no binding, bad token, path-policy violation, malformed request, body-size cap exceeded, or WebSocket upgrade attempt) */
  "broker:denied": {
    sessionId: string;
    host: string;
    reason: "no_binding" | "bad_token" | "path_policy" | "malformed_request" | "body_too_large" | "ws_upgrade_not_supported";
    statusCode: number;
    timestamp: number;
  };

  /** Secret resolution miss — request not forwarded */
  "broker:credential_unavailable": {
    sessionId: string;
    secretRef: string;
    agentId: string;
    timestamp: number;
  };

  /** Egress attempt to non-broker host blocked (broker-only mode) */
  "broker:egress_blocked": {
    sessionId: string;
    /** SHA-256 hex of the target host — never plaintext (redaction) */
    targetHostHash: string;
    timestamp: number;
  };
}
