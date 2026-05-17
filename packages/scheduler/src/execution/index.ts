// SPDX-License-Identifier: Apache-2.0
// @comis/scheduler/execution — execution safety primitives.
//
// The file-based execution lock lives at @comis/core/runtime/file-lock.ts;
// cron internals consume `createFileLock` from @comis/core directly.

// Execution tracking
export { createExecutionTracker } from "./execution-tracker.js";
export type { ExecutionTracker, ExecutionLogEntry } from "./execution-tracker.js";
