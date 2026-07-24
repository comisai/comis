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
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { safePath } from "@comis/core";
import { ensureContainedDir, writeRegularFile } from "@comis/observability";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import {
  PersistedTaskStateSchema,
  type BackgroundTask,
  type BackgroundTaskOrigin,
  type PersistedTaskState,
} from "./background-task-types.js";

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
export function toPersistedState(task: BackgroundTask | PersistedTaskState): PersistedTaskState {
  return {
    id: task.id,
    toolName: task.toolName,
    status: task.status,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    result: task.result,
    error: task.error,
    origin: task.origin,
    continuationExecutionId: task.continuationExecutionId,
    dispatchAttempts: task.dispatchAttempts,
    ...(task.continuationOutbox !== undefined && { continuationOutbox: task.continuationOutbox }),
    ...(task.finalizedResult !== undefined && { finalizedResult: task.finalizedResult }),
    ...(task.notificationPolicy !== undefined && { notificationPolicy: task.notificationPolicy }),
    ...(task.dispatchState !== undefined && { dispatchState: task.dispatchState }),
  };
}

export interface AtomicTaskPersistenceOps {
  open(path: string, flags: string, mode?: number): number;
  write(fd: number, content: string): void;
  sync(fd: number): void;
  close(fd: number): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
}

export interface TaskRecoveryOps {
  readdir(path: string): string[];
  stat(path: string): NonNullable<ReturnType<typeof statSync>>;
  read(path: string): string;
}

export type TaskRecoveryFailureKind =
  | "root_read"
  | "agent_path"
  | "agent_stat"
  | "agent_read"
  | "task_path"
  | "task_read"
  | "task_parse"
  | "task_validation";

export interface TaskRecoveryFailure {
  readonly kind: TaskRecoveryFailureKind;
  readonly identity?: {
    readonly id: string;
    readonly toolName: string;
    readonly origin: BackgroundTaskOrigin;
  };
}

export interface TaskRecoveryScan {
  readonly tasks: PersistedTaskState[];
  readonly failures: TaskRecoveryFailure[];
}

export type AtomicTaskPersistenceOutcome =
  | { readonly kind: "committed" }
  | { readonly kind: "committed_without_fsync"; readonly error: Error }
  | { readonly kind: "committed_durability_uncertain"; readonly error: Error };

function isPermissionModelFsyncUnavailable(error: Error): boolean {
  const code = "code" in error ? error.code : undefined;
  return (
    code === "ERR_ACCESS_DENIED" &&
    error.message.includes("fsync API is disabled when Permission Model is enabled")
  );
}

const defaultAtomicTaskPersistenceOps: AtomicTaskPersistenceOps = {
  open: openSync,
  write: writeFileSync,
  sync: fsyncSync,
  close: closeSync,
  rename: renameSync,
  unlink: unlinkSync,
};

