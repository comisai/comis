// SPDX-License-Identifier: Apache-2.0
// @comis/core exports -- Logging contracts (Pino-free structural interfaces).
// Canonical home for ComisLogger / LogFields / ErrorKind / VALID_LOG_LEVELS /
// isValidLogLevel. createConsoleLogger is a Pino-free stderr-JSON writer used
// by CLI call sites.

export type { ComisLogger, LogFields, ErrorKind } from "../logging/index.js";
export { ERROR_KINDS, VALID_LOG_LEVELS, isValidLogLevel } from "../logging/index.js";
export { createConsoleLogger } from "../logging/console-logger.js";
export { fingerprint } from "../logging/index.js";
export { withDedup } from "../logging/dedup-logger.js";
