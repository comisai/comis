// SPDX-License-Identifier: Apache-2.0
/**
 * Health, process, and monitoring subsystem setup: process monitor and
 * heartbeat runner with configurable monitoring sources.
 * Extracted from daemon.ts steps 5 through 6.7 to isolate process lifecycle
 * and monitoring concerns from the main startup sequence.
 * @module
 */

import type { AppContainer, ClockPort, TimerPort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { createProcessMonitor, ProcessMonitor } from "../process/process-monitor.js";
import {
  createHeartbeatRunner,
  createDuplicateDetector,
  type HeartbeatRunner,
  type HeartbeatSourcePort,
  type DuplicateDetector,
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
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Create and start the process monitor.
 * @param deps.container - Bootstrap output (config, event bus)
 * @param deps._createProcessMonitor - Factory (overridable for tests)
 */
export function setupHealth(deps: {
  container: AppContainer;
  logger: ComisLogger;
  daemonLogger: ComisLogger;
  _createProcessMonitor: typeof createProcessMonitor;
}): HealthResult {
  const { container, _createProcessMonitor } = deps;

  // 5. Create and start process monitor
  const processMonitor = _createProcessMonitor({ eventBus: container.eventBus });
  processMonitor.start();

  return {
    processMonitor,
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
  /** Injected scheduler clock for diagnostics and duplicate visibility evidence. */
  clock: ClockPort;
  /** Injected scheduler timers for stale-check cancellation and grace. */
  timers: TimerPort;
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
  const { container, schedulerLogger } = deps;

  let heartbeatRunner: HeartbeatRunner | undefined;
  const monitoringConfig = container.config.monitoring;
  const schedulerConfig = container.config.scheduler;
  const monitoringSources: HeartbeatSourcePort[] = [];

  // Create shared duplicate detector for 24h dedup
  const duplicateDetector = createDuplicateDetector({ clock: deps.clock });

  if (monitoringConfig.disk.enabled) {
    monitoringSources.push(createDiskSpaceSource(monitoringConfig.disk, deps.clock));
  }
  if (monitoringConfig.resources.enabled) {
    monitoringSources.push(createSystemResourcesSource(monitoringConfig.resources, deps.clock));
  }
  if (monitoringConfig.systemd.enabled) {
    monitoringSources.push(createSystemdServiceSource(monitoringConfig.systemd, deps.clock));
  }
  if (monitoringConfig.securityUpdates.enabled) {
    monitoringSources.push(createSecurityUpdateSource(monitoringConfig.securityUpdates, deps.clock));
  }
  if (monitoringConfig.git.enabled) {
    monitoringSources.push(createGitWatcherSource(monitoringConfig.git, deps.clock));
  }

  if (monitoringSources.length > 0) {
    heartbeatRunner = createHeartbeatRunner({
      sources: monitoringSources,
      clock: deps.clock,
      timers: deps.timers,
      eventBus: container.eventBus,
      logger: schedulerLogger,
      staleMs: schedulerConfig.heartbeat.staleMs,
    });
    schedulerLogger.debug(
      { sourceCount: monitoringSources.length, step: "monitoring_construction" },
      "Monitoring heartbeat runner constructed",
    );
  }

  return { heartbeatRunner, duplicateDetector };
}
