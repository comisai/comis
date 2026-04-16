/**
 * HeartbeatRunner: Orchestrates periodic heartbeat checks across
 * pluggable sources, applying quiet hours suppression and relevance
 * filtering before surfacing notifications.
 *
 */

import { type TypedEventBus, sanitizeLogString } from "@comis/core";
import type { Result } from "@comis/shared";
import type { HeartbeatSourcePort, HeartbeatCheckResult } from "./heartbeat-source.js";
import type { QuietHoursConfig } from "./quiet-hours.js";
import type { NotificationVisibility } from "./relevance-filter.js";
import type { SchedulerLogger } from "../shared-types.js";
import { isInQuietHours } from "./quiet-hours.js";
import { classifyHeartbeatResult, shouldNotify } from "./relevance-filter.js";

/** Notification payload delivered to the onNotification callback. */
export interface HeartbeatNotification {
  sourceId: string;
  sourceName: string;
  text: string;
  level: "ok" | "alert" | "critical";
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** Dependencies for creating a HeartbeatRunner. */
export interface HeartbeatRunnerDeps {
  /** Initial set of heartbeat sources to check. */
  sources: HeartbeatSourcePort[];
  /** Event bus for emitting scheduler:heartbeat_check events. */
  eventBus: TypedEventBus;
  /** Logger instance. */
  logger: SchedulerLogger;
  /** Heartbeat configuration (intervalMs, visibility). */
  config: {
    intervalMs: number;
    showOk: boolean;
    showAlerts: boolean;
  };
  /** Quiet hours configuration. */
  quietHoursConfig: QuietHoursConfig;
  /** Whether critical alerts bypass quiet hours. */
  criticalBypass: boolean;
  /** Callback invoked when a notification should be delivered. */
  onNotification: (notification: HeartbeatNotification) => void;
  /** Optional lock function to prevent concurrent checks. */
  lockFn?: <T>(lockPath: string, fn: () => Promise<T>) => Promise<Result<T, "locked" | "error">>;
  /** Lock file directory (used with lockFn). */
  lockDir?: string;
  /** Injectable clock for testing (defaults to Date.now). */
  nowMs?: () => number;
}

/** HeartbeatRunner public interface. */
export interface HeartbeatRunner {
  /** Start the periodic heartbeat interval. */
  start(): void;
  /** Stop the periodic heartbeat interval. */
  stop(): void;
  /** Run a single round of checks across all sources. */
  runOnce(): Promise<void>;
  /** Add a source at runtime. */
  registerSource(source: HeartbeatSourcePort): void;
  /** Remove a source by ID at runtime. */
  unregisterSource(sourceId: string): boolean;
}

/**
 * Create a HeartbeatRunner that periodically checks all registered sources.
 *
 * For each source in runOnce():
 * 1. Call source.check() to get the raw result
 * 2. Classify the result text (ok/alert/critical)
 * 3. Check quiet hours status
 * 4. Apply shouldNotify filter
 * 5. Emit scheduler:heartbeat_check event
 * 6. If notification passes filter, call onNotification callback
 *
 * If lockFn is provided, runOnce wraps the check loop in a lock
 * to prevent concurrent execution from overlapping intervals.
 */
export function createHeartbeatRunner(deps: HeartbeatRunnerDeps): HeartbeatRunner {
  const {
    eventBus,
    logger,
    config,
    quietHoursConfig,
    criticalBypass,
    onNotification,
    lockFn,
    lockDir,
  } = deps;
  const getNow = deps.nowMs ?? Date.now;

  const sources = new Map<string, HeartbeatSourcePort>();
  for (const source of deps.sources) {
    sources.set(source.id, source);
  }

  let timer: ReturnType<typeof setInterval> | null = null;

  const visibility: NotificationVisibility = {
    showOk: config.showOk,
    showAlerts: config.showAlerts,
  };

  async function doChecks(): Promise<void> {
    let checksRun = 0;
    let alertsRaised = 0;
    const now = getNow();

    for (const source of sources.values()) {
      let result: HeartbeatCheckResult;
      try {
        result = await source.check();
        checksRun++;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({
          sourceId: source.id, sourceName: source.name,
          err: errMsg,
          hint: "Check heartbeat source implementation for unhandled exceptions",
          errorKind: "dependency" as const,
        }, "Heartbeat source error");
        checksRun++;
        // Treat source errors as alerts
        // Sanitize error text before including in notification to prevent credential leaks
        result = {
          sourceId: source.id,
          text: `Error checking source: ${sanitizeLogString(errMsg)}`,
          timestamp: now,
        };
      }

      const level = classifyHeartbeatResult(result.text);
      const quietNow = isInQuietHours(quietHoursConfig, now);

      const notify = shouldNotify({
        level,
        visibility,
        isQuietHours: quietNow,
        criticalBypass,
      });

      if (level === "alert" || level === "critical") {
        alertsRaised++;
      }

      if (notify) {
        onNotification({
          sourceId: source.id,
          sourceName: source.name,
          text: result.text,
          level,
          timestamp: result.timestamp,
          metadata: result.metadata,
        });
      }
    }

    eventBus.emit("scheduler:heartbeat_check", {
      checksRun,
      alertsRaised,
      timestamp: now,
    });

    logger.debug({ checksRun, alertsRaised }, "Heartbeat tick complete");
  }

  async function runOnce(): Promise<void> {
    if (lockFn && lockDir) {
      const lockPath = `${lockDir}/heartbeat.lock`;
      const lockResult = await lockFn(lockPath, doChecks);
      if (!lockResult.ok) {
        if (lockResult.error === "locked") {
          logger.warn({ hint: "Previous heartbeat check still running; consider increasing intervalMs", errorKind: "resource" as const }, "Heartbeat check skipped");
        } else {
          logger.error({ hint: "Lock acquisition failed; check lockDir permissions and disk space", errorKind: "internal" as const }, "Heartbeat check lock error");
        }
        return;
      }
    } else {
      await doChecks();
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        void runOnce();
      }, config.intervalMs);
      timer.unref();
      logger.info({ intervalMs: config.intervalMs, sourceCount: sources.size }, "HeartbeatRunner started");
    },

    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
        logger.info("HeartbeatRunner stopped");
      }
    },

    runOnce,

    registerSource(source: HeartbeatSourcePort): void {
      sources.set(source.id, source);
    },

    unregisterSource(sourceId: string): boolean {
      return sources.delete(sourceId);
    },
  };
}
