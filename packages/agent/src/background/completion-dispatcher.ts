// SPDX-License-Identifier: Apache-2.0
/**
 * Completion dispatcher: observes background_task terminal events while the
 * completion runner exclusively owns durable execution and delivery state.
 *
 * **Failure isolation:** each handler is wrapped in suppressError so a
 * single dispatch's failure does not tear down the subscription
 * (AGENTS §2.1).
 *
 * @module
 */

import { suppressError, type Result } from "@comis/shared";
import type { TypedEventBus, BackgroundTaskOrigin, SessionQueryScope, SessionStoreError } from "@comis/core";
import type { ComisLogger } from "@comis/core";
import type {
  BackgroundTask,
  BackgroundSessionState,
  BackgroundTaskNotificationPolicy as NotificationPolicyType,
} from "./background-task-types.js";
import type { NotifyFn } from "./background-task-manager.js";

// ---------------------------------------------------------------------------
// Runtime constants exported for downstream consumers (test surface + ops).
// ---------------------------------------------------------------------------

/** Closed durable completion lifecycle exposed for diagnostics and tests. */
export const STATES: readonly BackgroundSessionState[] = [
  "pending",
  "execution_claimed",
  "executing",
  "ready_to_deliver",
  "delivering",
  "delivered",
  "parked_permanent",
  "parked_uncertain",
  "consumed_live",
] as const;

/**
 * Notification policy as a runtime object so it round-trips through
 * JSON.parse(JSON.stringify(...)) preserving identity. A boolean would
 * collapse to true/false on rehydrate and lose the distinction between
 * "deferred" / "immediate" / "silent".
 *
 * The typed enum is the single source of truth. This runtime object is a
 * discoverability surface (tests, debugging, logs); production code uses
 * the type-only `BackgroundTaskNotificationPolicy` from
 * `background-task-types.ts`.
 */
