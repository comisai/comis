// SPDX-License-Identifier: Apache-2.0
// @comis/scheduler - proactive automation: cron scheduling, heartbeat, execution safety
// Public API -- all exports have verified external consumers.

// Shared types
export type { SchedulerLogger } from "./shared-types.js";

// Cron types
export type { CronJob } from "./cron/index.js";

// Cron engine
export { computeNextRunAtMs } from "./cron/index.js";
export { createCronStore } from "./cron/index.js";
export type { CronStore } from "./cron/index.js";
export { createCronScheduler } from "./cron/index.js";
export type { CronScheduler } from "./cron/index.js";

// Execution safety
export { createExecutionTracker } from "./execution/index.js";
export type { ExecutionTracker, ExecutionLogEntry } from "./execution/index.js";

// File-based execution lock (consumed by @comis/agent OAuth file adapter + token manager)
export { withExecutionLock, isLocked } from "./execution/execution-lock.js";
export type { ExecutionLockOptions } from "./execution/execution-lock.js";

// Heartbeat monitoring
export { HEARTBEAT_OK_TOKEN, createHeartbeatRunner } from "./heartbeat/index.js";
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

// Task extraction
export { createTaskExtractor } from "./tasks/task-extractor.js";
export type { TaskExtractor, TaskExtractorDeps, ExtractionFn } from "./tasks/task-extractor.js";
export { createTaskStore } from "./tasks/task-store.js";
export type { TaskStore } from "./tasks/task-store.js";
export type { ExtractedTask, TaskPriority, TaskStatus, TaskExtractionResult } from "./tasks/task-types.js";
export { ExtractedTaskSchema, TaskExtractionResultSchema, TaskPrioritySchema, TaskStatusSchema } from "./tasks/task-types.js";
export { scorePriority, rankTasks, PRIORITY_WEIGHTS } from "./tasks/task-priority.js";
export type { PriorityScore } from "./tasks/task-priority.js";

// File gate: trigger-based bypass logic
export { shouldBypassFileGates } from "./heartbeat/index.js";
export type { HeartbeatTriggerKind } from "./heartbeat/index.js";

// Prompt builder
export { resolveHeartbeatTriggerKind, buildHeartbeatPrompt, DEFAULT_HEARTBEAT_PROMPT, MEMORY_STATS_THRESHOLD } from "./heartbeat/index.js";
export type { HeartbeatMemoryStats } from "./heartbeat/index.js";

// Response processor
export { stripMarkup, stripHeartbeatToken, stripResponsePrefix, classifyHeartbeatResponse, processHeartbeatResponse } from "./heartbeat/index.js";
export type { HeartbeatResponseOutcome, ClassifyHeartbeatInput, ProcessHeartbeatInput } from "./heartbeat/index.js";

// Cron event prompts
export { buildCronEventPrompt, buildExecEventPrompt } from "./heartbeat/index.js";

// Cron delivery policy
export { shouldSkipHeartbeatOnlyDelivery } from "./heartbeat/index.js";

// Agent heartbeat source
export { createAgentHeartbeatSource, isQueueBusy, resolveHeartbeatSessionKey } from "./heartbeat/index.js";
export type { AgentHeartbeatSourceDeps, HeartbeatSessionOps } from "./heartbeat/index.js";

// System events queue
export { createSystemEventQueue } from "./system-events/index.js";
export type { SystemEventQueue, SystemEventQueueDeps } from "./system-events/index.js";
export { SystemEventEntrySchema } from "./system-events/index.js";
export type { SystemEventEntry } from "./system-events/index.js";
