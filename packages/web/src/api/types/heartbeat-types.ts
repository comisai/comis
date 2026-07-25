// SPDX-License-Identifier: Apache-2.0
import type { WebRpcMethodMap } from "../contracts.generated.js";

type ErrorKind = NonNullable<
  WebRpcMethodMap["cron.runs"]["result"]["runs"][number]["errorKind"]
>;

/**
 * Heartbeat domain types.
 *
 * Interfaces for heartbeat agent state, correlated wake lifecycle events,
 * and alert events used in the scheduler and agent detail views.
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

export type HeartbeatWakeTarget =
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "monitoring" };

export type HeartbeatWakeLane = "normal" | "task";
export type HeartbeatWakeReason =
  | "interval"
  | "manual"
  | "hook"
  | "wake"
  | "exec-event"
  | "cron"
  | "task";

/** Heartbeat admission event payload (scheduler:heartbeat_wake_admitted SSE). */
export interface HeartbeatWakeAdmittedEvent {
  readonly correlationId: string;
  readonly target: HeartbeatWakeTarget;
  readonly lane: HeartbeatWakeLane;
  readonly retainedReason: HeartbeatWakeReason;
  readonly disposition: "new_occurrence" | "occurrence_upgraded" | "coalesced";
  readonly timestamp: number;
}

/** Heartbeat deferral event payload (scheduler:heartbeat_wake_deferred SSE). */
export interface HeartbeatWakeDeferredEvent {
  readonly correlationId: string;
  readonly target: HeartbeatWakeTarget;
  readonly lane: HeartbeatWakeLane;
  readonly reason:
    | "session_busy"
    | "spacing_deferred"
    | "flood_deferred"
    | "root_unavailable"
    | "task_store_unavailable";
  readonly nextEligibleAtMs: number;
  readonly errorKind?: ErrorKind;
  readonly timestamp: number;
}

/** Heartbeat terminal event payload (scheduler:heartbeat_wake_terminal SSE). */
export interface HeartbeatWakeTerminalEvent {
  readonly correlationId: string;
  readonly target: HeartbeatWakeTarget;
  readonly lane: HeartbeatWakeLane;
  readonly retainedReason: HeartbeatWakeReason;
  readonly status:
    | "settled"
    | "skipped"
    | "aborted"
    | "unsettled"
    | "failed_before_side_effect"
    | "cancelled_before_start";
  readonly cancellationReason?: "shutdown" | "target_removed" | "feature_disabled" | "maintenance";
  readonly eventEntryCount: number;
  readonly durationMs: number;
  readonly errorKind?: ErrorKind;
  readonly timestamp: number;
}
