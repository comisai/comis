// SPDX-License-Identifier: Apache-2.0
// @comis/core exports — Runtime detection helpers + proper-lockfile-backed
// FileLockPort adapter. `createFileLock` is the canonical adapter target for
// non-scheduler consumers (CLI, agent OAuth call sites, agent
// session-write-lock).

export { isDocker } from "../runtime/is-docker.js";
export { isRemoteEnvironment } from "../runtime/is-remote-env.js";
export type { IsRemoteEnvironmentInput } from "../runtime/is-remote-env.js";
export { createFileLock } from "../runtime/file-lock.js";
export type { ExecutionLockOptions } from "../runtime/file-lock.js";
// Sanctioned system-time helpers for in-package consumers that cannot
// accept an injected ClockPort/TimerPort. Exempt from the globals
// architecture rule by BOOTSTRAP_PATH_PATTERNS (see
// test/support/globals-classifier.ts — `packages/(core|infra)/src/runtime/`).
// Only helpers with actual consumers are exported; the rest stay internal to
// the runtime/ root (public-export-consumers gate forbids dead exports).
export {
  systemNowMs,
  systemNowDate,
  systemDateFrom,
  systemSleep,
  systemSetTimeout,
  systemClearTimeout,
  systemSetInterval,
  systemClearInterval,
  systemGetEnv,
  systemEnvSnapshot,
  systemScheduleTimeout,
} from "../runtime/system-time.js";
// Opaque timer-handle type aliases re-exported from the @comis/core barrel so
// consumers can `import type { ... } from "@comis/core"` cleanly instead of
// reaching into the runtime/ subpath. Type-only export — the value re-exports
// above already cover `systemSetInterval` / `systemSetTimeout`.
export type { SystemIntervalHandle, SystemTimeoutHandle } from "../runtime/system-time.js";

// Shared bounded-poll helper. Authored in @comis/core/runtime so BOTH the
// @comis/skills FAL adapter's inline execute() AND the daemon's background
// poller import it without a package-boundary violation.
export { createPollDeadline, pollUntilDone } from "../runtime/poll-deadline.js";
export type { PollDeadline, PollOutcome } from "../runtime/poll-deadline.js";