export function persistTaskAtomically(
  dataDir: string,
  task: BackgroundTask | PersistedTaskState,
  ops: AtomicTaskPersistenceOps = defaultAtomicTaskPersistenceOps,
): Result<AtomicTaskPersistenceOutcome, Error> {
  const agentDir = safePath(dataDir, task.origin.turnScope.conversation.agentId);
  const ensured = ensureContainedDir({ dir: agentDir, mode: 0o700, confinedBaseDir: dataDir });
  if (!ensured.ok) return err(ensured.error);
  const filePath = safePath(agentDir, `${task.id}.json`);
  const tempPath = safePath(agentDir, `.${task.id}.${randomUUID()}.tmp`);
  const state = toPersistedState(task);
  let fileDescriptor: number | undefined;
  let directoryDescriptor: number | undefined;
  let renamed = false;
  let fsyncUnavailableError: Error | undefined;
  const written = tryCatch(() => {
    fileDescriptor = ops.open(tempPath, "wx", 0o600);
    ops.write(fileDescriptor, JSON.stringify(state, null, 2));
    const synced = tryCatch(() => ops.sync(fileDescriptor!));
    if (!synced.ok) {
      if (!isPermissionModelFsyncUnavailable(synced.error)) throw synced.error;
      fsyncUnavailableError = synced.error;
    }
    ops.close(fileDescriptor);
    fileDescriptor = undefined;
    ops.rename(tempPath, filePath);
    renamed = true;
  });
  if (!written.ok) {
    if (fileDescriptor !== undefined) {
      tryCatch(() => ops.close(fileDescriptor!));
    }
    if (directoryDescriptor !== undefined) {
      tryCatch(() => ops.close(directoryDescriptor!));
    }
    if (!renamed) {
      tryCatch(() => ops.unlink(tempPath));
    }
    return err(written.error);
  }
  if (fsyncUnavailableError !== undefined) {
    return ok({ kind: "committed_without_fsync", error: fsyncUnavailableError });
  }
  let directorySyncError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const synced = tryCatch(() => {
      directoryDescriptor = ops.open(agentDir, "r");
      ops.sync(directoryDescriptor);
      ops.close(directoryDescriptor);
      directoryDescriptor = undefined;
    });
    if (synced.ok) return ok({ kind: "committed" });
    if (isPermissionModelFsyncUnavailable(synced.error)) {
      return ok({ kind: "committed_without_fsync", error: synced.error });
    }
    directorySyncError = synced.error;
    if (directoryDescriptor !== undefined) {
      tryCatch(() => ops.close(directoryDescriptor!));
      directoryDescriptor = undefined;
    }
  }
  return err(directorySyncError ?? new Error("Background task directory durability was not confirmed"));
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
 * Recover all task records from disk without changing their lifecycle state.
 */
export function recoverTasks(
  dataDir: string,
  ops: TaskRecoveryOps = {
    readdir: readdirSync,
    stat: (path) => statSync(path),
    read: (path) => readFileSync(path, "utf-8"),
  },
): TaskRecoveryScan {
  const tasks: PersistedTaskState[] = [];
  const failures: TaskRecoveryFailure[] = [];
  const root = tryCatch(() => ops.readdir(dataDir));
  if (!root.ok) {
    const code = "code" in root.error ? root.error.code : undefined;
    if (code !== "ENOENT") failures.push({ kind: "root_read" });
    return { tasks, failures };
  }

  for (const agentId of root.value) {
    const resolvedAgentDir = tryCatch(() => safePath(dataDir, agentId));
    if (!resolvedAgentDir.ok) {
      failures.push({ kind: "agent_path" });
      continue;
    }
    const agentDir = resolvedAgentDir.value;
    const dirStat = tryCatch(() => ops.stat(agentDir));
    if (!dirStat.ok) {
      failures.push({ kind: "agent_stat" });
      continue;
    }
    if (!dirStat.value.isDirectory()) continue;
    const files = tryCatch(() => ops.readdir(agentDir));
    if (!files.ok) {
      failures.push({ kind: "agent_read" });
      continue;
    }

    for (const file of files.value) {
      if (!file.endsWith(".json")) continue;
      const resolvedFile = tryCatch(() => safePath(agentDir, file));
      if (!resolvedFile.ok) {
        failures.push({ kind: "task_path" });
        continue;
      }
      const raw = tryCatch(() => ops.read(resolvedFile.value));
      if (!raw.ok) {
        failures.push({ kind: "task_read" });
        continue;
      }
      const decoded = tryCatch(() => JSON.parse(raw.value) as unknown);
      if (!decoded.ok) {
        failures.push({ kind: "task_parse" });
        continue;
      }
      const parsed = PersistedTaskStateSchema.safeParse(decoded.value);
      if (!parsed.success) {
        const candidate = decoded.value as Record<string, unknown>;
        const identity = typeof candidate.id === "string"
          && candidate.id.length <= 512
          && typeof candidate.toolName === "string"
          && candidate.toolName.length <= 256
          ? PersistedTaskStateSchema.shape.origin.safeParse(candidate.origin)
          : undefined;
        failures.push({
          kind: "task_validation",
          ...(identity?.success
            ? {
                identity: {
                  id: candidate.id as string,
                  toolName: candidate.toolName as string,
                  origin: identity.data,
                },
              }
            : {}),
        });
        continue;
      }
      tasks.push(parsed.data);
    }
  }

  return { tasks, failures };
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
