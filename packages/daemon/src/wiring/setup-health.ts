/**
 * Health, process, and monitoring subsystem setup: process monitor, watchdog,
 * device identity loading, and heartbeat runner with configurable monitoring
 * sources.
 * Extracted from daemon.ts steps 5 through 6.7 to isolate process lifecycle
 * and monitoring concerns from the main startup sequence.
 * @module
 */

import type { DeviceIdentity, AppContainer, ChannelPort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { createProcessMonitor, ProcessMonitor } from "../process/process-monitor.js";
import type { startWatchdog, WatchdogHandle } from "../health/watchdog.js";
import { loadOrCreateDeviceIdentity } from "../device/device-identity.js";
import {
  createHeartbeatRunner,
  createDuplicateDetector,
  deliverHeartbeatNotification,
  type HeartbeatRunner,
  type HeartbeatSourcePort,
  type DuplicateDetector,
  type DeliveryTarget,
} from "@comis/scheduler";
import {
  createDiskSpaceSource,
  createSystemResourcesSource,
  createSystemdServiceSource,
  createSecurityUpdateSource,
  createGitWatcherSource,
} from "../monitoring/index.js";

// ===========================================================================
// Health
// ===========================================================================

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** All services produced by the health/process setup phase. */
export interface HealthResult {
  processMonitor: ProcessMonitor;
  watchdogHandle: WatchdogHandle;
  deviceIdentity?: DeviceIdentity;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Create and start the process monitor, start the systemd watchdog,
 * and load or create the device identity.
 * @param deps.container - Bootstrap output (config, event bus)
 * @param deps.logger - Root tracing logger (for identity load warnings)
 * @param deps._createProcessMonitor - Factory (overridable for tests)
 * @param deps._startWatchdog - Factory (overridable for tests)
 */
export function setupHealth(deps: {
  container: AppContainer;
  logger: ComisLogger;
  daemonLogger: ComisLogger;
  _createProcessMonitor: typeof createProcessMonitor;
  _startWatchdog: typeof startWatchdog;
}): HealthResult {
  const { container, daemonLogger, _createProcessMonitor, _startWatchdog } = deps;

  // 5. Create and start process monitor
  const processMonitor = _createProcessMonitor({ eventBus: container.eventBus });
  processMonitor.start();

  // 6. Start watchdog (gracefully degrades to no-op on macOS)
  const watchdogHandle = _startWatchdog({
    logger: daemonLogger,
    processMonitor,
  });

  // 6.4.5. Load or create device identity (optional -- warn but continue on failure)
  let deviceIdentity: DeviceIdentity | undefined;
  const stateDir = container.config.dataDir || ".";
  {
    const identityResult = loadOrCreateDeviceIdentity(stateDir);
    if (identityResult.ok) {
      deviceIdentity = identityResult.value;
      daemonLogger.info({ deviceId: deviceIdentity.deviceId }, "Device identity loaded");
    } else {
      daemonLogger.warn({ err: identityResult.error.message, hint: "Check file permissions in data directory", errorKind: "internal" as const }, "Device identity not available (non-fatal)");
    }
  }

  return {
    processMonitor,
    watchdogHandle,
    deviceIdentity,
  };
}

// ===========================================================================
// Monitoring
// ===========================================================================

// ---------------------------------------------------------------------------
// Deps / Result types
// ---------------------------------------------------------------------------

/** Dependencies for monitoring setup. */
export interface MonitoringDeps {
  /** Bootstrap output (config.monitoring, config.scheduler, eventBus). */
  container: AppContainer;
  /** Module-bound logger for scheduler subsystem. */
  schedulerLogger: ComisLogger;
  /** Root logger for notification callbacks. */
  logger: ComisLogger;
  /** Channel adapters for heartbeat delivery (optional -- delivery skipped if not provided). */
  adaptersByType?: ReadonlyMap<string, ChannelPort>;
}

/** All services produced by the monitoring setup phase. */
export interface MonitoringResult {
  /** Heartbeat runner for periodic health checks (optional). */
  heartbeatRunner?: HeartbeatRunner;
  /** Duplicate detector shared between global and per-agent heartbeat delivery. */
  duplicateDetector?: DuplicateDetector;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Create monitoring heartbeat sources and runner based on config toggles.
 * Synchronous setup -- creates sources array, builds runner if any are
 * enabled, starts the runner, and returns the handle.
 * @param deps - Monitoring dependencies
 */
export function setupMonitoring(deps: MonitoringDeps): MonitoringResult {
  const { container, schedulerLogger, logger, adaptersByType } = deps;

  let heartbeatRunner: HeartbeatRunner | undefined;
  const monitoringConfig = container.config.monitoring;
  const schedulerConfig = container.config.scheduler;
  const monitoringSources: HeartbeatSourcePort[] = [];

  // Create shared duplicate detector for 24h dedup
  const duplicateDetector = createDuplicateDetector();

  if (monitoringConfig.disk.enabled) {
    monitoringSources.push(createDiskSpaceSource(monitoringConfig.disk));
  }
  if (monitoringConfig.resources.enabled) {
    monitoringSources.push(createSystemResourcesSource(monitoringConfig.resources));
  }
  if (monitoringConfig.systemd.enabled) {
    monitoringSources.push(createSystemdServiceSource(monitoringConfig.systemd));
  }
  if (monitoringConfig.securityUpdates.enabled) {
    monitoringSources.push(createSecurityUpdateSource(monitoringConfig.securityUpdates));
  }
  if (monitoringConfig.git.enabled) {
    monitoringSources.push(createGitWatcherSource(monitoringConfig.git));
  }

  if (monitoringSources.length > 0) {
    heartbeatRunner = createHeartbeatRunner({
      sources: monitoringSources,
      eventBus: container.eventBus,
      logger: schedulerLogger,
      config: {
        intervalMs: schedulerConfig.heartbeat.intervalMs,
        showOk: schedulerConfig.heartbeat.showOk,
        showAlerts: schedulerConfig.heartbeat.showAlerts,
      },
      quietHoursConfig: schedulerConfig.quietHours,
      criticalBypass: schedulerConfig.quietHours.criticalBypass,
      onNotification: (notification) => {
        const msg = `Monitoring: ${notification.text}`;
        if (notification.level === "critical") {
          logger.error({ sourceId: notification.sourceId, level: notification.level, hint: "Investigate the monitoring source for critical conditions", errorKind: "resource" as const }, msg);
        } else if (notification.level === "alert") {
          logger.warn({ sourceId: notification.sourceId, level: notification.level, hint: "Review the monitoring source alert details", errorKind: "resource" as const }, msg);
        } else {
          logger.info({ sourceId: notification.sourceId, level: notification.level }, msg);
        }

        // Deliver to configured target channel (fire-and-forget)
        // Global heartbeat uses scheduler.heartbeat config -- per-agent delivery targets are wired in
        if (adaptersByType && adaptersByType.size > 0) {
          const globalTarget = resolveGlobalDeliveryTarget(container.config);
          if (globalTarget) {
            void deliverHeartbeatNotification(
              { adaptersByType, duplicateDetector, eventBus: container.eventBus, logger: schedulerLogger },
              globalTarget,
              notification,
              { agentId: "system" },
            ).catch((err: unknown) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              schedulerLogger.warn(
                { err: errMsg, hint: "Heartbeat delivery failed unexpectedly", errorKind: "internal" as const },
                "Heartbeat delivery error",
              );
            });
          }
        }
      },
    });
    heartbeatRunner.start();
    schedulerLogger.info({ sourceCount: monitoringSources.length }, "Monitoring heartbeat runner started");
  }

  return { heartbeatRunner, duplicateDetector };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve global heartbeat delivery target from config.
 * Currently returns undefined -- global system monitoring does not have a
 * delivery target. Per-agent delivery is handled by PerAgentHeartbeatRunner
 * This function exists so that adding a global delivery target
 * in a future phase is a one-line change.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function resolveGlobalDeliveryTarget(_config: AppContainer["config"]): DeliveryTarget | undefined {
  return undefined;
}
