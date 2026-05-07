// SPDX-License-Identifier: Apache-2.0
/**
 * File-based persistence for background tasks.
 *
 * Uses synchronous file I/O (writeFileSync, readFileSync) to ensure
 * task state is persisted before returning placeholder to caller.
 *
 * @module
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { safePath } from "@comis/core";
import type { BackgroundTask, PersistedTaskState } from "./background-task-types.js";

/** Directory name under data dir for background task state files. */
export const TASK_DIR_NAME = "background-tasks";

/**
 * Extract the serializable subset from a BackgroundTask.
 *
 * Phase 15 v12 (D-S1, D-S2): notificationPolicy + dispatchState are copied
 * across when present so the state machine survives daemon restart-recovery
 * (AC-5). Both fields are optional in PersistedTaskState; we use spread-when-
 * defined to avoid emitting `"notificationPolicy": undefined` to disk for
 * legacy callers that do not set them.
 */
function toPersistedState(task: BackgroundTask | PersistedTaskState): PersistedTaskState {
  return {
    id: task.id,
    toolName: task.toolName,
    status: task.status,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    result: task.result,
    error: task.error,
    origin: task.origin,
    ...(task.notificationPolicy !== undefined && { notificationPolicy: task.notificationPolicy }),
    ...(task.dispatchState !== undefined && { dispatchState: task.dispatchState }),
  };
}

/**
 * Persist a task to disk synchronously.
 *
 * Writes to `dataDir/{agentId}/{taskId}.json`.
 */
export function persistTaskSync(dataDir: string, task: BackgroundTask | PersistedTaskState): void {
  const agentDir = safePath(dataDir, task.origin.agentId);
  mkdirSync(agentDir, { recursive: true });
  const filePath = safePath(agentDir, `${task.id}.json`);
  const state: PersistedTaskState = "_promise" in task ? toPersistedState(task as BackgroundTask) : task;
  writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Load a single task from disk.
 *
 * Returns undefined if the file does not exist or cannot be parsed.
 */
export function loadTask(dataDir: string, agentId: string, taskId: string): PersistedTaskState | undefined {
  const filePath = safePath(safePath(dataDir, agentId), `${taskId}.json`);
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as PersistedTaskState;
  } catch {
    return undefined;
  }
}

/**
 * Recover all tasks from disk on daemon startup.
 *
 * Scans all `dataDir/{agentId}/{taskId}.json` files. Tasks with status "running"
 * are marked as "failed" with an error message indicating daemon restart.
 */
export function recoverTasks(dataDir: string): PersistedTaskState[] {
  const recovered: PersistedTaskState[] = [];
  if (!existsSync(dataDir)) return recovered;

  let agentDirs: string[];
  try {
    agentDirs = readdirSync(dataDir);
  } catch {
    return recovered;
  }

  for (const agentId of agentDirs) {
    const agentDir = safePath(dataDir, agentId);
    // Phase 15.1-03 (WR-04 close): guard against non-directory entries in
    // dataDir. statSync may throw if the entry vanished between
    // readdirSync and here; skip gracefully. Non-directory entries
    // (lock files, READMEs, accidental file-with-agentId-name) MUST be
    // skipped explicitly so they don't shadow legitimate agent recovery
    // silently. See 15-REVIEW.md WR-04.
    let dirStat: ReturnType<typeof statSync>;
    try {
      dirStat = statSync(agentDir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    let files: string[];
    try {
      files = readdirSync(agentDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = safePath(agentDir, file);
      try {
        const raw = readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<PersistedTaskState>;
        // Sanity guard: skip completely malformed files (no id or toolName).
        // Files missing origin (pre-Phase-14) are passed through to the manager
        // so recoverOnStartup can warn about them and track the skip count.
        if (!parsed.id || !parsed.toolName) {
          continue;
        }
        const task = parsed as PersistedTaskState;
        if (task.status === "running") {
          task.status = "failed";
          task.error = "Daemon restarted while task was running";
          task.completedAt = Date.now();
          writeFileSync(filePath, JSON.stringify(task, null, 2), "utf-8");
        }
        recovered.push(task);
      } catch {
        // Skip unparseable files
      }
    }
  }

  return recovered;
}

/**
 * Remove a task file from disk. Silently ignores ENOENT.
 */
export function removeTaskFile(dataDir: string, agentId: string, taskId: string): void {
  const filePath = safePath(safePath(dataDir, agentId), `${taskId}.json`);
  try {
    unlinkSync(filePath);
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code !== "ENOENT") {
      throw e;
    }
  }
}
