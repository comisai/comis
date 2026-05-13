// SPDX-License-Identifier: Apache-2.0
// @comis/core exports -- Logging contracts (Pino-free structural interfaces).
// Mirrors the existing exports/security.ts pattern. Phase 28 commit 2 (CORE-PORTS-05):
// canonical home for ComisLogger / LogFields / ErrorKind / VALID_LOG_LEVELS / isValidLogLevel.
// Phase 35 Plan 35-02 (WEB-CONTRACTS-04): adds createConsoleLogger — Pino-free
// stderr-JSON writer used by CLI call sites after Plan 35-05's retarget.

export type { ComisLogger, LogFields, ErrorKind } from "../logging/index.js";
export { VALID_LOG_LEVELS, isValidLogLevel } from "../logging/index.js";
export { createConsoleLogger } from "../logging/console-logger.js";
