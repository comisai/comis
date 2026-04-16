/**
 * Background task infrastructure for automatic tool execution promotion.
 *
 * @module
 */

export type { BackgroundTask, BackgroundTaskStatus, PersistedTaskState } from "./background-task-types.js";
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
