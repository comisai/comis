// SPDX-License-Identifier: Apache-2.0
/**
 * Background task manager: tracks tool executions promoted to background.
 *
 * Factory function `createBackgroundTaskManager` returns a typed interface
 * managing full task lifecycle: promote, complete, fail, cancel, recover.
 *
 * @module
 */
import { randomUUID } from "node:crypto";
import { ok, err, fromPromise, tryCatch, type Result } from "@comis/shared";
import {
  BackgroundTaskOriginSchema,
  emitObservationalEventSafely,
  type TypedEventBus,
  type ClockPort,
  type TimerHandle,
  type TimerPort,
} from "@comis/core";
import {
  persistTaskAtomically,
  persistTaskSync,
  recoverTasks,
  removeTaskFile,
} from "./background-task-persistence.js";
import type {
  BackgroundTask,
  BackgroundContinuationOutbox,
  BackgroundTaskOrigin,
  BackgroundSessionState,
  BackgroundTaskNotificationPolicy,
} from "./background-task-types.js";
import { BackgroundContinuationOutboxSchema } from "./background-task-types.js";

/** Notification callback fired when background task completes or fails. */
export type NotifyFn = (opts: {
  agentId: string;
  message: string;
  priority: "normal";
  origin: "background_task";
}) => Promise<unknown>;

export interface BackgroundTaskManagerOpts {
  dataDir: string;
  eventBus: TypedEventBus;
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    debug(obj: Record<string, unknown>, msg: string): void;
  };
  /** Wall-clock + monotonic time reads. */
  clock: ClockPort;
  /** Timer scheduling. Hard-timeout setTimeout uses .unref(). */
  timers: TimerPort;
  maxPerAgent?: number;
  maxTotal?: number;
  maxBackgroundDurationMs?: number;
}

export interface BackgroundTaskManager {
  promote(
    toolName: string,
    promise: Promise<unknown>,
    ac: AbortController,
    origin: BackgroundTaskOrigin,
    notificationPolicy?: BackgroundTaskNotificationPolicy,
  ): Result<string, Error>;
  /**
   * Mark a task as completed.
   *
   * The completion-dispatcher subscribes to the `background_task:completed`
   * event emitted here and decides whether to fire the user-visible fallback
   * notification. Single-owner contract eliminates double-notify.
   */
  complete(taskId: string, result: unknown): void;
  /**
   * Mark a task as failed. See `complete` for the single-owner note —
   * the dispatcher routes notification via the emitted event.
   */
  fail(taskId: string, error: unknown): void;
  cancel(taskId: string): Result<void, Error>;
  getTask(taskId: string): BackgroundTask | undefined;
  /**
   * Wait for a live promoted task and return its terminal state.
   * `onWaiting` is a content-free liveness heartbeat for the active tool call;
   * callers use it to keep prompt stall detection distinct from a healthy,
   * long-running task wait.
   */
  waitForTask(
    taskId: string,
    onWaiting?: () => void,
    waitHeartbeatMs?: number,
  ): Promise<Result<BackgroundTask, Error>>;
  getTasks(agentId: string): BackgroundTask[];
  getAllTasks(): BackgroundTask[];
  recoverOnStartup(): void;
  cleanup(maxAgeMs?: number): void;
  commitDispatchState(
    taskId: string,
    next: BackgroundSessionState,
    expected?: readonly BackgroundSessionState[],
  ): Result<boolean, Error>;
  persistContinuationOutbox(
    taskId: string,
    outbox: BackgroundContinuationOutbox,
    expected?: readonly BackgroundSessionState[],
  ): Result<void, Error>;
  scheduleDispatchRetry(taskId: string): void;
}

const MAX_RESULT_CHARS = 102_400; // 100KB

