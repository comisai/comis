// SPDX-License-Identifier: Apache-2.0
// @comis/scheduler/heartbeat -- heartbeat monitoring

// Per-agent heartbeat config resolution
export { resolveEffectiveHeartbeatConfig } from "./heartbeat-config.js";
export type { EffectiveHeartbeatConfig } from "./heartbeat-config.js";

// Heartbeat source port
export {
  HeartbeatSourceIdSchema,
  MonitoringSourceDiagnosticSchema,
  MonitoringSourceErrorSchema,
  monitoringSourceError,
} from "./heartbeat-source.js";
export type {
  HeartbeatSourcePort,
  MonitoringSourceDiagnostic,
  MonitoringSourceError,
} from "./heartbeat-source.js";

// Heartbeat runner
export { createHeartbeatRunner } from "./heartbeat-runner.js";
export type {
  HeartbeatRunner,
  HeartbeatRunnerDeps,
  MonitoringHeartbeatError,
} from "./heartbeat-runner.js";

export {
  createHeartbeatWakeCoordinator,
  HEARTBEAT_MIN_WAKE_SPACING_MS,
  HEARTBEAT_FLOOD_WINDOW_MS,
  HEARTBEAT_FLOOD_MAX_STARTS,
} from "./wake-coordinator.js";
export { createHeartbeatPeriodicSchedule } from "./periodic-schedule.js";
export type {
  HeartbeatPeriodicConfig,
  HeartbeatPeriodicConfigureOutcome,
  HeartbeatPeriodicSchedule,
  HeartbeatPeriodicScheduleDeps,
  HeartbeatPeriodicScheduleError,
} from "./periodic-schedule.js";
export type {
  HeartbeatWakeTarget,
  HeartbeatWakeReason,
  HeartbeatWakeLane,
  HeartbeatWakeTiming,
  HeartbeatWakeRequest,
  HeartbeatWakeAdmissionOutcome,
  HeartbeatWakeAdmissionError,
  SystemEventWakeAdmissionRequest,
  SystemEventWakeAdmissionOutcome,
  SystemEventWakeAdmissionError,
  HeartbeatDeliveryOutcome,
  HeartbeatTickOutcome,
  HeartbeatTickError,
  MonitoringHeartbeatOutcome,
  HeartbeatCoordinatorAgentRunInput,
  HeartbeatCoordinatorMonitoringRunInput,
  HeartbeatWakeCoordinatorDeps,
} from "./wake-coordinator.js";

// Duplicate visibility detector
export { createDuplicateDetector } from "./duplicate-detector.js";
export type { DuplicateDetector } from "./duplicate-detector.js";

// Prompt builder
export { buildHeartbeatPrompt, DEFAULT_HEARTBEAT_PROMPT, MEMORY_STATS_THRESHOLD } from "./prompt-builder.js";
export type { HeartbeatMemoryStats } from "./prompt-builder.js";

// Response processor
export { stripMarkup, stripHeartbeatToken, stripResponsePrefix, classifyHeartbeatResponse, processHeartbeatResponse } from "./response-processor.js";
export type { HeartbeatResponseOutcome, ClassifyHeartbeatInput, ProcessHeartbeatInput } from "./response-processor.js";

// Quiet hours
export { isInQuietHours, parseTimeToMinutes, getCurrentMinutesInTimezone, resolveQuietHoursEndMs } from "./quiet-hours.js";
export type { QuietHoursConfig, QuietHoursResolutionError } from "./quiet-hours.js";
