/**
 * Background task manager wiring for daemon startup.
 * Creates BackgroundTaskManager, recovers incomplete tasks from previous
 * daemon runs, and starts periodic cleanup of stale completed/failed tasks.
 * @module
 */

import { createBackgroundTaskManager, type BackgroundTaskManager } from "@comis/agent";
import type { TypedEventBus } from "@comis/core";
import { safePath } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

/** Result of setupBackgroundTasks -- threaded into executor and tool pipelines. */
export interface BackgroundTasksContext {
  backgroundTaskManager: BackgroundTaskManager;
}

/** Dependencies for background task system setup. */
export interface SetupBackgroundTasksDeps {
  dataDir: string;
  eventBus: TypedEventBus;
  logger: ComisLogger;
}

/**
 * Wire the background task subsystem from daemon-level dependencies.
 * Creates BackgroundTaskManager with file-based persistence, recovers
 * incomplete tasks from the previous daemon run (marking them failed),
 * and starts an hourly cleanup timer for stale completed/failed tasks.
 * @param deps - Daemon-level dependencies
 * @returns BackgroundTasksContext with manager instance
 */
export function setupBackgroundTasks(deps: SetupBackgroundTasksDeps): BackgroundTasksContext {
  const manager = createBackgroundTaskManager({
    dataDir: safePath(deps.dataDir, "background-tasks"),
    eventBus: deps.eventBus,
    logger: deps.logger,
  });

  // Mark incomplete tasks from previous daemon run as failed
  manager.recoverOnStartup();

  // Periodic cleanup of stale completed/failed tasks (24h TTL)
  const cleanupInterval = setInterval(() => manager.cleanup(), 3_600_000); // every hour
  cleanupInterval.unref(); // don't keep daemon alive for cleanup

  return { backgroundTaskManager: manager };
}
