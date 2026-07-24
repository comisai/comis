// SPDX-License-Identifier: Apache-2.0
// @allow-throw: filesystem exceptions are re-raised only inside tryCatch so this persistence boundary can return them as Result errors.
/**
 * File-based persistence for background tasks.
 *
 * Runtime admission uses a synchronous temp-file write, file sync, rename, and
 * directory sync before returning a placeholder. The best-effort convenience
 * writer uses `writeRegularFile`; both paths create directories through
 * `ensureContainedDir` and preserve the `0o600` file / `0o700` directory mode
 * invariants. `dataDir` is threaded as the `confinedBaseDir` ancestor-symlink
 * defense.
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
  read?(path: string): string | undefined;
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
  read: (path) => {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller supplies the confined safePath-derived task record path.
      return readFileSync(path, "utf-8");
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  },
  write: writeFileSync,
  sync: fsyncSync,
  close: closeSync,
  rename: renameSync,
  unlink: unlinkSync,
};

function readPriorTaskState(
  filePath: string,
  ops: AtomicTaskPersistenceOps,
): Result<string | undefined, Error> {
  return tryCatch(() => {
    if (ops.read) return ops.read(filePath);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is confined beneath the safePath-derived agent directory.
      return readFileSync(filePath, "utf-8");
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  });
}

/**
 * Make a post-rename admission rejection invisible to startup recovery.
 *
 * An existing accepted record is restored. A newly created record is first
 * replaced with synced, schema-invalid content and then removed, so even a
 * crash that preserves the directory entry cannot resurrect the rejected task.
 */
function rollbackRejectedTaskState(
  filePath: string,
  priorState: string | undefined,
  ops: AtomicTaskPersistenceOps,
): Result<void, Error> {
  let rollbackDescriptor: number | undefined;
  const restored = tryCatch(() => {
    rollbackDescriptor = ops.open(filePath, "w", 0o600);
    ops.write(rollbackDescriptor, priorState ?? "{}");
    ops.sync(rollbackDescriptor);
    ops.close(rollbackDescriptor);
    rollbackDescriptor = undefined;
    if (priorState === undefined) ops.unlink(filePath);
  });
  if (!restored.ok && rollbackDescriptor !== undefined) {
    tryCatch(() => ops.close(rollbackDescriptor!));
  }
  return restored;
}

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
  const priorState = readPriorTaskState(filePath, ops);
  if (!priorState.ok) return priorState;
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
  const rolledBack = rollbackRejectedTaskState(filePath, priorState.value, ops);
  if (!rolledBack.ok) return rolledBack;
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
 * This convenience writer is intentionally best-effort and provides no
 * admission guarantee. Runtime admission uses `persistTaskAtomically` instead,
 * so persistence failures surface before a background placeholder is returned.
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- safePath confines the dynamic identifiers to dataDir.
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- callers pass dataDir or paths confined beneath it.
    stat: (path) => statSync(path),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- callers pass task paths resolved through safePath.
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- safePath confines the dynamic identifiers to dataDir.
    unlinkSync(filePath);
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code !== "ENOENT") {
      throw e;
    }
  }
}
