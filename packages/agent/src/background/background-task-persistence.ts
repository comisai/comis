// SPDX-License-Identifier: Apache-2.0
// @allow-throw: background task persistence re-raise (line 147) inside try/catch wrapper; outer caller (executor) catches at PiExecutor boundary which is itself consumed by daemon RPC handlers.
/**
 * File-based persistence for background tasks.
 *
 * Uses synchronous file I/O via the `@comis/observability` fs-safe
 * substrate to ensure task state is persisted before returning a
 * placeholder to the caller. Every write goes through `writeRegularFile`
 * (file mode `0o600`) and every dir creation goes through
 * `ensureContainedDir` (dir mode `0o700`), honoring file-mode invariants
 * (files at `0o600`, dirs at `0o700`). `dataDir` is threaded as the `confinedBaseDir`
 * ancestor-symlink defense.
 *
 * @module
 */
import { readFileSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { safePath, systemNowMs } from "@comis/core";
import { ensureContainedDir, writeRegularFile } from "@comis/observability";
import type { BackgroundTask, PersistedTaskState } from "./background-task-types.js";

/** Directory name under data dir for background task state files. */
export const TASK_DIR_NAME = "background-tasks";

/**
 * Extract the serializable subset from a BackgroundTask.
 *
 * notificationPolicy + dispatchState are copied across when present so the
 * state machine survives daemon restart-recovery. Both fields are optional in
 * PersistedTaskState; we use spread-when-defined to avoid emitting
 * `"notificationPolicy": undefined` to disk for callers that do not set them.
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
 * Writes to `dataDir/{agentId}/{taskId}.json`. Routes through the
 * `@comis/observability` fs-safe substrate so the parent dir lands at
 * `0o700` and the file at `0o600` (file-mode invariants). `dataDir`
 * is passed as `confinedBaseDir` for the ancestor-symlink defense.
 *
 * Result errors are intentionally swallowed — this writer's contract is
 * best-effort persistence: a failure to persist must not propagate to the
 * caller (which already returned a placeholder to the agent). The
 * subsequent recovery scan will simply miss this task.
 */
export function persistTaskSync(dataDir: string, task: BackgroundTask | PersistedTaskState): void {
  const agentDir = safePath(dataDir, task.origin.turnScope.conversation.agentId);
  ensureContainedDir({ dir: agentDir, mode: 0o700, confinedBaseDir: dataDir });
  const filePath = safePath(agentDir, `${task.id}.json`);
  const state: PersistedTaskState = "_promise" in task ? toPersistedState(task as BackgroundTask) : task;
  writeRegularFile({ path: filePath, content: JSON.stringify(state, null, 2), confinedBaseDir: dataDir });
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
    // Guard against non-directory entries in dataDir. statSync may throw if
    // the entry vanished between readdirSync and here; skip gracefully.
    // Non-directory entries (lock files, READMEs, accidental
    // file-with-agentId-name) MUST be skipped explicitly so they don't
    // shadow legitimate agent recovery silently.
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
        // Shape guard — skip completely malformed files. Tasks always carry
        // id + toolName + origin; the producer-side persistTaskSync writes
        // all three unconditionally. A file failing this guard is either
        // truncated mid-write or a stale artifact operators should clean
        // up manually.
        if (!parsed.id || !parsed.toolName || !parsed.origin) {
          continue;
        }
        const task = parsed as PersistedTaskState;
        if (task.status === "running") {
          task.status = "failed";
          task.error = "Daemon restarted while task was running";
          task.completedAt = systemNowMs();
          writeRegularFile({ path: filePath, content: JSON.stringify(task, null, 2), confinedBaseDir: dataDir });
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
