// SPDX-License-Identifier: Apache-2.0
// @comis/scheduler/execution — execution safety primitives.
//
// The file-based execution lock lives at @comis/core/runtime/file-lock.ts;
// cron internals consume `createFileLock` from @comis/core directly.

// Execution tracking
export { createExecutionTracker } from "./execution-tracker.js";
export {
  DEFAULT_EXECUTION_LOG_BYTES,
  DEFAULT_RETAINED_EXECUTIONS,
  MAX_CRON_TERMINAL_ROW_BYTES,
} from "./execution-tracker.js";
export type {
  ExecutionTracker,
  ExecutionTrackerOptions,
  ExecutionTrackerError,
  ExecutionTrackerErrorCode,
  ExecutionTrackerInitialization,
  CronExecutionGroup,
} from "./execution-tracker.js";
export {
  CronExecutionStatusSchema,
  CronPreDispatchFailureStageSchema,
  CronUnsettledOutcomeSchema,
  CronTerminalOutcomeSchema,
  CronExecutionStartedRowSchema,
  CronExecutionTerminalRowSchema,
  CronExecutionRowSchema,
  encodeCronExecutionRow,
  projectCronTerminalOutcome,
  classifyCronDependencyOutcome,
} from "./cron-execution-record.js";
export type {
  CronExecutionStatus,
  CronPreDispatchFailureStage,
  CronUnsettledOutcome,
  CronTerminalOutcome,
  CronExecutionStartedRow,
  CronExecutionTerminalRow,
  CronExecutionRow,
  CronExecutionRowEncodingError,
  CronDeliveryProjectionStatus,
  CronTerminalProjection,
} from "./cron-execution-record.js";
