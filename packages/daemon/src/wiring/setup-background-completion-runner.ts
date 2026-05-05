// SPDX-License-Identifier: Apache-2.0
/**
 * Background completion runner wiring for daemon startup.
 *
 * Subscribes the runner to background_task:{completed,failed} events after
 * the notification service has been wired (so fallbackNotifyFn is live),
 * and returns a shutdown handle for the daemon's system:shutdown sequence
 * to await before tearing down the executor.
 *
 * Per AGENTS §2.4: composition root + factories. This wiring lives in
 * @comis/daemon (composition root); the actual factory body is in
 * @comis/agent.
 *
 * @module
 */

import {
  createBackgroundCompletionRunner,
  type BackgroundCompletionRunner,
  type BackgroundTaskManager,
  type NotifyFn,
} from "@comis/agent";
import type { TypedEventBus } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { AgentExecutor } from "@comis/agent";
import type { RunnerSessionStore } from "@comis/agent";

/** Result of setupBackgroundCompletionRunner -- exposed to the daemon for shutdown. */
export interface BackgroundCompletionRunnerContext {
  runner: BackgroundCompletionRunner;
}

export interface SetupBackgroundCompletionRunnerDeps {
  eventBus: TypedEventBus;
  getExecutor: (agentId: string) => AgentExecutor;
  sessionStore: RunnerSessionStore;
  taskManager: Pick<BackgroundTaskManager, "getTask">;
  /** bgNotifyFn closure used when the originating session is gone. */
  fallbackNotifyFn: NotifyFn;
  /** From config.backgroundTasks.maxBackgroundHops (default 3). NOT config.workflow.*. */
  maxBackgroundHops: number;
  logger: ComisLogger;
}

/**
 * Wire the background completion runner from daemon-level dependencies.
 * Call this AFTER setupNotifications so fallbackNotifyFn is wired.
 */
export function setupBackgroundCompletionRunner(
  deps: SetupBackgroundCompletionRunnerDeps,
): BackgroundCompletionRunnerContext {
  const runner = createBackgroundCompletionRunner({
    eventBus: deps.eventBus,
    getExecutor: deps.getExecutor,
    sessionStore: deps.sessionStore,
    taskManager: deps.taskManager,
    fallbackNotifyFn: deps.fallbackNotifyFn,
    maxBackgroundHops: deps.maxBackgroundHops,
    logger: deps.logger,
  });
  return { runner };
}
