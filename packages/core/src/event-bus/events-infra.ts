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
    toolName: string;
    action: string;
    params: Record<string, unknown>;
    agentId: string;
    sessionKey: string;
    trustLevel: string;
    createdAt: number;
    timeoutMs: number;
    /** Channel type of the originating request (e.g., "telegram", "discord"). Used by approval notifier. */
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

  /** Plugin registered with the plugin registry */
  "plugin:registered": {
    pluginId: string;
    pluginName: string;
    hookCount: number;
    timestamp: number;
  };

  /** Plugin deactivated */
  "plugin:deactivated": {
    pluginId: string;
    reason: string;
    timestamp: number;
  };

  /** Hook execution completed (for observability) */
  "hook:executed": {
    hookName: string;
    pluginId: string;
    durationMs: number;
    success: boolean;
    error?: string;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Auth events
  // -------------------------------------------------------------------------

  /** Provider auth token rotated (OAuth refresh) */
  "auth:token_rotated": {
    provider: string;
    profileName: string;
    expiresAtMs: number;
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
    deliveryTarget: {
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
    /** Per-cron-job model override from CronPayload.agent_turn.model. */
    cronJobModel?: string;
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

  /** Scheduler: task extracted from conversation */
  "scheduler:task_extracted": {
    taskId: string;
    title: string;
    priority: string;
    confidence: number;
    sessionKey: string;
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

  // -------------------------------------------------------------------------
  // MCP server connection lifecycle events
  // -------------------------------------------------------------------------

  /** MCP server connection lost (transport closed or error) */
  "mcp:server:disconnected": {
    serverName: string;
    reason: "transport_closed" | "transport_error" | "client_closed" | "client_error";
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

  /** Background task completed successfully */
  "background_task:completed": {
    agentId: string;
    taskId: string;
    toolName: string;
    durationMs: number;
    timestamp: number;
  };

  /** Background task failed (timeout, error, or daemon restart) */
  "background_task:failed": {
    agentId: string;
    taskId: string;
    toolName: string;
    error: string;
    durationMs: number;
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

  /** System is shutting down */
  "system:shutdown": { reason: string; graceful: boolean };

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

  /** Secret lifecycle event (CRUD operations) */
  "secret:modified": {
    secretName: string;
    action: "created" | "updated" | "deleted" | "imported";
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
}
