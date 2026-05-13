// SPDX-License-Identifier: Apache-2.0
// @comis/infra - Infrastructure adapters
//
// Phase 28 commit 2 (CORE-PORTS-05): the Pino-free structural ComisLogger
// contract + LogFields / ErrorKind / VALID_LOG_LEVELS / isValidLogLevel
// canonically live in @comis/core. They are re-exported here so daemon /
// skills / cli (which import `from "@comis/infra"` for the runtime Pino
// path) see no public-surface drift.

// Logging (Pino logger factory with credential redaction, audit level)
export { createLogger } from "./logging/index.js";
export type { LoggerOptions, ComisLogger } from "./logging/index.js";
export type { LogFields, ErrorKind } from "@comis/core";
export { isValidLogLevel, VALID_LOG_LEVELS } from "@comis/core";

// Runtime detection helpers (single source of truth for Docker/PID-1 probes)
export { isDocker } from "./runtime/is-docker.js";
