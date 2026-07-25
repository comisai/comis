// SPDX-License-Identifier: Apache-2.0
/**
 * Background task manager wiring for daemon startup.
 * Creates BackgroundTaskManager, recovers incomplete tasks from previous
 * daemon runs, and starts periodic cleanup of stale completed/failed tasks.
 * @module
 */

import { createBackgroundTaskManager, TASK_DIR_NAME, type BackgroundTaskManager } from "@comis/agent";
import type { TypedEventBus, ClockPort, TimerPort, BackgroundTasksConfig } from "@comis/core";
import { safePath } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

/** Result of setupBackgroundTasks -- threaded into executor and tool pipelines. */
export interface BackgroundTasksContext {
  backgroundTaskManager: BackgroundTaskManager;
}

/** Dependencies for background task system setup. */
export interface SetupBackgroundTasksDeps {
  dataDir: string;
  config: BackgroundTasksConfig;
  resolveConfigForAgent(agentId: string): BackgroundTasksConfig;
  eventBus: TypedEventBus;
  logger: ComisLogger;
  /** Wall-clock + monotonic time reads. */
  clock: ClockPort;
  /** Timer scheduling. */
  timers: TimerPort;
}

/**
 * Wire the background task subsystem from daemon-level dependencies.
 * Creates BackgroundTaskManager with file-based persistence and starts
 * an hourly cleanup timer for stale completed/failed tasks.
 *
 * Note: startup recovery (marking interrupted tasks as failed) is
 * INTENTIONALLY deferred to daemon.ts. The daemon calls it AFTER
 * `setupBackgroundCompletionRunner` has subscribed to
 * background_task:{completed,failed}. If recovery fires before the runner
 * subscribes, the synthesized failure events for restart-interrupted tasks
 * land in an empty handler set and the user never sees the recovery
 * announcement.
 * @param deps - Daemon-level dependencies
 * @returns BackgroundTasksContext with manager instance
 */
export function setupBackgroundTasks(deps: SetupBackgroundTasksDeps): BackgroundTasksContext {
  const manager = createBackgroundTaskManager({
    dataDir: safePath(deps.dataDir, TASK_DIR_NAME),
    eventBus: deps.eventBus,
    logger: deps.logger,
    clock: deps.clock,
    timers: deps.timers,
    maxPerAgent: (agentId) => deps.resolveConfigForAgent(agentId).maxPerAgent,
    maxTotal: deps.config.maxTotal,
    maxBackgroundDurationMs: (agentId) => deps.resolveConfigForAgent(agentId).maxBackgroundDurationMs,
  });

  // Startup recovery is deferred to daemon.ts (after the completion runner subscribes).
  // Periodic cleanup of stale completed/failed tasks (24h TTL)
  const cleanupInterval = deps.timers.setInterval(() => manager.cleanup(), 3_600_000); // every hour
  cleanupInterval.unref(); // don't keep daemon alive for cleanup

  return { backgroundTaskManager: manager };
}
