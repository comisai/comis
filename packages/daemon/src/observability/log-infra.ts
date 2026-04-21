// SPDX-License-Identifier: Apache-2.0
/**
 * Logging infrastructure (level control + transport factory).
 * Combines per-module runtime log level control and pino
 * multi-target transport config for file rotation + stdout.
 * @module log-infra -- Logging infrastructure (level control + transport factory)
 */

import { isValidLogLevel, type ComisLogger } from "@comis/infra";
import type { LoggingConfig } from "@comis/core";
import os from "node:os";
import type pino from "pino";

// ===========================================================================
// Log Level Manager
// ===========================================================================

/**
 * Log level manager: per-module child loggers with runtime level control.
 * Modules obtain their logger via getLogger(module), which returns a cached
 * Pino child logger. Levels can be changed at runtime per-module or globally
 * via the daemon.setLogLevel RPC.
 */
export interface LogLevelManager {
  /** Get or create a child logger for a named module. Cached on first call. */
  getLogger(module: string): ComisLogger;

  /** Change the log level for a specific module's logger. */
  setLevel(module: string, level: string): void;

  /** Change the root logger's level (affects all modules that haven't been individually overridden). */
  setGlobalLevel(level: string): void;
}

/**
 * Create a log level manager that maintains a registry of per-module child loggers.
 * @param rootLogger - The root Pino logger from which child loggers are derived
 * @returns A LogLevelManager instance
 */
export function createLogLevelManager(
  rootLogger: ComisLogger,
): LogLevelManager {
  const loggers = new Map<string, ComisLogger>();

  const manager: LogLevelManager = {
    getLogger(module: string): ComisLogger {
      let logger = loggers.get(module);
      if (!logger) {
        logger = rootLogger.child({ module }) as ComisLogger;
        loggers.set(module, logger);
      }
      return logger;
    },

    setLevel(module: string, level: string): void {
      if (!isValidLogLevel(level)) return; // silently reject invalid levels
      const logger = loggers.get(module);
      if (logger) {
        logger.level = level;
      }
    },

    setGlobalLevel(level: string): void {
      if (!isValidLogLevel(level)) return; // silently reject invalid levels
      rootLogger.level = level;
    },
  };

  return manager;
}

// ===========================================================================
// Log Transport
// ===========================================================================

/**
 * Expand leading tilde to os.homedir().
 * pino-roll does NOT expand tildes, so this must be called before
 * passing filePath to the transport.
 */
export function expandTilde(filePath: string): string {
  return filePath.replace(/^~(?=\/|$)/, os.homedir());
}

/**
 * Detect whether the process is running under pm2.
 * pm2 sets the `PM2_HOME` environment variable for all managed processes.
 * When running under pm2, stdout is already captured to pm2's own log files
 * (`~/.pm2/logs/`), so the pino-roll file transport would be a byte-for-byte
 * duplicate.
 */
export function isPm2Managed(): boolean {
  // eslint-disable-next-line no-restricted-syntax -- ops toggle read before SecretManager is initialized
  return typeof process.env.PM2_HOME === "string" && process.env.PM2_HOME.length > 0;
}

/**
 * Create a pino multi-target transport config from LoggingConfig.
 * PM2-aware transport selection.
 * - File transport (pino-roll): always active -- canonical log location.
 * - Stdout: skipped under pm2 (PM2_HOME set) to avoid byte-for-byte
 *   duplication with pm2's own log capture in ~/.pm2/logs/.
 * Note: node-llama-cpp native module warnings write directly to stderr and
 * cannot be captured by Pino transports. This is a known limitation.
 * @param config - Logging config from DaemonConfigSchema.logging
 * @param level - Log level to apply to each target (Pino multi-transport
 *   targets default to "info" unless explicitly set)
 * @returns Transport config to pass as LoggerOptions.transport
 */
export function createFileTransport(config: LoggingConfig, level?: string): pino.TransportMultiOptions {
  const expandedPath = expandTilde(config.filePath);
  const pm2Detected = isPm2Managed();

  const targets: pino.TransportTargetOptions[] = [];

  // File transport: always active -- ~/.comis/logs/ is the canonical log location
  targets.push({
    target: "pino-roll",
    options: {
      file: expandedPath,
      size: config.maxSize,
      mkdir: true,
      limit: {
        count: config.maxFiles,
        removeOtherLogFiles: true,
      },
    },
    ...(level ? { level } : {}),
  });

  // Stdout: skip under pm2 (pm2 captures stdout to ~/.pm2/logs/, so it would be a duplicate)
  if (!pm2Detected) {
    targets.push({
      target: "pino/file",
      options: { destination: 1 }, // stdout
      ...(level ? { level } : {}),
    });
  }

  return { targets };
}
