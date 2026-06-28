// SPDX-License-Identifier: Apache-2.0
/**
 * Logging subsystem setup: file transport, tracing logger, log level
 * manager, module-bound loggers, and daemon version detection.
 * Extracted from daemon.ts to isolate infrastructure concerns from the
 * main wiring sequence.
 * @module
 */

import type { AppContainer } from "@comis/core";
import { LoggingConfigSchema, safePath } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { createTracingLogger } from "../observability/trace-logger.js";
import type { createLogLevelManager, LogLevelManager } from "../observability/log-infra.js";
import { createFileTransport, isPm2Managed } from "../observability/log-infra.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** All services produced by the logging setup phase. */
export interface LoggingResult {
  logger: ComisLogger;
  logLevelManager: LogLevelManager;
  daemonLogger: ComisLogger;
  gatewayLogger: ComisLogger;
  channelsLogger: ComisLogger;
  agentLogger: ComisLogger;
  schedulerLogger: ComisLogger;
  skillsLogger: ComisLogger;
  memoryLogger: ComisLogger;
  daemonVersion: string;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Create the full logging subsystem: tracing logger with optional file
 * transport, per-module log level manager, six module-bound loggers,
 * and daemon version string.
 * @param deps.container  - Bootstrap output (config, event bus)
 * @param deps._createTracingLogger - Factory (overridable for tests)
 * @param deps._createLogLevelManager - Factory (overridable for tests)
 */
export function setupLogging(deps: {
  container: AppContainer;
  instanceId: string;
  _createTracingLogger: typeof createTracingLogger;
  _createLogLevelManager: typeof createLogLevelManager;
}): LoggingResult {
  const { container, instanceId, _createTracingLogger, _createLogLevelManager } = deps;

  // 1.5. Construct file transport from logging config.
  // Forward observability.logRotation policy when present so pino-roll uses
  // the cross-stream policy. The logRotation policy takes
  // precedence over daemon.logging.maxSize/maxFiles for daemon.log.
  const loggingConfig = container.config.daemon?.logging;
  const configLogLevel = container.config.logLevel ?? "debug";
  const logRotation = container.config.observability?.logRotation
    ? {
        maxSizeBytes: container.config.observability.logRotation.maxSizeBytes,
        maxFiles: container.config.observability.logRotation.maxFiles,
      }
    : undefined;
  // B (obs-sweep): when no `daemon.logging` block is configured, DEFAULT the structured log
  // to a FILE at <dataDir>/logs/daemon.log rather than stdout-only. Without this, a config
  // omitting daemon.logging writes structured logs to stdout ONLY — silently LOST for any
  // backgrounded / systemd / `>/dev/null` daemon — yet the docs promise the authoritative log
  // is always at <dataDir>/logs/daemon.*.log. The audit + session-index sinks already write
  // under <dataDir>/logs via safePath; this aligns the daemon logger. dataDir is resolved the
  // same way as daemon.ts (config.dataDir, else COMIS_DATA_DIR, else ~/.comis).
  const resolvedDataDir =
    container.config.dataDir && container.config.dataDir.length > 0
      ? container.config.dataDir
      : (process.env["COMIS_DATA_DIR"] ?? safePath(os.homedir(), ".comis"));
  const effectiveLoggingConfig =
    loggingConfig ?? LoggingConfigSchema.parse({ filePath: safePath(resolvedDataDir, "logs", "daemon.log") });
  const fileTransport = createFileTransport(effectiveLoggingConfig, configLogLevel, logRotation);

  // 2. Create tracing logger (use config logLevel or default to "debug")
  const rawLogger = _createTracingLogger({
    name: "comis-daemon",
    level: configLogLevel,
    ...(fileTransport ? { transport: fileTransport } : {}),
  });

  // Bind instanceId to root logger — all children inherit it
  const logger = rawLogger.child({ instanceId }) as ComisLogger;

  // Log transport mode so operators can verify PM2-aware selection. INFO (not DEBUG): an
  // operator who can't find the structured log must see WHERE it went without flipping to
  // debug first — names the resolved file path + whether it was defaulted (no daemon.logging
  // block) so the "where are my logs?" question is answered from the boot line itself.
  const pm2Detected = isPm2Managed();
  logger.info(
    {
      structuredLogPath: effectiveLoggingConfig.filePath,
      defaultedLogPath: !loggingConfig,
      pm2Detected,
      stdoutEnabled: !pm2Detected,
    },
    "Structured logging configured",
  );

  // 3. Create log level manager
  const logLevelManager = _createLogLevelManager(logger);

  // 3.5. Create module-bound loggers for each subsystem
  const daemonLogger = logLevelManager.getLogger("daemon");
  const gatewayLogger = logLevelManager.getLogger("gateway");
  const channelsLogger = logLevelManager.getLogger("channels");
  const agentLogger = logLevelManager.getLogger("agent");
  const schedulerLogger = logLevelManager.getLogger("scheduler");
  const skillsLogger = logLevelManager.getLogger("skills");
  const memoryLogger = logLevelManager.getLogger("memory");

  // 3.6. Read daemon version from package.json for startup banner
  let daemonVersion = "unknown";
  try {
    const daemonDir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(daemonDir, "../../package.json");
    const pkgJson = JSON.parse(readFileSync(pkgPath, "utf-8"));
    daemonVersion = pkgJson.version ?? "unknown";
  } catch (err) {
    logger.warn({
      err: err instanceof Error ? err.message : String(err),
      hint: "Check that packages/daemon/package.json exists and is readable",
      errorKind: "config" as const,
    }, "Failed to read daemon version from package.json");
  }

  return {
    logger,
    logLevelManager,
    daemonLogger,
    gatewayLogger,
    channelsLogger,
    agentLogger,
    schedulerLogger,
    skillsLogger,
    memoryLogger,
    daemonVersion,
  };
}
