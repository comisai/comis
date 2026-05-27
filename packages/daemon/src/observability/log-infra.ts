// SPDX-License-Identifier: Apache-2.0
/**
 * Logging infrastructure (level control + transport factory).
 * Combines per-module runtime log level control and pino
 * multi-target transport config for file rotation + stdout.
 * @module log-infra -- Logging infrastructure (level control + transport factory)
 */

import { isValidLogLevel, type ComisLogger } from "@comis/infra";
import type { LoggingConfig } from "@comis/core";
import { systemGetEnv } from "@comis/core";
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
  const pm2Home = systemGetEnv("PM2_HOME");
  return typeof pm2Home === "string" && pm2Home.length > 0;
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
 * @param logRotation - Optional cross-stream rotation policy from
 *   AppConfig.observability.logRotation. When provided, overrides
 *   config.maxSize + config.maxFiles for the pino-roll transport.
 *   IMPORTANT (RESEARCH Pitfall 1): pino-roll `size` treats bare numbers as
 *   MB, NOT bytes. Always convert maxSizeBytes → "${Math.round(maxSizeBytes / (1024 * 1024))}m".
 * @returns Transport config to pass as LoggerOptions.transport
 */
export function createFileTransport(
  config: LoggingConfig,
  level?: string,
  logRotation?: { maxSizeBytes: number; maxFiles: number },
): pino.TransportMultiOptions {
  const expandedPath = expandTilde(config.filePath);
  const pm2Detected = isPm2Managed();

  // Compute size string and file count from logRotation policy when present.
  // pino-roll `size` semantics: bare numbers = MB (NOT bytes). Always use string form.
  const sizeStr = logRotation
    ? `${Math.round(logRotation.maxSizeBytes / (1024 * 1024))}m`  // RESEARCH Pitfall 1
    : config.maxSize;
  const countLimit = logRotation ? logRotation.maxFiles : config.maxFiles;

  // Each destination is expressed as a TransportPipelineOptions entry:
  //   pipeline[0] = upstream redact stage (Transform)
  //   pipeline[1] = final destination (Writable)
  //
  // This is the correct pino pattern for chaining a transform before a writable:
  // targets[] may contain TransportPipelineOptions (pipeline array, no `target` property)
  // OR TransportTargetOptions (target string, no `pipeline` property) — pino's worker
  // routes them differently. A pipeline entry runs as a chain:
  //   source → redact-stage → file-destination
  //
  // IMPORTANT: `target + pipeline` on the same object is NOT supported — pino's transport.js
  // adds such entries to BOTH `options.targets` (raw write) AND `options.pipelines` (stage-only,
  // no final dest). Using TransportPipelineOptions (pipeline-only, no target) is the correct API.
  const targets: pino.TransportPipelineOptions[] = [];

  // File transport: always active -- ~/.comis/logs/ is the canonical log location
  // The redact stage runs upstream of pino-roll so every line is scrubbed before disk write (R1)
  targets.push({
    pipeline: [
      { target: "@comis/infra/dist/logging/pipeline-redact-stage.js" },
      {
        target: "pino-roll",
        options: {
          file: expandedPath,
          size: sizeStr,
          mkdir: true,
          limit: {
            count: countLimit,
            removeOtherLogFiles: true,
          },
        },
      },
    ],
    ...(level ? { level } : {}),
  });

  // Stdout: skip under pm2 (pm2 captures stdout to ~/.pm2/logs/, so it would be a duplicate)
  // The redact stage runs upstream of pino/file so every line is scrubbed before stdout write (R1)
  if (!pm2Detected) {
    targets.push({
      pipeline: [
        { target: "@comis/infra/dist/logging/pipeline-redact-stage.js" },
        { target: "pino/file", options: { destination: 1 } }, // stdout
      ],
      ...(level ? { level } : {}),
    });
  }

  return { targets: targets as unknown as pino.TransportTargetOptions[] };
}
