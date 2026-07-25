// SPDX-License-Identifier: Apache-2.0
/**
 * Background task infrastructure for automatic tool execution promotion.
 *
 * @module
 */

export type {
  BackgroundTask,
  BackgroundTaskStatus,
  BackgroundSessionState,
  PersistedTaskState,
} from "./background-task-types.js";
// `BackgroundTaskNotificationPolicy` is re-exported below as a runtime
// value (the typed-enum runtime object from completion-dispatcher.ts).
// TypeScript merges the type alias from `background-task-types.ts` and the
// runtime const from `completion-dispatcher.ts` only when the identifier
// is exported once per namespace; consumers needing the type-only alias
// must import directly from `./background-task-types.js`. Public consumers
// outside this package use the runtime value.
export type { BackgroundTaskNotificationPolicy as BackgroundTaskNotificationPolicyType } from "./background-task-types.js";
export type { BackgroundTaskOrigin } from "@comis/core";
export {
  persistTaskSync,
  loadTask,
  recoverTasks,
  removeTaskFile,
  TASK_DIR_NAME,
} from "./background-task-persistence.js";
export {
  createBackgroundTaskManager,
} from "./background-task-manager.js";
export type {
  BackgroundRecoveryRecorderFailure,
  BackgroundRecoveryRecorderFailureKind,
  BackgroundRecoveryRecorderDisposition,
} from "./background-task-types.js";
export type {
  BackgroundTaskManager,
  BackgroundTaskManagerOpts,
  NotifyFn,
} from "./background-task-manager.js";
export {
  wrapToolForAutoBackground,
} from "./auto-background-middleware.js";
export type {
  ToolDefinition,
} from "./auto-background-middleware.js";
export { formatCompletionAnnouncement, TRAILING_INSTRUCTION } from "./completion-formatter.js";
export { createTurnFlightTracker } from "./turn-flight-tracker.js";
export { createBackgroundCompletionRunner } from "./completion-runner.js";
export type {
  BackgroundCompletionRunner,
  BackgroundCompletionRunnerDeps,
  RunnerSessionStore,
} from "./completion-runner.js";
export type {
  BackgroundCompletionDeliveryOutcome,
} from "./background-task-types.js";
export {
  createCompletionDispatcher,
  STATES,
  BackgroundTaskNotificationPolicy,
} from "./completion-dispatcher.js";
export type {
  CompletionDispatcher,
  CompletionDispatcherDeps,
  DispatcherSessionStore,
  DispatcherTaskManager,
} from "./completion-dispatcher.js";
export { createBackgroundSessionResolver } from "./session-resolver.js";
export type {
  BackgroundSessionResolver,
  BackgroundSessionResolverDeps,
} from "./session-resolver.js";