export const BackgroundTaskNotificationPolicy: Record<string, NotificationPolicyType> = {
  DEFERRED: "deferred",
  IMMEDIATE: "immediate",
  SILENT: "silent",
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Public-facing handle on the dispatcher. */
export interface CompletionDispatcher {
  /** Unsubscribe from the event bus. Idempotent. Awaitable so callers can
   *  ensure no in-flight handler outlives daemon shutdown. */
  shutdown(): Promise<void>;
}

/** Session-store dependency retained by daemon composition; it is not routing authority. */
export interface DispatcherSessionStore {
  loadByRef(scope: SessionQueryScope, conversationRef: BackgroundTaskOrigin["conversationRef"]): Result<unknown | undefined, SessionStoreError>;
}

/**
 * Minimal taskManager contract: read + (optionally) persist transitions.
 *
 * `transitionDispatchState` is optional so the dispatcher composes cleanly
 * with the test fixture in completion-dispatcher.test.ts (which constructs
 * `taskManager: { getTask: vi.fn() }` and asserts the at-most-once gate
 * without exercising state persistence). Production wiring adds
 * `transitionDispatchState` on the real BackgroundTaskManager so the
 * recovery-after-SIGKILL contract is binding.
 */
export interface DispatcherTaskManager {
  getTask(taskId: string): BackgroundTask | undefined;
  /**
   * Atomically transition the in-memory task's dispatchState AND persist.
   * Returns true on success; false if task does not exist. Optional —
   * when absent, the dispatcher routes purely via in-memory state.
   */
  transitionDispatchState?(taskId: string, next: BackgroundSessionState): boolean;
}

/**
 * Dispatcher dependencies.
 *
 * Public minimum: `eventBus`, `taskManager`, `logger`. Production wires
 * `fallbackNotifyFn` (the user-visible notification fired when the
 * dispatcher cannot route to the originating session).
 *
 * `sessionStore` + `maxBackgroundHops` are optional. When absent, the
 * dispatcher falls back to the safe behavior: pending → dispatched
 * (let the runner attempt re-entry), no fallback notification fired
 * from the dispatcher itself.
 */
export interface CompletionDispatcherDeps {
  eventBus: TypedEventBus;
  taskManager: DispatcherTaskManager;
  /**
   * User-visible notification fired when the dispatcher cannot route to
   * the originating session.
   */
  fallbackNotifyFn?: NotifyFn;
  /** SQLite session rows are not authoritative for JSONL-backed conversations. */
  sessionStore?: DispatcherSessionStore;
  /**
   * LIVE-TURN oracle: returns true while the given FORMATTED sessionKey has a
   * turn currently executing. A task promoted mid-turn is consumed by its own
   * still-running turn through one blocking `background_tasks read_output`
   * call, so a completion that lands while the origin turn is in flight must
   * fire no user-visible fallback. The persistent session store does not
   * represent live execution for JSONL-backed conversations. When this oracle
   * is absent, the session-store check decides alone.
   */
  isTurnInFlight?: (formattedSessionKey: string) => boolean;
  /** Recursion limit for background-task hop counting. When absent, the
   *  dispatcher does not enforce the cap (defers to the runner). */
  maxBackgroundHops?: number;
  logger: ComisLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wire the completion dispatcher against an event bus + task manager.
 * Subscriptions are installed synchronously; call shutdown() to remove them.
 *
 * At-most-once fallback: the state-machine transitions on
 * `task.dispatchState` are the single source of truth. The dispatcher's
 * synchronous transitionDispatchState runs BEFORE the completion-runner's
 * handler reads the updated state, by virtue of the event-bus subscribing
 * the dispatcher first (see setup-background-completion-runner.ts).
 */
export function createCompletionDispatcher(
  deps: CompletionDispatcherDeps,
): CompletionDispatcher {
  const log = deps.logger.child({ submodule: "completion-dispatcher" });
  let stopped = false;
  let inflight: Promise<void> = Promise.resolve();

  const onCompleted = (
    data: {
      agentId: string;
      taskId: string;
      toolName: string;
      durationMs: number;
      origin: BackgroundTaskOrigin;
      timestamp: number;
    },
  ) => {
    if (stopped) return;
    const promise = handleEvent(data.taskId, "completed");
    inflight = inflight.then(() => promise).catch(() => undefined);
    suppressError(promise, "completion dispatcher (completed)");
  };

  const onFailed = (
    data: {
      agentId: string;
      taskId: string;
      toolName: string;
      error: string;
      durationMs: number;
      origin: BackgroundTaskOrigin;
      timestamp: number;
    },
  ) => {
    if (stopped) return;
    const promise = handleEvent(data.taskId, "failed");
    inflight = inflight.then(() => promise).catch(() => undefined);
    suppressError(promise, "completion dispatcher (failed)");
  };

  deps.eventBus.on("background_task:completed", onCompleted);
  deps.eventBus.on("background_task:failed", onFailed);

  async function handleEvent(
    taskId: string,
    kind: "completed" | "failed",
  ): Promise<void> {
    const task = deps.taskManager.getTask(taskId);
    if (!task) {
      log.debug(
        { taskId, kind, hint: "Task disappeared from manager before dispatcher could resolve it" },
        "Completion dispatcher: task not in manager",
      );
      return;
    }

    log.debug(
      {
        taskId,
        kind,
        dispatchState: task.dispatchState ?? "pending",
        toolName: task.toolName,
        traceId: task.origin.traceId ?? undefined,
        hint: "The durable completion runner owns execution and delivery state",
      },
      "Completion dispatcher observed terminal task",
    );
  }

  return {
    async shutdown(): Promise<void> {
      if (stopped) return;
      stopped = true;
      deps.eventBus.off("background_task:completed", onCompleted);
      deps.eventBus.off("background_task:failed", onFailed);
      // Wait for any in-flight handler to settle before returning.
      await inflight;
    },
  };
}
