// SPDX-License-Identifier: Apache-2.0
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
import { createHash, randomUUID } from "node:crypto";
import { safePath, SessionKeySchema } from "@comis/core";
import { ensureContainedDir } from "@comis/observability";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import { z } from "zod";
import type {
  AtomicTaskPersistenceOps,
  AtomicTaskPersistenceOutcome,
  TaskRecoveryOps,
} from "./background-task-persistence.js";

const RECOVERY_AUTHORITY_DIR = ".recovery-incidents";
const BoundedSessionKeySchema = SessionKeySchema.refine(
  (key) => Object.values(key).every(
    (value) => value === undefined || value.length <= 512,
  ),
);

export const BackgroundRecoveryAuthoritySchema = z.strictObject({
  agentId: z.string().min(1).max(256),
  taskId: z.string().min(1).max(512),
  toolName: z.string().min(1).max(256),
  sessionKey: z.string().min(1).max(2_048),
  projectedSessionKey: BoundedSessionKeySchema,
  traceId: z.string().max(512).nullable(),
  timestamp: z.number().finite(),
  source: z.enum(["task", "scan"]),
  requiredDisposition: z.enum(["pending", "accepted", "suppressed"]),
  resolutionRequested: z.boolean(),
});

export type BackgroundRecoveryAuthority = z.infer<
  typeof BackgroundRecoveryAuthoritySchema
>;

const defaultPersistenceOps: AtomicTaskPersistenceOps = {
  open: openSync,
  write: writeFileSync,
  sync: fsyncSync,
  close: closeSync,
  rename: renameSync,
  unlink: unlinkSync,
};

const defaultRecoveryOps: TaskRecoveryOps = {
  readdir: readdirSync,
  stat: (path) => statSync(path),
  read: (path) => readFileSync(path, "utf-8"),
};

function authorityDir(dataDir: string, agentId: string): string {
  return safePath(safePath(dataDir, agentId), RECOVERY_AUTHORITY_DIR);
}

function authorityFileName(taskId: string): string {
  return `${createHash("sha256").update(taskId).digest("hex")}.json`;
}

export function persistBackgroundRecoveryAuthority(
  dataDir: string,
  authority: BackgroundRecoveryAuthority,
  ops: AtomicTaskPersistenceOps = defaultPersistenceOps,
): Result<AtomicTaskPersistenceOutcome, Error> {
  const parsed = BackgroundRecoveryAuthoritySchema.safeParse(authority);
  if (!parsed.success) {
    return err(new Error("Background recovery authority validation failed"));
  }
  const agentDir = authorityDir(dataDir, parsed.data.agentId);
  const ensured = ensureContainedDir({
    dir: agentDir,
    mode: 0o700,
    confinedBaseDir: dataDir,
  });
  if (!ensured.ok) return err(ensured.error);
  const filePath = safePath(agentDir, authorityFileName(parsed.data.taskId));
  const tempPath = safePath(
    agentDir,
    `.${authorityFileName(parsed.data.taskId)}.${randomUUID()}.tmp`,
  );
  let fileDescriptor: number | undefined;
  let directoryDescriptor: number | undefined;
  let renamed = false;
  const written = tryCatch(() => {
    fileDescriptor = ops.open(tempPath, "wx", 0o600);
    ops.write(fileDescriptor, JSON.stringify(parsed.data, null, 2));
    ops.sync(fileDescriptor);
    ops.close(fileDescriptor);
    fileDescriptor = undefined;
    ops.rename(tempPath, filePath);
    renamed = true;
  });
  if (!written.ok) {
    if (fileDescriptor !== undefined) {
      tryCatch(() => ops.close(fileDescriptor!));
    }
    if (!renamed) tryCatch(() => ops.unlink(tempPath));
    return err(written.error);
  }
  let durabilityError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const synced = tryCatch(() => {
      directoryDescriptor = ops.open(agentDir, "r");
      ops.sync(directoryDescriptor);
      ops.close(directoryDescriptor);
      directoryDescriptor = undefined;
    });
    if (synced.ok) return ok({ kind: "committed" });
    durabilityError = synced.error;
    if (directoryDescriptor !== undefined) {
      tryCatch(() => ops.close(directoryDescriptor!));
      directoryDescriptor = undefined;
    }
  }
  return ok({
    kind: "committed_durability_uncertain",
    error: durabilityError
      ?? new Error("Background recovery authority durability was not confirmed"),
  });
}

export function recoverBackgroundRecoveryAuthorities(
  dataDir: string,
  ops: TaskRecoveryOps = defaultRecoveryOps,
): Result<BackgroundRecoveryAuthority[], Error> {
  const rootEntries = tryCatch(() => ops.readdir(dataDir));
  if (!rootEntries.ok) {
    const code = "code" in rootEntries.error ? rootEntries.error.code : undefined;
    return code === "ENOENT" ? ok([]) : err(rootEntries.error);
  }
  const authorities: BackgroundRecoveryAuthority[] = [];
  for (const agentId of rootEntries.value) {
    const agentDir = safePath(dataDir, agentId);
    const agentStat = tryCatch(() => ops.stat(agentDir));
    if (!agentStat.ok) return err(agentStat.error);
    if (!agentStat.value.isDirectory()) continue;
    const incidentDir = authorityDir(dataDir, agentId);
    const files = tryCatch(() => ops.readdir(incidentDir));
    if (!files.ok) {
      const code = "code" in files.error ? files.error.code : undefined;
      if (code === "ENOENT") continue;
      return err(files.error);
    }
    for (const file of files.value) {
      if (!file.endsWith(".json")) continue;
      const raw = tryCatch(() => ops.read(safePath(incidentDir, file)));
      if (!raw.ok) return err(raw.error);
      const decoded = tryCatch(() => JSON.parse(raw.value) as unknown);
      if (!decoded.ok) return err(decoded.error);
      const parsed = BackgroundRecoveryAuthoritySchema.safeParse(decoded.value);
      if (!parsed.success) {
        return err(new Error("Background recovery authority validation failed"));
      }
      authorities.push(parsed.data);
    }
  }
  return ok(authorities);
}

export function removeBackgroundRecoveryAuthority(
  dataDir: string,
  authority: Pick<BackgroundRecoveryAuthority, "agentId" | "taskId">,
  ops: Pick<AtomicTaskPersistenceOps, "unlink"> = defaultPersistenceOps,
): Result<void, Error> {
  const filePath = safePath(
    authorityDir(dataDir, authority.agentId),
    authorityFileName(authority.taskId),
  );
  const removed = tryCatch(() => ops.unlink(filePath));
  if (removed.ok) return ok(undefined);
  const code = "code" in removed.error ? removed.error.code : undefined;
  return code === "ENOENT" ? ok(undefined) : err(removed.error);
}
