// SPDX-License-Identifier: Apache-2.0
// @comis/core exports — Runtime detection helpers + proper-lockfile-backed
// FileLockPort adapter. Phase 35 Plan 35-02 (D-01 #1 + WEB-CONTRACTS-05):
// createFileLock is the canonical adapter target for non-scheduler consumers
// (CLI, agent OAuth call sites, agent session-write-lock). The scheduler-side
// copy at packages/scheduler/src/execution/execution-lock.ts is removed in
// Plan 35-04 once consumers are retargeted.

export { isDocker } from "../runtime/is-docker.js";
export { isRemoteEnvironment } from "../runtime/is-remote-env.js";
export type { IsRemoteEnvironmentInput } from "../runtime/is-remote-env.js";
export { createFileLock } from "../runtime/file-lock.js";
export type { ExecutionLockOptions } from "../runtime/file-lock.js";
// Phase 39 PORTS-11/12/13 — sanctioned system-time helpers for in-package
// consumers that cannot accept an injected ClockPort/TimerPort. Exempt
// from the globals architecture rule by BOOTSTRAP_PATH_PATTERNS (see
// test/support/globals-classifier.ts:92 — `packages/(core|infra)/src/runtime/`).
// Only helpers with actual consumers are exported; the rest stay internal to
// the runtime/ root (public-export-consumers gate forbids dead exports).
export {
  systemNowMs,
  systemNowDate,
  systemDateFrom,
} from "../runtime/system-time.js";
