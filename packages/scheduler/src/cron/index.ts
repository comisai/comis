// SPDX-License-Identifier: Apache-2.0
// @comis/scheduler/cron — cron scheduling

export {
  CronPersistedScheduleSchema,
  CronAuthoringScheduleSchema,
  CronJobLifecycleSchema,
  CronAuthorablePayloadSchema,
  CronInternalActionNameSchema,
  CronAgentSessionPolicySchema,
  CronWakeGateSchema,
  CronDeliveryTargetSchema,
  AuthoredHeartbeatCronJobSchema,
  AuthoredDeliveryCronJobSchema,
  AuthoredAgentTurnCronJobSchema,
  BuiltInCronJobSchema,
  CronPersistedJobSchema,
} from "./cron-types.js";
export type {
  CronPersistedSchedule,
  CronAuthoringSchedule,
  CronSchedule,
  CronJobLifecycle,
  CronAuthorablePayload,
  CronInternalActionName,
  CronAgentSessionPolicy,
  CronWakeGate,
  CronDeliveryTarget,
  AuthoredHeartbeatCronJob,
  AuthoredDeliveryCronJob,
  AuthoredAgentTurnCronJob,
  BuiltInCronJob,
  CronPersistedJob,
  CronJob,
} from "./cron-types.js";
export {
  resolveCronAuthoringSchedule,
  CronScheduleAuthoringError,
} from "./cron-schedule-authoring.js";
export type { CronScheduleAuthoringErrorCode } from "./cron-schedule-authoring.js";

export * from "./cron-runtime.js";

// Cron expression evaluation
export { computeNextRunAtMs } from "./cron-expression.js";

// Cron store (atomic JSON persistence)
export { createCronStore } from "./cron-store.js";
export {
  CronStoreRootSchema,
  CronActiveClaimSchema,
  CronWorkKindSchema,
  CronTriggerSchema,
  encodeCronStoreRoot,
  CRON_STORE_FORMAT_VERSION,
  MAX_CRON_STORE_BYTES,
  TERMINAL_JOB_RETENTION_MS,
} from "./cron-store.js";
export type {
  CronStore,
  CronStoreOptions,
  CronStoreRoot,
  CronStoreError,
  CronStoreErrorCode,
  CronActiveClaim,
  CronClaimInput,
  CronClaimResult,
  CronDependencyOutcome,
  CronWorkKind,
  CronTrigger,
} from "./cron-store.js";

export { reconcileCronOwnership } from "./cron-ownership-reconciliation.js";
export type {
  CronOwnershipReconciliationError,
  CronOwnershipReconciliationErrorCode,
  CronOwnershipReconciliationResult,
} from "./cron-ownership-reconciliation.js";

export { createCronAuthorityMaintenance } from "./cron-authority-maintenance.js";
export type {
  CronAuthorityDurableStep,
  CronAuthorityMaintenance,
  CronAuthorityMaintenanceError,
  CronAuthorityMaintenanceErrorCode,
  CronAuthorityMaintenanceOptions,
  CronAuthorityInspection,
  CronAuthorityRecoveryResult,
  CronAuthorityResetRequest,
  CronAuthorityResetResult,
  CronAuthorityResetTarget,
  CronRawAuthorityState,
} from "./cron-authority-maintenance.js";

// Cron scheduler (timer loop, job lifecycle, error backoff)
export { createCronScheduler } from "./cron-scheduler.js";
export type {
  CronRootRegistrar,
  CronRootRegistrationError,
  CronScheduler,
  CronSchedulerLifecycleError,
} from "./cron-scheduler.js";

// Pre-run wake-gate: pure, fail-open verdict parser
export { parseWakeGateVerdict } from "./wake-gate-verdict.js";
export type { WakeGateVerdict } from "./wake-gate-verdict.js";
