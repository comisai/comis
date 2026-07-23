// SPDX-License-Identifier: Apache-2.0
// @comis/scheduler - proactive automation: cron scheduling, heartbeat, execution safety.
// The root surface contains only concrete cross-package contracts.

export type { SchedulerLogger } from "./shared-types.js";

export {
  CronDeliveryTargetSchema,
  CronPersistedJobSchema,
  CronRuntimeExecutionInputSchema,
  CronRuntimeOutcomeSchema,
  SCHEDULER_SHUTDOWN_DRAIN_MS,
  SCHEDULER_TERMINATION_GRACE_MS,
  resolveCronAuthoringSchedule,
  computeNextRunAtMs,
  createCronStore,
  reconcileCronOwnership,
  createCronAuthorityMaintenance,
  createCronScheduler,
  parseWakeGateVerdict,
} from "./cron/index.js";
export type {
  CronPersistedSchedule,
  CronAuthoringSchedule,
  CronJobLifecycle,
  CronAuthorablePayload,
  CronInternalActionName,
  CronDeliveryTarget,
  BuiltInCronJob,
  CronJob,
  CronRuntimeExecutionInput,
  CronDeliveryOutcome,
  CronDirectDeliveryOutcome,
  SchedulerDiagnosticCounter,
  CronContinuationOutcome,
  InternalActionExecution,
  CronRuntimeOutcome,
  CronRuntimeError,
  CronRuntimeExecutor,
  CronStore,
  CronOwnershipReconciliationResult,
  CronAuthorityMaintenance,
  CronAuthorityMaintenanceErrorCode,
  CronAuthorityInspection,
  CronAuthorityResetRequest,
  CronAuthorityResetResult,
  CronAuthorityResetTarget,
  CronRootRegistrar,
  CronScheduler,
  WakeGateVerdict,
} from "./cron/index.js";

export {
  createExecutionTracker,
  projectCronTerminalOutcome,
} from "./execution/index.js";
export type {
  ExecutionTracker,
  CronExecutionGroup,
} from "./execution/index.js";

export {
  createHeartbeatRunner,
  resolveEffectiveHeartbeatConfig,
  createHeartbeatWakeCoordinator,
  createDuplicateDetector,
  isInQuietHours,
  parseTimeToMinutes,
  getCurrentMinutesInTimezone,
  resolveQuietHoursEndMs,
  buildHeartbeatPrompt,
  DEFAULT_HEARTBEAT_PROMPT,
  MEMORY_STATS_THRESHOLD,
  stripMarkup,
  stripHeartbeatToken,
  stripResponsePrefix,
  classifyHeartbeatResponse,
  processHeartbeatResponse,
} from "./heartbeat/index.js";
export type {
  HeartbeatSourcePort,
  HeartbeatRunner,
  EffectiveHeartbeatConfig,
  SystemEventWakeAdmissionRequest,
  SystemEventWakeAdmissionOutcome,
  SystemEventWakeAdmissionError,
  HeartbeatDeliveryOutcome,
  HeartbeatTickOutcome,
  HeartbeatTickError,
  HeartbeatCoordinatorAgentRunInput,
  HeartbeatWakeCoordinatorDeps,
  HeartbeatPeriodicConfig,
  HeartbeatPeriodicConfigureOutcome,
  HeartbeatPeriodicScheduleError,
  DuplicateDetector,
  QuietHoursConfig,
  HeartbeatMemoryStats,
  HeartbeatResponseOutcome,
  ClassifyHeartbeatInput,
  ProcessHeartbeatInput,
} from "./heartbeat/index.js";

export { SystemEventEntrySchema } from "./system-events/index.js";
export type { SystemEventEntry } from "./system-events/index.js";

export {
  createTaskExtractionQueue,
  createTaskExtractionRunner,
  createFollowupTaskStore,
  createTaskDueSchedule,
  createTaskAuthorityMaintenance,
} from "./tasks/index.js";
export type {
  TaskExtractionItem,
  TaskExtractionModelError,
  TaskExtractionModelSession,
  TaskExtractionRunnerOutcome,
  FollowupTaskRecord,
  FollowupTaskStoreError,
  SuccessfulTaskCheckExecutionEvidence,
  TaskCheckExecutionEvidence,
  FollowupTaskStore,
  FollowupTaskCancellationOutcome,
  FollowupTaskStoreInspection,
  TaskOwnershipRecoveryResult,
  TaskDueSchedule,
  TaskDueScheduleDeps,
  TaskAuthorityInspection,
  TaskAuthorityMaintenance,
  TaskAuthorityMaintenanceErrorCode,
  TaskAuthorityResetResult,
} from "./tasks/index.js";