export function createBackgroundTaskManager(opts: BackgroundTaskManagerOpts): BackgroundTaskManager {
  const {
    dataDir,
    eventBus,
    logger,
    clock,
    timers,
    maxPerAgent = 5,
    maxTotal = 20,
    maxBackgroundDurationMs = 300_000,
  } = opts;

  const tasks = new Map<string, BackgroundTask>();
  const terminalSignals = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const dispatchRetryTimers = new Map<string, TimerHandle>();
  const perAgentCount = new Map<string, number>();
  let totalCount = 0;

  function reportPersistenceOutcome(
    task: BackgroundTask,
    outcome: import("./background-task-persistence.js").AtomicTaskPersistenceOutcome,
  ): void {
    if (outcome.kind === "committed") return;
    logger.warn(
      {
        taskId: task.id,
        toolName: task.toolName,
        hint: "Check protected background-task storage durability before restarting the daemon",
        errorKind: "resource" as const,
      },
      "Background task state committed without confirmed directory durability",
    );
  }

  function incrementCounters(agentId: string): void {
    perAgentCount.set(agentId, (perAgentCount.get(agentId) ?? 0) + 1);
    totalCount++;
  }

  function decrementCounters(agentId: string): void {
    const current = perAgentCount.get(agentId) ?? 1;
    perAgentCount.set(agentId, Math.max(0, current - 1));
    totalCount = Math.max(0, totalCount - 1);
  }

  function truncateResult(value: unknown): string {
    try {
      const json = JSON.stringify(value);
      return json.length > MAX_RESULT_CHARS ? json.slice(0, MAX_RESULT_CHARS) : json;
    } catch {
      return String(value).slice(0, MAX_RESULT_CHARS);
    }
  }

  const manager: BackgroundTaskManager = {
    promote(toolName, promise, ac, origin, notificationPolicy) {
      // Reject calls with missing/invalid origin (no silent fallback).
      const parsedOrigin = BackgroundTaskOriginSchema.safeParse(origin);
      if (!parsedOrigin.success) {
        return err(new Error("BackgroundTaskOrigin requires valid structured turn authority"));
      }
      const acceptedOrigin = parsedOrigin.data;
      const agentId = acceptedOrigin.turnScope.conversation.agentId;
      const agentCurrent = perAgentCount.get(agentId) ?? 0;
      if (agentCurrent >= maxPerAgent) {
        return err(new Error(`Concurrency limit exceeded: agent ${agentId} has ${agentCurrent}/${maxPerAgent} tasks`));
      }
      if (totalCount >= maxTotal) {
        return err(new Error(`Concurrency limit exceeded: total ${totalCount}/${maxTotal} tasks`));
      }

      const taskId = randomUUID();
      let resolveTerminal = (): void => undefined;
      const terminalPromise = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
      });
      let terminalResolved = false;
      terminalSignals.set(taskId, {
        promise: terminalPromise,
        resolve: () => {
          if (terminalResolved) return;
          terminalResolved = true;
          resolveTerminal();
        },
      });
      const task: BackgroundTask = {
        id: taskId,
        toolName,
        status: "running",
        startedAt: clock.now(),
        origin: acceptedOrigin,
        // Seed the dispatch state machine. Default policy is "deferred" —
        // the dispatcher inspects dispatchState before firing fallback notify
        // (at-most-once).
        notificationPolicy: notificationPolicy ?? "deferred",
        dispatchState: "pending",
        continuationExecutionId: taskId,
        dispatchAttempts: 0,
        _promise: promise,
        _abortController: ac,
      };

      // Hard-timeout abort
      const timer = timers.setTimeout(() => {
        if (task.status === "running") {
          ac.abort();
          manager.fail(taskId, new Error("Hard timeout exceeded"));
        }
      }, maxBackgroundDurationMs);
      timer.unref();   // TimerHandle exposes .unref() by contract.
      task._hardTimeoutTimer = timer;

      tasks.set(taskId, task);
      incrementCounters(agentId);
      persistTaskSync(dataDir, task);

      emitObservationalEventSafely({ eventBus, logger }, "background_task:promoted", {
        agentId,
        taskId,
        toolName,
        timestamp: clock.now(),
      });

      return ok(taskId);
    },

    complete(taskId, result) {
      const task = tasks.get(taskId);
      if (!task || task.status !== "running") return;

      task.status = "completed";
      task.completedAt = clock.now();
      task.result = truncateResult(result);
      terminalSignals.get(taskId)?.resolve();

      if (task._hardTimeoutTimer) task._hardTimeoutTimer.cancel();
      decrementCounters(task.origin.turnScope.conversation.agentId);
      persistTaskSync(dataDir, task);

      const durationMs = task.completedAt - task.startedAt;
      emitObservationalEventSafely({ eventBus, logger }, "background_task:completed", {
        agentId: task.origin.turnScope.conversation.agentId,
        taskId,
        toolName: task.toolName,
        durationMs,
        origin: task.origin,
        timestamp: clock.now(),
      });

      // Notification routing lives in the completion runner subscribed above.
    },

    fail(taskId, error) {
      const task = tasks.get(taskId);
      if (!task || task.status !== "running") return;

      task.status = "failed";
      task.completedAt = clock.now();
      task.error = error instanceof Error ? error.message : String(error);
      terminalSignals.get(taskId)?.resolve();

      if (task._hardTimeoutTimer) task._hardTimeoutTimer.cancel();
      decrementCounters(task.origin.turnScope.conversation.agentId);
      persistTaskSync(dataDir, task);

      const durationMs = task.completedAt - task.startedAt;
      emitObservationalEventSafely({ eventBus, logger }, "background_task:failed", {
        agentId: task.origin.turnScope.conversation.agentId,
        taskId,
        toolName: task.toolName,
        error: task.error,
        durationMs,
        origin: task.origin,
        timestamp: clock.now(),
      });

      // See complete() above — the dispatcher owns notification routing.
    },

    cancel(taskId) {
      const task = tasks.get(taskId);
      if (!task) return err(new Error(`Task not found: ${taskId}`));
      if (task.status !== "running") return err(new Error(`Task ${taskId} is not running (status: ${task.status})`));

      task.status = "cancelled";
      task.completedAt = clock.now();
      terminalSignals.get(taskId)?.resolve();

      if (task._abortController) task._abortController.abort();
      if (task._hardTimeoutTimer) task._hardTimeoutTimer.cancel();
      decrementCounters(task.origin.turnScope.conversation.agentId);
      persistTaskSync(dataDir, task);

      emitObservationalEventSafely({ eventBus, logger }, "background_task:cancelled", {
        agentId: task.origin.turnScope.conversation.agentId,
        taskId,
        toolName: task.toolName,
        timestamp: clock.now(),
      });

      return ok(undefined);
    },

    getTask(taskId) {
      return tasks.get(taskId);
    },

    async waitForTask(taskId, onWaiting, waitHeartbeatMs = 60_000) {
      const task = tasks.get(taskId);
      if (!task) return err(new Error(`Background task not found: ${taskId}`));
      if (task.status !== "running") return ok(task);
      if (!task._promise) {
        return err(new Error(`Background task ${taskId} has no live execution to await`));
      }

      let waitHeartbeat: TimerHandle | undefined;
      if (onWaiting) {
        waitHeartbeat = timers.setInterval(() => {
          const progress = tryCatch(onWaiting);
          if (!progress.ok) {
            waitHeartbeat?.cancel();
            logger.warn(
              {
                taskId,
                toolName: task.toolName,
                hint: "Inspect the background_tasks progress callback; the underlying task continues",
                errorKind: "internal" as const,
              },
              "Background task wait heartbeat failed",
            );
          }
        }, waitHeartbeatMs);
        waitHeartbeat.unref();
      }

      const providerSettlement = fromPromise(task._promise);
      const terminalSignal = terminalSignals.get(taskId);
      const settled = terminalSignal
        ? await Promise.race([
            providerSettlement.then((result) => ({ kind: "provider" as const, result })),
            terminalSignal.promise.then(() => ({ kind: "terminal" as const })),
          ])
        : { kind: "provider" as const, result: await providerSettlement };
      waitHeartbeat?.cancel();
      const current = tasks.get(taskId);
      if (!current) return err(new Error(`Background task not found after waiting: ${taskId}`));
      if (current.status !== "running") return ok(current);

      if (settled.kind === "terminal") return ok(current);
      if (settled.result.ok) manager.complete(taskId, settled.result.value);
      else manager.fail(taskId, settled.result.error);
      const terminal = tasks.get(taskId);
      return terminal
        ? ok(terminal)
        : err(new Error(`Background task not found after completion: ${taskId}`));
    },

    getTasks(agentId) {
      return [...tasks.values()].filter((t) => t.origin.turnScope.conversation.agentId === agentId);
    },

    getAllTasks() {
      return [...tasks.values()];
    },

    recoverOnStartup() {
      const recovered = recoverTasks(dataDir);
      let count = 0;
      let dispatchPreserved = 0;
      for (const persisted of recovered) {
        // The persistence-write contract guarantees populated origin /
        // notificationPolicy / dispatchState on every task file.
        // background-task-persistence.ts rejects shape-malformed files
        // (missing id / toolName) before they reach here; we propagate the
        // persisted record as-is.
        const task: BackgroundTask = persisted as BackgroundTask;
        task.continuationExecutionId = persisted.continuationExecutionId;
        tasks.set(task.id, task);

        if (
          task.dispatchState === "delivered"
          || task.dispatchState === "parked_permanent"
          || task.dispatchState === "parked_uncertain"
          || task.dispatchState === "consumed_live"
          || persisted.status === "cancelled"
        ) {
          dispatchPreserved++;
          continue;
        }
        let recoveredLifecycle = true;
        if (task.dispatchState === "execution_claimed") {
          const candidate = { ...task, dispatchState: "pending" as const };
          const persistedReset = persistTaskAtomically(dataDir, candidate);
          if (persistedReset.ok) {
            task.dispatchState = "pending";
            reportPersistenceOutcome(task, persistedReset.value);
          } else {
            recoveredLifecycle = false;
          }
        } else if (task.dispatchState === "executing") {
          const candidate = { ...task, dispatchState: "parked_uncertain" as const };
          const persistedReset = persistTaskAtomically(dataDir, candidate);
          if (persistedReset.ok) {
            task.dispatchState = "parked_uncertain";
            reportPersistenceOutcome(task, persistedReset.value);
          } else {
            recoveredLifecycle = false;
          }
        } else if (task.dispatchState === "delivering") {
          const recoveredState: BackgroundSessionState = task.continuationOutbox?.deliveryProtection === "ledger"
            ? "ready_to_deliver"
            : "parked_uncertain";
          const candidate = { ...task, dispatchState: recoveredState };
          const persistedReset = persistTaskAtomically(dataDir, candidate);
          if (persistedReset.ok) {
            task.dispatchState = recoveredState;
            reportPersistenceOutcome(task, persistedReset.value);
          } else {
            recoveredLifecycle = false;
          }
        }
        if (!recoveredLifecycle) {
          logger.warn(
            {
              taskId: task.id,
              toolName: task.toolName,
              dispatchState: task.dispatchState,
              hint: "Repair protected background-task storage, then restart to retry lifecycle recovery",
              errorKind: "resource" as const,
            },
            "Background task lifecycle recovery could not be persisted",
          );
          emitObservationalEventSafely({ eventBus, logger }, "background_task:notified", {
            agentId: task.origin.turnScope.conversation.agentId,
            taskId: task.id,
            toolName: task.toolName,
            sessionKey: task.origin.conversationRef,
            notified: false,
            reason: "recovery_retry_required",
            traceId: task.origin.traceId,
            timestamp: clock.now(),
          });
          continue;
        }
        if (persisted.status === "completed") {
          count++;
          emitObservationalEventSafely({ eventBus, logger }, "background_task:completed", {
            agentId: task.origin.turnScope.conversation.agentId,
            taskId: task.id,
            toolName: task.toolName,
            durationMs: (persisted.completedAt ?? clock.now()) - persisted.startedAt,
            origin: task.origin,
            timestamp: clock.now(),
          });
        } else if (persisted.status === "failed") {
          count++;
          emitObservationalEventSafely({ eventBus, logger }, "background_task:failed", {
            agentId: task.origin.turnScope.conversation.agentId,
            taskId: task.id,
            toolName: task.toolName,
            error: persisted.error ?? "Background task failed",
            durationMs: (persisted.completedAt ?? clock.now()) - persisted.startedAt,
            origin: task.origin,
            timestamp: clock.now(),
          });
        }
      }
      if (count > 0) {
        logger.info({ count }, "Recovered background tasks marked as failed");
      }
      if (dispatchPreserved > 0) {
        logger.info(
          { count: dispatchPreserved },
          "Recovered tasks with preserved dispatch state (no re-emit)",
        );
      }
    },

    commitDispatchState(taskId, next, expected) {
      const task = tasks.get(taskId);
      if (!task) return ok(false);
      const current = task.dispatchState ?? "pending";
      if (expected && !expected.includes(current)) return ok(false);
      const dispatchAttempts = next === "execution_claimed"
        ? task.dispatchAttempts + 1
        : task.dispatchAttempts;
      const candidate = { ...task, dispatchState: next, dispatchAttempts };
      const persisted = persistTaskAtomically(dataDir, candidate);
      if (!persisted.ok) return persisted;
      task.dispatchState = next;
      task.dispatchAttempts = dispatchAttempts;
      reportPersistenceOutcome(task, persisted.value);
      return ok(true);
    },

    persistContinuationOutbox(taskId, outbox, expected) {
      const parsed = BackgroundContinuationOutboxSchema.safeParse(outbox);
      if (!parsed.success) return err(new Error("Background continuation outbox validation failed"));
      const task = tasks.get(taskId);
      if (!task) return err(new Error(`Background task not found: ${taskId}`));
      const current = task.dispatchState ?? "pending";
      if (expected && !expected.includes(current)) {
        return err(new Error(`Background task ${taskId} cannot persist an outbox from ${current}`));
      }
      const candidate = {
        ...task,
        continuationOutbox: parsed.data,
        dispatchState: "ready_to_deliver" as const,
      };
      const persisted = persistTaskAtomically(dataDir, candidate);
      if (!persisted.ok) return persisted;
      task.continuationOutbox = parsed.data;
      task.dispatchState = "ready_to_deliver";
      reportPersistenceOutcome(task, persisted.value);
      return ok(undefined);
    },

    scheduleDispatchRetry(taskId) {
      const task = tasks.get(taskId);
      if (
        !task
        || (task.dispatchState !== "pending" && task.dispatchState !== "ready_to_deliver")
        || dispatchRetryTimers.has(taskId)
      ) return;
      const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(task.dispatchAttempts, 6)));
      const retry = timers.setTimeout(() => {
        dispatchRetryTimers.delete(taskId);
        const current = tasks.get(taskId);
        if (
          !current
          || (current.dispatchState !== "pending" && current.dispatchState !== "ready_to_deliver")
        ) return;
        const event = current.status === "completed"
          ? "background_task:completed" as const
          : current.status === "failed"
            ? "background_task:failed" as const
            : undefined;
        if (event === undefined) return;
        const common = {
          agentId: current.origin.turnScope.conversation.agentId,
          taskId: current.id,
          toolName: current.toolName,
          durationMs: (current.completedAt ?? clock.now()) - current.startedAt,
          origin: current.origin,
          timestamp: clock.now(),
        };
        if (event === "background_task:completed") {
          emitObservationalEventSafely({ eventBus, logger }, event, common);
        } else {
          emitObservationalEventSafely({ eventBus, logger }, event, {
            ...common,
            error: current.error ?? "Background task failed",
          });
        }
      }, delayMs);
      retry.unref();
      dispatchRetryTimers.set(taskId, retry);
    },

    cleanup(maxAgeMs = 86_400_000) {
      const cutoff = clock.now() - maxAgeMs;
      for (const [taskId, task] of tasks) {
        if (task.status !== "running" && (task.completedAt ?? task.startedAt) < cutoff) {
          tasks.delete(taskId);
          terminalSignals.delete(taskId);
          dispatchRetryTimers.get(taskId)?.cancel();
          dispatchRetryTimers.delete(taskId);
          removeTaskFile(dataDir, task.origin.turnScope.conversation.agentId, taskId);
        }
      }
    },
  };

  return manager;
}
