// @comis/scheduler/heartbeat -- heartbeat monitoring

// Per-agent heartbeat config resolution
export { resolveEffectiveHeartbeatConfig } from "./heartbeat-config.js";
export type { EffectiveHeartbeatConfig } from "./heartbeat-config.js";

// Relevance filter
export { HEARTBEAT_OK_TOKEN } from "./relevance-filter.js";

// Heartbeat source port
export type { HeartbeatCheckResult, HeartbeatSourcePort } from "./heartbeat-source.js";

// Heartbeat runner
export { createHeartbeatRunner } from "./heartbeat-runner.js";
export type { HeartbeatRunner } from "./heartbeat-runner.js";

// Per-agent heartbeat runner
export { createPerAgentHeartbeatRunner } from "./per-agent-heartbeat-runner.js";
export type {
  PerAgentHeartbeatRunner,
  PerAgentHeartbeatRunnerDeps,
  HeartbeatAgentState,
} from "./per-agent-heartbeat-runner.js";

// Wake coalescer
export { createWakeCoalescer } from "./wake-coalescer.js";
export type { WakeCoalescer, WakeCoalescerDeps } from "./wake-types.js";
export type { WakeReasonKind } from "./wake-types.js";
export { WAKE_PRIORITY } from "./wake-types.js";

// Delivery bridge
export { createDuplicateDetector } from "./duplicate-detector.js";
export type { DuplicateDetector } from "./duplicate-detector.js";
export { deliverHeartbeatNotification } from "./delivery-bridge.js";
export type { DeliveryBridgeDeps, DeliveryTarget, DeliveryOutcome, ChannelVisibilityConfig } from "./delivery-bridge.js";

// File gate: trigger-based bypass logic
export { shouldBypassFileGates } from "./file-gate.js";
export type { HeartbeatTriggerKind } from "./file-gate.js";

// Prompt builder
export { resolveHeartbeatTriggerKind, buildHeartbeatPrompt, DEFAULT_HEARTBEAT_PROMPT, MEMORY_STATS_THRESHOLD } from "./prompt-builder.js";
export type { HeartbeatMemoryStats } from "./prompt-builder.js";

// Response processor
export { stripMarkup, stripHeartbeatToken, stripResponsePrefix, classifyHeartbeatResponse, processHeartbeatResponse } from "./response-processor.js";
export type { HeartbeatResponseOutcome, ClassifyHeartbeatInput, ProcessHeartbeatInput } from "./response-processor.js";

// Cron event prompts
export { buildCronEventPrompt, buildExecEventPrompt } from "./cron-event-prompt.js";

// Cron delivery policy
export { shouldSkipHeartbeatOnlyDelivery } from "./cron-delivery-policy.js";

// Agent heartbeat source
export { createAgentHeartbeatSource, isQueueBusy, resolveHeartbeatSessionKey } from "./agent-heartbeat-source.js";
export type { AgentHeartbeatSourceDeps, HeartbeatSessionOps } from "./agent-heartbeat-source.js";

// Heartbeat response cache — dedup identical heartbeat queries
export { createHeartbeatResponseCache, hashHeartbeatPrompt } from "./response-cache.js";
export type { HeartbeatResponseCache } from "./response-cache.js";

// Quiet hours
export { isInQuietHours, parseTimeToMinutes, getCurrentMinutesInTimezone } from "./quiet-hours.js";
export type { QuietHoursConfig } from "./quiet-hours.js";

// Resilience tracker
export { HEARTBEAT_BACKOFF_SCHEDULE_MS, computeBackoffMs, classifyError, shouldFireAlert, isRecovery } from "./resilience-tracker.js";
export type { ErrorClassification, AlertDecision } from "./resilience-tracker.js";
