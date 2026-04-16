/**
 * Common types shared across multiple domains.
 *
 * Contains connection status, data table columns, and SSE event
 * type definitions used throughout the web console.
 */

/** WebSocket connection status */
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

/** Column definition for ic-data-table */
export interface DataTableColumn<T = unknown> {
  readonly key: string;
  readonly label: string;
  readonly sortable?: boolean;
  readonly width?: string;
  readonly render?: (value: unknown, row: T) => unknown;
}

/**
 * SSE event type names emitted by the daemon.
 *
 * Used by the event dispatcher to register listeners and by
 * consumers to subscribe to specific event types.
 */
export const SSE_EVENT_TYPES = [
  "message:received",
  "message:sent",
  "message:streaming",
  "session:created",
  "session:expired",
  "audit:event",
  "skill:executed",
  "skill:rejected",
  "observability:metrics",
  "observability:token_usage",
  "scheduler:job_started",
  "scheduler:job_completed",
  "scheduler:heartbeat_check",
  "scheduler:heartbeat_alert",
  "scheduler:heartbeat_delivered",
  "scheduler:task_extracted",
  "system:error",
  "approval:requested",
  "approval:resolved",
  // Graph execution events
  "graph:started",
  "graph:node_updated",
  "graph:completed",
  // Extended real-time event types
  "config:patched",
  "diagnostic:channel_health",
  "diagnostic:billing_snapshot",
  "skill:loaded",
  "skill:registry_reset",
  "model:catalog_loaded",
  "observability:reset",
  "channel:registered",
  "channel:deregistered",
  // Agent lifecycle events
  "agent:hot_added",
  "agent:hot_removed",
  // Security and provider monitoring
  "security:injection_detected",
  "security:injection_rate_exceeded",
  "security:memory_tainted",
  "security:warn",
  "secret:accessed",
  "secret:modified",
  "model:fallback_attempt",
  "model:fallback_exhausted",
  "model:auth_cooldown",
  "provider:degraded",
  "provider:recovered",
  // Sub-agent lifecycle events
  "session:sub_agent_spawned",
  "session:sub_agent_completed",
  "session:sub_agent_archived",
  "session:sub_agent_spawn_rejected",
  "session:sub_agent_spawn_started",
  "session:sub_agent_spawn_queued",
  "session:sub_agent_lifecycle_ended",
  "ping",
] as const;

/** Union type of all SSE event names */
export type SseEventType = (typeof SSE_EVENT_TYPES)[number];
