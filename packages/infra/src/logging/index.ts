// SPDX-License-Identifier: Apache-2.0
// @comis/infra/logging — Pino logger factory with credential redaction.
//
// The canonical home of ComisLogger / LogFields / ErrorKind /
// VALID_LOG_LEVELS / isValidLogLevel is @comis/core (Pino-free
// structural contract). Re-exported here so daemon/skills/cli (which
// keep importing `from "@comis/infra"` for the runtime path) see no
// public-surface drift.

export { createLogger } from "./logger.js";
export type { LoggerOptions, ComisLogger } from "./logger.js";
export type { LogFields, ErrorKind } from "@comis/core";
export { isValidLogLevel, VALID_LOG_LEVELS } from "@comis/core";
export { fingerprint } from "@comis/core";
