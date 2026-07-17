// SPDX-License-Identifier: Apache-2.0
/**
 * Content-free projection for the dashboard activity ring and event SSE feed.
 * EventBus payloads are richer internal contracts and may contain message
 * bodies, streamed text, approval params, metadata, or Error messages. Those
 * values must be discarded at the capture boundary, before retention or egress.
 */

import { tryCatch } from "@comis/shared";

const PROJECTED_EVENTS = new Set<string>([
  "message:received",
  "message:sent",
  "message:streaming",
  "session:created",
  "session:expired",
  "audit:event",
  "skill:loaded",
  "skill:executed",
  "skill:rejected",
  "observability:metrics",
  "observability:token_usage",
  "scheduler:job_started",
  "scheduler:job_completed",
  "scheduler:heartbeat_check",
  "system:error",
  "approval:requested",
  "approval:resolved",
  "graph:started",
  "graph:node_updated",
  "graph:completed",
  "config:patched",
  "diagnostic:channel_health",
  "diagnostic:billing_snapshot",
  "scheduler:heartbeat_delivered",
  "scheduler:heartbeat_alert",
  "skill:registry_reset",
  "model:catalog_loaded",
  "observability:reset",
  "channel:registered",
  "channel:deregistered",
  "agent:hot_added",
  "agent:hot_removed",
  "security:injection_detected",
  "security:injection_rate_exceeded",
  "security:memory_tainted",
  "security:warn",
  "secret:accessed",
  "model:fallback_attempt",
  "model:fallback_exhausted",
  "model:auth_cooldown",
  "provider:degraded",
  "provider:recovered",
  "session:sub_agent_spawned",
  "session:sub_agent_completed",
  "session:sub_agent_archived",
  "session:sub_agent_spawn_rejected",
  "session:sub_agent_spawn_started",
  "session:sub_agent_spawn_queued",
  "session:sub_agent_lifecycle_ended",
]);

/** Closed error categories that contain no caller-authored text. */
const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "DOMException",
  "Error",
  "RangeError",
  "TimeoutError",
  "TypeError",
]);

function classifyErrorName(error: unknown): string | undefined {
  const classified = tryCatch(() => {
    if (!(error instanceof Error)) return undefined;
    const name = error.name;
    return SAFE_ERROR_NAMES.has(name) ? name : "UnknownError";
  });
  return classified.ok ? classified.value : "UnknownError";
}

/** Exact primitive fields that carry identity, category, counts, or timing. */
const SAFE_SCALAR_FIELDS = new Set([
  "timestamp",
  "traceId",
  "requestId",
  "shortId",
  "messageId",
  "sourceMessageId",
  "channelType",
  "channelId",
  "sourceChannelType",
  "sourceChannelId",
  "tenantId",
  "userId",
  "clientId",
  "agentId",
  "parentAgentId",
  "childAgentId",
  "sessionId",
  "parentSessionId",
  "rootRunId",
  "runId",
  "graphId",
  "nodeId",
  "jobId",
  "taskId",
  "toolCallId",
  "toolName",
  "skillName",
  "provider",
  "model",
  "transport",
  "actionType",
  "kind",
  "classification",
  "outcome",
  "status",
  "errorKind",
  "stage",
  "scope",
  "method",
  "operationType",
  "success",
  "enabled",
  "connected",
  "durationMs",
  "latencyMs",
  "startedAt",
  "completedAt",
  "expiresAt",
  "checksRun",
  "alertsRaised",
  "count",
  "total",
  "nodeCount",
  "nodesCompleted",
  "nodesFailed",
  "nodesSkipped",
  "loadedCount",
  "failedCount",
  "attempt",
  "stepIndex",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function copySafeScalars(payload: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!SAFE_SCALAR_FIELDS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      projected[key] = value;
    }
  }
  return projected;
}

function projectSessionKey(
  target: Record<string, unknown>,
  sessionKey: unknown,
): void {
  if (typeof sessionKey === "string") {
    target.sessionKey = sessionKey;
    return;
  }
  const key = asRecord(sessionKey);
  if (key === undefined) return;
  if (typeof key.tenantId === "string") target.tenantId = key.tenantId;
  if (typeof key.userId === "string") target.userId = key.userId;
  if (typeof key.channelId === "string") target.sessionChannelId = key.channelId;
  if (typeof key.peerId === "string") target.peerId = key.peerId;
  if (typeof key.agentId === "string") target.agentId = key.agentId;
}

/** Project one internal EventBus payload to a strict content-free API shape. */
export function projectActivityPayload(
  event: string,
  payload: unknown,
): Record<string, unknown> {
  if (!PROJECTED_EVENTS.has(event)) return {};
  const record = asRecord(payload);
  if (record === undefined) return {};

  if (event === "message:received") {
    const message = asRecord(record.message);
    if (message === undefined) return {};
    const projected: Record<string, unknown> = {};
    if (typeof message.id === "string") projected.messageId = message.id;
    if (typeof message.channelType === "string") projected.channelType = message.channelType;
    if (typeof message.channelId === "string") projected.channelId = message.channelId;
    if (typeof message.senderId === "string") projected.senderId = message.senderId;
    if (typeof message.timestamp === "number") projected.timestamp = message.timestamp;
    projected.hasText = typeof message.text === "string" && message.text.length > 0;
    projected.attachmentCount = Array.isArray(message.attachments) ? message.attachments.length : 0;
    projectSessionKey(projected, record.sessionKey);
    return projected;
  }

  if (event === "message:sent") {
    return copySafeScalars(record);
  }

  if (event === "message:streaming") {
    const projected = copySafeScalars(record);
    projected.deltaChars = typeof record.delta === "string" ? record.delta.length : 0;
    projected.accumulatedChars = typeof record.accumulated === "string"
      ? record.accumulated.length
      : 0;
    return projected;
  }

  if (event === "system:error") {
    const error = record.error;
    const errorName = classifyErrorName(error);
    return {
      ...(typeof record.source === "string" ? { source: record.source } : {}),
      ...(errorName !== undefined ? { errorName } : {}),
    };
  }

  const projected = copySafeScalars(record);
  projectSessionKey(projected, record.sessionKey);
  return projected;
}
