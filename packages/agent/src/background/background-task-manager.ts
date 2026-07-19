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
import { ok, err, type Result } from "@comis/shared";
import { BackgroundTaskOriginSchema, emitObservationalEventSafely, type TypedEventBus, type ClockPort, type TimerPort } from "@comis/core";
import { persistTaskSync, recoverTasks, removeTaskFile } from "./background-task-persistence.js";
import type {
  BackgroundTask,
  BackgroundTaskOrigin,
  BackgroundSessionState,
  BackgroundTaskNotificationPolicy,
} from "./background-task-types.js";

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
  getTasks(agentId: string): BackgroundTask[];
  getAllTasks(): BackgroundTask[];
  recoverOnStartup(): void;
  cleanup(maxAgeMs?: number): void;
  /**
   * Atomically transition the in-memory task's dispatchState AND persist.
   * Returns true on success; false if task does not exist. The dispatcher
   * calls this from its handler so SIGKILL-recovery preserves the recovered
   * state across daemon restart.
   */
  transitionDispatchState(taskId: string, next: BackgroundSessionState): boolean;
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
  const perAgentCount = new Map<string, number>();
  let totalCount = 0;

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

      // Notification routing lives in the completion-dispatcher (subscribed
      // to background_task:completed above). The dispatcher inspects
      // task.dispatchState before firing the user-visible fallback, and the
      // runner skips when state is "notified" (single-owner contract, zero
      // spurious outbound).
    },

    fail(taskId, error) {
      const task = tasks.get(taskId);
      if (!task || task.status !== "running") return;

      task.status = "failed";
      task.completedAt = clock.now();
      task.error = error instanceof Error ? error.message : String(error);

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
        tasks.set(task.id, task);

        if (persisted.status === "failed" && persisted.error === "Daemon restarted while task was running") {
          // Recovery-without-events: if dispatchState is already "notified" or
          // "dispatched", the dispatcher already routed pre-restart; do NOT
          // re-emit the background_task:failed event (which would re-trigger
          // fallback).
          if (task.dispatchState === "notified" || task.dispatchState === "dispatched") {
            dispatchPreserved++;
            logger.debug(
              {
                taskId: task.id,
                dispatchState: task.dispatchState,
                hint: "Pre-restart dispatch state preserved; skipping re-emit (recovery-without-events)",
              },
              "Recovery: skipped re-emit",
            );
            continue;
          }
          count++;
          emitObservationalEventSafely({ eventBus, logger }, "background_task:failed", {
            agentId: task.origin.turnScope.conversation.agentId,
            taskId: task.id,
            toolName: task.toolName,
            error: persisted.error,
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

    transitionDispatchState(taskId, next) {
      const task = tasks.get(taskId);
      if (!task) return false;
      // Idempotent — same-state transitions are allowed (no-op write).
      task.dispatchState = next;
      // Persist atomically so recovery-after-SIGKILL sees the transition.
      persistTaskSync(dataDir, task);
      return true;
    },

    cleanup(maxAgeMs = 86_400_000) {
      const cutoff = clock.now() - maxAgeMs;
      for (const [taskId, task] of tasks) {
        if (task.status !== "running" && (task.completedAt ?? task.startedAt) < cutoff) {
          tasks.delete(taskId);
          removeTaskFile(dataDir, task.origin.turnScope.conversation.agentId, taskId);
        }
      }
    },
  };

  return manager;
}
