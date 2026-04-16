/**
 * Heartbeat domain types.
 *
 * Interfaces for heartbeat agent state, alert events, and
 * delivery events used in the scheduler and agent detail views.
 */

/** Per-agent heartbeat state DTO (from heartbeat.states RPC) */
export interface HeartbeatAgentStateDto {
  readonly agentId: string;
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly lastRunMs: number;
  readonly nextDueMs: number;
  readonly consecutiveErrors: number;
  readonly backoffUntilMs: number;
  readonly tickStartedAtMs: number;
  readonly lastAlertMs: number;
  readonly lastErrorKind: "transient" | "permanent" | null;
}

/** Heartbeat alert event payload (scheduler:heartbeat_alert SSE) */
export interface HeartbeatAlertEvent {
  readonly agentId: string;
  readonly consecutiveErrors: number;
  readonly classification: "transient" | "permanent";
  readonly reason: string;
  readonly backoffMs: number;
  readonly timestamp: number;
}

/** Heartbeat delivery event payload (scheduler:heartbeat_delivered SSE) */
export interface HeartbeatDeliveredEvent {
  readonly agentId: string;
  readonly channelType: string;
  readonly channelId: string;
  readonly chatId: string;
  readonly level: "ok" | "alert" | "critical";
  readonly outcome: "delivered" | "skipped" | "failed";
  readonly reason?: string;
  readonly durationMs: number;
  readonly timestamp: number;
}
