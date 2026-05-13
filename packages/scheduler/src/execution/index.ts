// SPDX-License-Identifier: Apache-2.0
// @comis/scheduler/execution — execution safety primitives.
//
// Phase 35 Plan 35-04 (D-01 #1): the file-based execution lock relocated to
// @comis/core/runtime/file-lock.ts. The exec-lock entry below is gone; cron
// internals consume `createFileLock` from @comis/core directly.

// Execution tracking
export { createExecutionTracker } from "./execution-tracker.js";
export type { ExecutionTracker, ExecutionLogEntry } from "./execution-tracker.js";
