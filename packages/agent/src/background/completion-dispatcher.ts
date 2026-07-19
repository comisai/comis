// SPDX-License-Identifier: Apache-2.0
/**
 * Completion dispatcher: routes background_task:completed/failed events
 * through the BackgroundSessionState machine.
 *
 * Subscribes to background_task:completed and background_task:failed BEFORE
 * the existing BackgroundCompletionRunner. On each event:
 *  1. Reads `task.dispatchState`.
 *  2. If "pending": transitions to "notified" only when the runner cannot
 *     re-enter the originating session (no active session for the formatted
 *     key, or recursion limit reached). Otherwise transitions to "dispatched"
 *     and lets the completion-runner perform re-entry.
 *  3. If already "notified" or "dispatched": no-op (at-most-once).
 *
 * The runner is wired AFTER the dispatcher in setup-background-completion-
 * runner.ts so its handler reads the updated `task.dispatchState` and skips
 * its own work when state is "notified" (the dispatcher already fired
 * fallback). This single-owner contract ensures the completion runner does
 * not double-fire user-visible notifications: the dispatcher routes via
 * persistent state instead of an in-memory event handler, and gates on
 * state instead of unconditionally firing.
 *
 * **State persistence:** every transition calls `manager.transitionDispatch
 * State(taskId, next)` (when the manager exposes it) which mutates the
 * in-memory task AND calls persistTaskSync. Recovery-after-SIGKILL reads
 * the persisted state and the manager skips re-emitting completion events
 * for already-dispatched / already-notified tasks.
 *
 * **Failure isolation:** each handler is wrapped in suppressError so a
 * single dispatch's failure does not tear down the subscription
 * (AGENTS §2.1).
 *
 * @module
 */

import { suppressError, type Result } from "@comis/shared";
import { conversationScopeToSessionKey, emitObservationalEventSafely, formatSessionKey, systemNowMs } from "@comis/core";
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

/**
 * The 3-state typed enum as a runtime array. Order matches transition order:
 *   pending → (notified | dispatched).
 *
 * Exported as a `readonly string[]` so tests can assert
 * `STATES === ["pending", "notified", "dispatched"]`.
 */
