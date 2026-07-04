// SPDX-License-Identifier: Apache-2.0
// @comis/scheduler - proactive automation: cron scheduling, heartbeat, execution safety
// Public API -- all exports have verified external consumers.

// Shared types
export type { SchedulerLogger } from "./shared-types.js";

// Cron types
export type { CronJob, CronSchedule } from "./cron/index.js";
export { CronDeliveryTargetSchema } from "./cron/index.js";

// Cron engine
export { computeNextRunAtMs } from "./cron/index.js";
export { createCronStore } from "./cron/index.js";
export type { CronStore } from "./cron/index.js";
export { createCronScheduler } from "./cron/index.js";
export type { CronScheduler } from "./cron/index.js";

// Pre-run wake-gate: pure, fail-open verdict parser
export { parseWakeGateVerdict } from "./cron/index.js";
export type { WakeGateVerdict } from "./cron/index.js";

// Execution safety
export { createExecutionTracker } from "./execution/index.js";
export type { ExecutionTracker, ExecutionLogEntry } from "./execution/index.js";

// createFileLock lives in @comis/core. Consumers (CLI, agent OAuth call
// sites, daemon composition root, scheduler internals) import directly from
// @comis/core; scheduler no longer mediates the FileLockPort factory.

// Heartbeat monitoring
// HEARTBEAT_OK_TOKEN is not re-exported here; its canonical home is @comis/shared.
export { createHeartbeatRunner } from "./heartbeat/index.js";
export type { HeartbeatCheckResult, HeartbeatSourcePort, HeartbeatRunner } from "./heartbeat/index.js";

// Per-agent heartbeat config resolution
export { resolveEffectiveHeartbeatConfig } from "./heartbeat/index.js";
export type { EffectiveHeartbeatConfig } from "./heartbeat/index.js";

// Per-agent heartbeat runner
export { createPerAgentHeartbeatRunner } from "./heartbeat/index.js";
export type { PerAgentHeartbeatRunner, PerAgentHeartbeatRunnerDeps, HeartbeatAgentState } from "./heartbeat/index.js";

// Wake coalescer
export { createWakeCoalescer, WAKE_PRIORITY } from "./heartbeat/index.js";
export type { WakeCoalescer, WakeCoalescerDeps, WakeReasonKind } from "./heartbeat/index.js";

// Delivery bridge
export { createDuplicateDetector, deliverHeartbeatNotification } from "./heartbeat/index.js";
export type { DuplicateDetector, DeliveryBridgeDeps, DeliveryTarget, DeliveryOutcome, ChannelVisibilityConfig } from "./heartbeat/index.js";

// Quiet hours
export { isInQuietHours, parseTimeToMinutes, getCurrentMinutesInTimezone } from "./heartbeat/index.js";
export type { QuietHoursConfig } from "./heartbeat/index.js";

// File gate: trigger-based bypass logic
export { shouldBypassFileGates } from "./heartbeat/index.js";
export type { HeartbeatTriggerKind } from "./heartbeat/index.js";

// Prompt builder
export { resolveHeartbeatTriggerKind, buildHeartbeatPrompt, DEFAULT_HEARTBEAT_PROMPT, MEMORY_STATS_THRESHOLD } from "./heartbeat/index.js";
export type { HeartbeatMemoryStats } from "./heartbeat/index.js";

// Response processor
export { stripMarkup, stripHeartbeatToken, stripResponsePrefix, classifyHeartbeatResponse, processHeartbeatResponse } from "./heartbeat/index.js";
export type { HeartbeatResponseOutcome, ClassifyHeartbeatInput, ProcessHeartbeatInput } from "./heartbeat/index.js";

// Agent heartbeat source
export { createAgentHeartbeatSource, isQueueBusy, resolveHeartbeatSessionKey } from "./heartbeat/index.js";
export type { AgentHeartbeatSourceDeps, HeartbeatSessionOps } from "./heartbeat/index.js";

// System events queue
export { createSystemEventQueue } from "./system-events/index.js";
export type { SystemEventQueue, SystemEventQueueDeps } from "./system-events/index.js";
export { SystemEventEntrySchema } from "./system-events/index.js";
export type { SystemEventEntry } from "./system-events/index.js";
