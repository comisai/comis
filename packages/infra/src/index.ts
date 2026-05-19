// SPDX-License-Identifier: Apache-2.0
// @comis/infra - Infrastructure adapters
//
// The Pino-free structural ComisLogger contract + LogFields / ErrorKind /
// VALID_LOG_LEVELS / isValidLogLevel canonically live in @comis/core. They
// are re-exported here so daemon / skills / cli (which import
// `from "@comis/infra"` for the runtime Pino path) see no public-surface drift.

// Logging (Pino logger factory with credential redaction, audit level)
export { createLogger } from "./logging/index.js";
export type { LoggerOptions, ComisLogger } from "./logging/index.js";
export type { LogFields, ErrorKind } from "@comis/core";
export { isValidLogLevel, VALID_LOG_LEVELS } from "@comis/core";

// Runtime detection helpers (single source of truth for Docker/PID-1 probes)
export { isDocker } from "./runtime/is-docker.js";

// Runtime adapters for time/env/timer ports.
export { createSystemClock } from "./runtime/clock.js";
export { createSystemEnv } from "./runtime/env.js";
export { createSystemTimers } from "./runtime/timers.js";

// Symlink-safe file-append primitive for diagnostic artifact writers.
// First O_NOFOLLOW + lstat-parent + fchmod 0o600 user in the repo (research §7).
// Plan 45-gap-01 Task 1: writeRegularFile (write-truncate analogue) for the
// config-audit scrubber tmp-write site (closes BL-02).
export {
  appendRegularFile,
  writeRegularFile,
  SymlinkParentRejected,
  FileSizeLimitExceeded,
} from "./fs-safe.js";
export type {
  AppendRegularFileOptions,
  AppendRegularFileSuccess,
  AppendRegularFileError,
  WriteRegularFileOptions,
  WriteRegularFileSuccess,
  WriteRegularFileError,
} from "./fs-safe.js";
