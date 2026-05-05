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
import { ok, err, suppressError, type Result } from "@comis/shared";
import type { TypedEventBus } from "@comis/core";
import { persistTaskSync, recoverTasks, removeTaskFile } from "./background-task-persistence.js";
import type { BackgroundTask, BackgroundTaskOrigin } from "./background-task-types.js";

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
  promote(
    toolName: string,
    promise: Promise<unknown>,
    ac: AbortController,
    origin: BackgroundTaskOrigin,
  ): Result<string, Error>;
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
    promote(toolName, promise, ac, origin) {
      // SPEC AC-3: reject calls with missing/invalid origin (no silent fallback).
      if (!origin || typeof origin !== "object") {
        return err(new Error("BackgroundTaskOrigin is required (received undefined or non-object)"));
      }
      if (!origin.agentId || origin.agentId.length === 0) {
        return err(new Error("BackgroundTaskOrigin.agentId must be a non-empty string"));
      }
      if (!origin.sessionKey || origin.sessionKey.length === 0) {
        return err(new Error("BackgroundTaskOrigin.sessionKey must be a non-empty string"));
      }
      if (!origin.channelType || origin.channelType.length === 0) {
        return err(new Error("BackgroundTaskOrigin.channelType must be a non-empty string"));
      }
      if (!origin.channelId || origin.channelId.length === 0) {
        return err(new Error("BackgroundTaskOrigin.channelId must be a non-empty string"));
      }
      // traceId may be null (per BackgroundTaskOriginSchema), so no length check.
      // backgroundHopCount has a schema-level default of 0; no inline guard needed.

      const agentId = origin.agentId;
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
        startedAt: Date.now(),
        origin,
        _promise: promise,
        _abortController: ac,
      };

      // Hard-timeout abort
      const timer = setTimeout(() => {
        if (task.status === "running") {
          ac.abort();
          manager.fail(taskId, new Error("Hard timeout exceeded"));
        }
      }, maxBackgroundDurationMs);
      timer.unref();
      task._hardTimeoutTimer = timer;

      tasks.set(taskId, task);
      incrementCounters(agentId);
      persistTaskSync(dataDir, task);

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
      decrementCounters(task.origin.agentId);
      persistTaskSync(dataDir, task);

      const durationMs = task.completedAt - task.startedAt;
      eventBus.emit("background_task:completed", {
        agentId: task.origin.agentId,
        taskId,
        toolName: task.toolName,
        durationMs,
        origin: task.origin,
        timestamp: Date.now(),
      });

      if (notifyFn) {
        suppressError(
          notifyFn({
            agentId: task.origin.agentId,
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
      decrementCounters(task.origin.agentId);
      persistTaskSync(dataDir, task);

      const durationMs = task.completedAt - task.startedAt;
      eventBus.emit("background_task:failed", {
        agentId: task.origin.agentId,
        taskId,
        toolName: task.toolName,
        error: task.error,
        durationMs,
        origin: task.origin,
        timestamp: Date.now(),
      });

      if (notifyFn) {
        suppressError(
          notifyFn({
            agentId: task.origin.agentId,
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
      decrementCounters(task.origin.agentId);
      persistTaskSync(dataDir, task);

      eventBus.emit("background_task:cancelled", {
        agentId: task.origin.agentId,
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
      return [...tasks.values()].filter((t) => t.origin.agentId === agentId);
    },

    getAllTasks() {
      return [...tasks.values()];
    },

    recoverOnStartup() {
      const recovered = recoverTasks(dataDir);
      let count = 0;
      let skipped = 0;
      for (const persisted of recovered) {
        if (!persisted.origin || typeof persisted.origin !== "object" || !persisted.origin.agentId || !persisted.origin.sessionKey) {
          // Legacy file without origin (pre-Phase-14). Per SPEC "Out of scope:
          // backward-compat shims", skip with a warning -- the file remains on
          // disk for audit, but the manager doesn't import it.
          skipped++;
          logger.warn(
            {
              taskId: persisted.id,
              hint: "Pre-Phase-14 task file lacks origin; skipping recovery -- delete the file or wait for cleanup",
              errorKind: "internal" as const,
            },
            "Skipping recovered task without origin",
          );
          continue;
        }
        const task: BackgroundTask = {
          ...persisted,
        };
        tasks.set(task.id, task);

        if (persisted.status === "failed" && persisted.error === "Daemon restarted while task was running") {
          count++;
          eventBus.emit("background_task:failed", {
            agentId: task.origin.agentId,
            taskId: task.id,
            toolName: task.toolName,
            error: persisted.error,
            durationMs: (persisted.completedAt ?? Date.now()) - persisted.startedAt,
            origin: task.origin,
            timestamp: Date.now(),
          });
        }
      }
      if (count > 0) {
        logger.info({ count }, "Recovered background tasks marked as failed");
      }
      if (skipped > 0) {
        logger.warn(
          {
            skipped,
            hint: "Pre-Phase-14 task files cannot be recovered without origin -- they remain on disk for audit",
            errorKind: "internal" as const,
          },
          "Skipped pre-Phase-14 task files during recovery",
        );
      }
    },

    cleanup(maxAgeMs = 86_400_000) {
      const cutoff = Date.now() - maxAgeMs;
      for (const [taskId, task] of tasks) {
        if (task.status !== "running" && (task.completedAt ?? task.startedAt) < cutoff) {
          tasks.delete(taskId);
          removeTaskFile(dataDir, task.origin.agentId, taskId);
        }
      }
    },
  };

  return manager;
}
