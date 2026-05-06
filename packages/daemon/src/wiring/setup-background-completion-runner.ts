// SPDX-License-Identifier: Apache-2.0
/**
 * Background completion dispatcher + runner wiring for daemon startup.
 *
 * Phase 15 v12 (D-S3 at-most-once): subscribes the dispatcher BEFORE the
 * runner so its synchronous `transitionDispatchState` runs first; the
 * runner's handler then reads the updated `task.dispatchState` and skips
 * when state is "notified" (the dispatcher already fired fallback).
 * Subscription order matters because the event bus fires handlers in
 * registration order; the dispatcher MUST come first.
 *
 * Per AGENTS §2.4: composition root + factories. This wiring lives in
 * @comis/daemon (composition root); the actual factory bodies live in
 * @comis/agent.
 *
 * @module
 */

import {
  createBackgroundCompletionRunner,
  createCompletionDispatcher,
  type BackgroundCompletionRunner,
  type BackgroundTaskManager,
  type CompletionDispatcher,
  type NotifyFn,
} from "@comis/agent";
import type { TypedEventBus } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { AgentExecutor } from "@comis/agent";
import type { RunnerSessionStore } from "@comis/agent";

/** Result of setupBackgroundCompletionRunner -- exposed to the daemon for shutdown. */
export interface BackgroundCompletionRunnerContext {
  runner: BackgroundCompletionRunner;
  dispatcher: CompletionDispatcher;
}

/**
 * The taskManager arg widened in Phase 15 v12 to require
 * `transitionDispatchState` so the dispatcher can persist state-machine
 * transitions (D-S2 binding gate; AC-5 recovery-after-SIGKILL).
 *
 * The runner only consumes `getTask` (existing contract); the dispatcher
 * consumes both `getTask` and `transitionDispatchState`. Daemon callers
 * pass the full BackgroundTaskManager so structural subtyping covers both.
 */
export interface SetupBackgroundCompletionRunnerDeps {
  eventBus: TypedEventBus;
  getExecutor: (agentId: string) => AgentExecutor;
  sessionStore: RunnerSessionStore;
  /**
   * Phase 15 v12: must support `transitionDispatchState`; the dispatcher
   * persists state machine transitions through it (D-S2). The runner only
   * needs `getTask`.
   */
  taskManager: Pick<BackgroundTaskManager, "getTask" | "transitionDispatchState">;
  /** bgNotifyFn closure used when the originating session is gone. */
  fallbackNotifyFn: NotifyFn;
  /** From config.backgroundTasks.maxBackgroundHops (default 3). NOT config.workflow.*. */
  maxBackgroundHops: number;
  logger: ComisLogger;
}

/**
 * Wire the dispatcher + completion runner from daemon-level dependencies.
 * Call this AFTER setupNotifications so fallbackNotifyFn is wired.
 *
 * Subscription order (D-S3): dispatcher first (synchronous transition),
 * runner second (reads updated state). Reverse-order shutdown so the
 * runner stops accepting events before the dispatcher tears down.
 */
export function setupBackgroundCompletionRunner(
  deps: SetupBackgroundCompletionRunnerDeps,
): BackgroundCompletionRunnerContext {
  // Phase 15 v12 (D-S3): dispatcher subscribes FIRST so its synchronous
  // transitionDispatchState runs before the runner's handler reads
  // task.dispatchState within the same event-bus tick.
  const dispatcher = createCompletionDispatcher({
    eventBus: deps.eventBus,
    sessionStore: deps.sessionStore,
    taskManager: deps.taskManager,
    fallbackNotifyFn: deps.fallbackNotifyFn,
    maxBackgroundHops: deps.maxBackgroundHops,
    logger: deps.logger,
  });

  const runner = createBackgroundCompletionRunner({
    eventBus: deps.eventBus,
    getExecutor: deps.getExecutor,
    sessionStore: deps.sessionStore,
    taskManager: deps.taskManager,
    fallbackNotifyFn: deps.fallbackNotifyFn,
    maxBackgroundHops: deps.maxBackgroundHops,
    logger: deps.logger,
  });

  return {
    runner: {
      // Reverse-order shutdown: runner first (stops accepting events), then
      // dispatcher (ensures the at-most-once gate is the last to tear down).
      async shutdown(): Promise<void> {
        await runner.shutdown();
        await dispatcher.shutdown();
      },
    },
    dispatcher,
  };
}
