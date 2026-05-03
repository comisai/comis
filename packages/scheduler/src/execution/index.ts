// SPDX-License-Identifier: Apache-2.0
// @comis/scheduler/execution — execution safety primitives

// Execution tracking
export { createExecutionTracker } from "./execution-tracker.js";
export type { ExecutionTracker, ExecutionLogEntry } from "./execution-tracker.js";

// File-based execution lock
export { withExecutionLock, isLocked } from "./execution-lock.js";
export type { ExecutionLockOptions } from "./execution-lock.js";