export const STATES: readonly BackgroundSessionState[] = [
  "pending",
  "notified",
  "dispatched",
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

/** Minimal session-store contract the dispatcher needs (active-session check). */
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
  /** Active-session check (production wiring). When absent, the dispatcher
   *  defers to the runner without firing fallback. */
  sessionStore?: DispatcherSessionStore;
  /**
   * LIVE-TURN oracle: returns true while the given FORMATTED sessionKey has a
   * turn currently executing. Load-bearing for the auto-background stub
   * protocol: a task promoted mid-turn is consumed by ITS OWN still-running
   * turn (which polls `background_tasks`), so a completion that lands while
   * the origin turn is in flight must fire NO user-visible fallback — the
   * live incident was a raw 'Background task "…" completed.' message landing
   * mid-conversation because the `sessionStore` check below (the persistent
   * store, near-EMPTY in DAG mode) mis-read a live conversation as "no active
   * session". When absent, behavior is unchanged (the sessionStore check
   * decides alone).
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
  const fallback = deps.fallbackNotifyFn;
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

    const current: BackgroundSessionState = task.dispatchState ?? "pending";

    // At-most-once: state machine is the single source of truth.
    if (current === "notified" || current === "dispatched") {
      log.debug(
        {
          taskId,
          dispatchState: current,
          // traceId from task.origin so dispatcher logs stay threaded with
          // the originating request even when the dispatcher runs from a
          // background ALS context.
          traceId: task.origin?.traceId ?? undefined,
          hint: "Task already dispatched/notified; no-op (at-most-once)",
        },
        "Completion dispatcher: at-most-once gate",
      );
      return;
    }

    // task.dispatchState === "pending". Decide which transition to make.
    // origin is producer-required; read it directly.
    const origin = task.origin;
    const agentId = origin.turnScope.conversation.agentId;
    const queryScope = { tenantId: origin.turnScope.conversation.tenantId, agentId };
    const projected = conversationScopeToSessionKey(origin.turnScope.conversation);
    if (!projected.ok) {
      log.warn({
        taskId,
        conversationRef: origin.conversationRef,
        hint: "Inspect or remove the persisted background task authority before retrying",
        errorKind: projected.error.errorKind,
      }, "Completion dispatcher: invalid persisted conversation scope");
      transitionTo(taskId, "notified");
      await fireFallback(task, `Background task "${task.toolName}" completed (routing failed).`);
      return;
    }
    const formattedSessionKey = formatSessionKey(projected.value);

    // Hop cap (when configured). Recursion limit reached → fallback.
    if (typeof deps.maxBackgroundHops === "number") {
      const nextHopCount = (origin.backgroundHopCount ?? 0) + 1;
      if (nextHopCount >= deps.maxBackgroundHops) {
        transitionTo(taskId, "notified");
        emitNotified(task, origin, true, "hop_cap");
        await fireFallback(
          task,
          `Background task "${task.toolName}" completed but follow-up was skipped — recursion limit reached. Run again or check the result manually.`,
        );
        return;
      }
    }

    // LIVE-TURN suppression (when wired): the origin turn is STILL EXECUTING —
    // it promoted this task mid-turn and consumes the result itself via the
    // background_tasks stub protocol. A user-visible fallback here is pure
    // noise landing mid-conversation (the live incident: a raw
    // 'Background task "…" completed.' followed by the turn's real answer).
    // Transition to "dispatched" — no notice; the runner's own in-flight
    // check also skips re-entry (the live turn owns consumption; an
    // unconsumed result stays readable via `background_tasks`).
    if (deps.isTurnInFlight?.(formattedSessionKey) === true) {
      transitionTo(taskId, "dispatched");
      emitNotified(task, origin, false, "live_turn_suppressed");
      log.debug(
        {
          taskId,
          sessionKey: formattedSessionKey,
          agentId,
          toolName: task.toolName,
          traceId: origin.traceId ?? undefined,
          hint: "Origin turn in flight — live turn consumes the result; no fallback notice",
        },
        "Completion dispatcher: suppressed fallback (origin turn live)",
      );
      return;
    }

    // Active-session check (when configured). No active session → fallback.
    if (deps.sessionStore) {
      const loaded = deps.sessionStore.loadByRef(queryScope, origin.conversationRef);
      if (!loaded.ok) {
        log.warn({
          taskId,
          conversationRef: origin.conversationRef,
          hint: "Inspect session database integrity and retry after storage recovers",
          errorKind: loaded.error.errorKind,
        }, "Completion dispatcher: session authority check failed");
        return;
      }
      if (loaded.value === undefined) {
        // The originating session is not currently registered. The
        // completion-runner would skip re-entry (no streaming channel) —
        // fire fallback so the user still sees a notification. The
        // dispatcher transitions to "notified" so the runner does NOT
        // also fire (single-owner contract).
        transitionTo(taskId, "notified");
        emitNotified(task, origin, true, "no_session");
        await fireFallback(
          task,
          `Background task "${task.toolName}" completed.`,
        );
        return;
      }
    }

    // Active session exists (or sessionStore not wired): the runner will
    // dispatch via re-entry. Transition to "dispatched" so the runner's
    // handler — which reads task.dispatchState — sees the updated state.
    // We do NOT fire fallback here (zero spurious outbound).
    transitionTo(taskId, "dispatched");
    log.debug(
      {
        taskId,
        sessionKey: formattedSessionKey,
        agentId,
        toolName: task.toolName,
        // traceId from origin for log continuity.
        traceId: origin.traceId ?? undefined,
        hint: "Runner will re-enter the originating session",
      },
      "Completion dispatcher: marked dispatched",
    );
  }

  function transitionTo(taskId: string, next: BackgroundSessionState): void {
    if (typeof deps.taskManager.transitionDispatchState === "function") {
      deps.taskManager.transitionDispatchState(taskId, next);
      return;
    }
    // No persistent transition wired — mutate the in-memory task directly so
    // the runner (which receives the same event in the same tick) reads the
    // updated state. Test fixtures take this branch.
    const task = deps.taskManager.getTask(taskId);
    if (task) task.dispatchState = next;
  }

  /**
   * Emit the content-free `background_task:notified` OBSERVABILITY signal for
   * the fallback-notice decision, so `comis explain` shows whether a raw
   * completion notice fired and whether it was correct (a `notified:true` with
   * the origin turn live is the leak class this makes diagnosable in one call —
   * previously wire-grep-only). Best-effort — a bus fault must never abort the
   * dispatch.
   */
  function emitNotified(
    task: BackgroundTask,
    origin: BackgroundTaskOrigin,
    notified: boolean,
    reason: "no_session" | "hop_cap" | "live_turn_suppressed",
  ): void {
    const projected = conversationScopeToSessionKey(origin.turnScope.conversation);
    if (!projected.ok) return;
    emitObservationalEventSafely({ eventBus: deps.eventBus, logger: log }, "background_task:notified", {
      agentId: origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      sessionKey: formatSessionKey(projected.value),
      notified,
      reason,
      traceId: origin.traceId ?? null,
      timestamp: systemNowMs(),
    });
  }

  async function fireFallback(task: BackgroundTask, message: string): Promise<void> {
    if (!fallback) {
      log.debug(
        {
          taskId: task.id,
          // traceId from origin keeps log lines threaded.
          traceId: task.origin?.traceId ?? undefined,
          hint: "No fallbackNotifyFn wired; dispatcher cannot fire user-visible notification",
        },
        "Completion dispatcher: fallback skipped (no fallbackNotifyFn)",
      );
      return;
    }
    try {
      await fallback({
        agentId: task.origin.turnScope.conversation.agentId,
        message,
        priority: "normal",
        origin: "background_task",
      });
    } catch (err) {
      log.warn(
        {
          taskId: task.id,
          agentId: task.origin.turnScope.conversation.agentId,
          err,
          // traceId from origin keeps the WARN line threaded.
          traceId: task.origin?.traceId ?? undefined,
          hint: "fallbackNotifyFn rejected; user will not see the completion notification for this task",
          errorKind: "internal" as const,
        },
        "Completion dispatcher: fallbackNotifyFn rejected",
      );
    }
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
