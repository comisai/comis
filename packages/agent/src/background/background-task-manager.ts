/**
 * Background task manager: tracks tool executions promoted to background.
 *
 * Factory function `createBackgroundTaskManager` returns a typed interface
 * managing full task lifecycle: promote, complete, fail, cancel, recover.
 *
 * @module
 */
import { randomUUID } from "node:crypto";
import { ok, err, suppressError, type Result } from "@comis/shared";
import type { TypedEventBus } from "@comis/core";
import { persistTaskSync, recoverTasks, removeTaskFile } from "./background-task-persistence.js";
import type { BackgroundTask, PersistedTaskState } from "./background-task-types.js";

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
  maxPerAgent?: number;
  maxTotal?: number;
  maxBackgroundDurationMs?: number;
}

export interface BackgroundTaskManager {
  promote(agentId: string, toolName: string, promise: Promise<unknown>, ac: AbortController): Result<string, Error>;
  complete(taskId: string, result: unknown, notifyFn?: NotifyFn): void;
  fail(taskId: string, error: unknown, notifyFn?: NotifyFn): void;
  cancel(taskId: string): Result<void, Error>;
  getTask(taskId: string): BackgroundTask | undefined;
  getTasks(agentId: string): BackgroundTask[];
  getAllTasks(): BackgroundTask[];
  recoverOnStartup(): void;
  cleanup(maxAgeMs?: number): void;
}

const MAX_RESULT_CHARS = 102_400; // 100KB

export function createBackgroundTaskManager(opts: BackgroundTaskManagerOpts): BackgroundTaskManager {
  const {
    dataDir,
    eventBus,
    logger,
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
    promote(agentId, toolName, promise, ac) {
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
        agentId,
        toolName,
        status: "running",
        startedAt: Date.now(),
        _promise: promise,
        _abortController: ac,
      };

      tasks.set(taskId, task);
      incrementCounters(agentId);

      // sync write BEFORE returning placeholder
      persistTaskSync(dataDir, task);

      // Hard timeout
      task._hardTimeoutTimer = setTimeout(() => {
        if (task.status === "running") {
          ac.abort();
          manager.fail(taskId, new Error("Hard timeout exceeded"));
        }
      }, maxBackgroundDurationMs);

      eventBus.emit("background_task:promoted", {
        agentId,
        taskId,
        toolName,
        timestamp: Date.now(),
      });

      return ok(taskId);
    },

    complete(taskId, result, notifyFn?) {
      const task = tasks.get(taskId);
      if (!task || task.status !== "running") return;

      task.status = "completed";
      task.completedAt = Date.now();
      task.result = truncateResult(result);

      if (task._hardTimeoutTimer) clearTimeout(task._hardTimeoutTimer);
      decrementCounters(task.agentId);
      persistTaskSync(dataDir, task);

      const durationMs = task.completedAt - task.startedAt;
      eventBus.emit("background_task:completed", {
        agentId: task.agentId,
        taskId,
        toolName: task.toolName,
        durationMs,
        timestamp: Date.now(),
      });

      if (notifyFn) {
        suppressError(
          notifyFn({
            agentId: task.agentId,
            message: `Background task "${task.toolName}" completed (${Math.round(durationMs / 1000)}s). Task ID: ${taskId}`,
            priority: "normal",
            origin: "background_task",
          }),
          "background task completion notification",
        );
      }
    },

    fail(taskId, error, notifyFn?) {
      const task = tasks.get(taskId);
      if (!task || task.status !== "running") return;

      task.status = "failed";
      task.completedAt = Date.now();
      task.error = error instanceof Error ? error.message : String(error);

      if (task._hardTimeoutTimer) clearTimeout(task._hardTimeoutTimer);
      decrementCounters(task.agentId);
      persistTaskSync(dataDir, task);

      const durationMs = task.completedAt - task.startedAt;
      eventBus.emit("background_task:failed", {
        agentId: task.agentId,
        taskId,
        toolName: task.toolName,
        error: task.error,
        durationMs,
        timestamp: Date.now(),
      });

      if (notifyFn) {
        suppressError(
          notifyFn({
            agentId: task.agentId,
            message: `Background task "${task.toolName}" failed: ${task.error}. Task ID: ${taskId}`,
            priority: "normal",
            origin: "background_task",
          }),
          "background task failure notification",
        );
      }
    },

    cancel(taskId) {
      const task = tasks.get(taskId);
      if (!task) return err(new Error(`Task not found: ${taskId}`));
      if (task.status !== "running") return err(new Error(`Task ${taskId} is not running (status: ${task.status})`));

      task.status = "cancelled";
      task.completedAt = Date.now();

      if (task._abortController) task._abortController.abort();
      if (task._hardTimeoutTimer) clearTimeout(task._hardTimeoutTimer);
      decrementCounters(task.agentId);
      persistTaskSync(dataDir, task);

      eventBus.emit("background_task:cancelled", {
        agentId: task.agentId,
        taskId,
        toolName: task.toolName,
        timestamp: Date.now(),
      });

      return ok(undefined);
    },

    getTask(taskId) {
      return tasks.get(taskId);
    },

    getTasks(agentId) {
      return [...tasks.values()].filter((t) => t.agentId === agentId);
    },

    getAllTasks() {
      return [...tasks.values()];
    },

    recoverOnStartup() {
      const recovered = recoverTasks(dataDir);
      let count = 0;
      for (const persisted of recovered) {
        // Only import tasks that were recovered (previously running -> now failed)
        const task: BackgroundTask = {
          ...persisted,
        };
        tasks.set(task.id, task);

        if (persisted.status === "failed" && persisted.error === "Daemon restarted while task was running") {
          count++;
          eventBus.emit("background_task:failed", {
            agentId: task.agentId,
            taskId: task.id,
            toolName: task.toolName,
            error: persisted.error,
            durationMs: (persisted.completedAt ?? Date.now()) - persisted.startedAt,
            timestamp: Date.now(),
          });
        }
      }
      if (count > 0) {
        logger.info({ count }, "Recovered background tasks marked as failed");
      }
    },

    cleanup(maxAgeMs = 86_400_000) {
      const cutoff = Date.now() - maxAgeMs;
      for (const [taskId, task] of tasks) {
        if (task.status !== "running" && (task.completedAt ?? task.startedAt) < cutoff) {
          tasks.delete(taskId);
          removeTaskFile(dataDir, task.agentId, taskId);
        }
      }
    },
  };

  return manager;
}
