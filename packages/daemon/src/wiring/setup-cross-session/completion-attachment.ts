// SPDX-License-Identifier: Apache-2.0
/** Safe snapshot preparation for files produced by background agent runs. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import {
  resolveWorkspaceDir,
  safePath,
  type AgentConfig,
  type AnnouncementDeadLetterAttachmentSnapshot,
  type AnnouncementDeadLetterAttachmentSource,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const SNAPSHOT_DIRECTORY = "completion-attachments";

export interface PreparedCompletionAttachment extends AnnouncementDeadLetterAttachmentSnapshot {
  cleanup(): Promise<Result<void, Error>>;
}

export interface PrepareCompletionAttachmentInput {
  dataDir: string;
  workspaceDir: string;
  sourcePath: string;
  maxBytes?: number;
  syncDirectory?: (path: string) => Promise<Result<void, Error>>;
}

export function createCompletionAttachmentPreparer(input: {
  dataDir: string;
  agents: Record<string, AgentConfig>;
}): (
  attachment: AnnouncementDeadLetterAttachmentSource,
) => Promise<Result<PreparedCompletionAttachment, Error>> {
  return (attachment) => {
    const sourceAgentConfig = input.agents[attachment.sourceAgentId]
      ?? input.agents["default"]
      ?? ({} as AgentConfig);
    return prepareCompletionAttachment({
      dataDir: input.dataDir,
      workspaceDir: resolveWorkspaceDir(
        sourceAgentConfig,
        attachment.sourceAgentId,
        input.dataDir || undefined,
      ),
      sourcePath: attachment.path,
      sourceAgentId: attachment.sourceAgentId,
    });
  };
}

function mimeTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".csv": return "text/csv";
    case ".json": return "application/json";
    case ".md": return "text/markdown";
    case ".pdf": return "application/pdf";
    case ".txt": return "text/plain";
    case ".zip": return "application/zip";
    default: return "application/octet-stream";
  }
}

async function close(handle: FileHandle): Promise<Result<void, Error>> {
  return fromPromise(handle.close());
}

async function syncDirectory(path: string): Promise<Result<void, Error>> {
  const opened = await fromPromise(open(path, constants.O_RDONLY));
  if (!opened.ok) return opened;
  const synced = await fromPromise(opened.value.sync());
  const closed = await close(opened.value);
  return synced.ok ? closed : synced;
}

function isConfinedPath(workspacePath: string, candidatePath: string): boolean {
  const segment = relative(workspacePath, candidatePath);
  if (segment === "" || segment === ".." || segment.startsWith(`..${sep}`)) {
    return false;
  }
  const reconstructed = tryCatch(() => safePath(workspacePath, segment));
  return reconstructed.ok && resolve(reconstructed.value) === resolve(candidatePath);
}

function resolveSnapshotPath(
  dataDir: string,
  attachment: AnnouncementDeadLetterAttachmentSnapshot,
): Result<string, Error> {
  const snapshotDirResult = tryCatch(() => safePath(dataDir, SNAPSHOT_DIRECTORY));
  if (!snapshotDirResult.ok) return snapshotDirResult;
  const snapshotDir = resolve(snapshotDirResult.value);
  const snapshotPath = resolve(attachment.path);
  const segment = relative(snapshotDir, snapshotPath);
  if (
    segment.length === 0
    || segment === ".."
    || segment.startsWith(`..${sep}`)
    || segment.includes(sep)
  ) {
    return err(new Error("Completion attachment snapshot path is invalid"));
  }
  return ok(snapshotPath);
}

async function readPinnedFile(
  path: string,
  expectedSize: number,
): Promise<Result<Buffer, Error>> {
  const opened = await fromPromise(open(path, constants.O_RDONLY | constants.O_NOFOLLOW));
  if (!opened.ok) return opened;
  const handle = opened.value;
  const initialStat = await fromPromise(handle.stat({ bigint: true }));
  if (
    !initialStat.ok
    || !initialStat.value.isFile()
    || initialStat.value.nlink !== 1n
    || initialStat.value.size !== BigInt(expectedSize)
  ) {
    await close(handle);
    return err(new Error("Completion attachment snapshot metadata is invalid"));
  }
  const content = Buffer.alloc(expectedSize);
  let offset = 0;
  while (offset < content.length) {
    const read = await fromPromise(handle.read(content, offset, content.length - offset, offset));
    if (!read.ok) {
      await close(handle);
      return read;
    }
    if (read.value.bytesRead === 0) {
      await close(handle);
      return err(new Error("Completion attachment snapshot changed while reading"));
    }
    offset += read.value.bytesRead;
  }
  const finalStat = await fromPromise(handle.stat({ bigint: true }));
  const closed = await close(handle);
  if (!finalStat.ok) return finalStat;
  if (!closed.ok) return closed;
  if (
    finalStat.value.dev !== initialStat.value.dev
    || finalStat.value.ino !== initialStat.value.ino
    || finalStat.value.size !== initialStat.value.size
    || finalStat.value.mtimeNs !== initialStat.value.mtimeNs
    || finalStat.value.ctimeNs !== initialStat.value.ctimeNs
  ) {
    return err(new Error("Completion attachment snapshot changed while reading"));
  }
  return ok(content);
}

/**
 * Pin, bound, hash, and snapshot one generated file before it crosses a
 * channel boundary. The source must be a single-link regular file inside the
 * producing agent's real workspace; the channel receives only the owner-only
 * immutable snapshot.
 */
export async function prepareCompletionAttachment(
  input: PrepareCompletionAttachmentInput & { sourceAgentId?: string },
): Promise<Result<PreparedCompletionAttachment, Error>> {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return err(new Error("Completion attachment byte limit is invalid"));
  }

  const workspaceStat = await fromPromise(lstat(input.workspaceDir));
  if (!workspaceStat.ok || !workspaceStat.value.isDirectory() || workspaceStat.value.isSymbolicLink()) {
    return err(new Error("Completion attachment workspace is not a regular directory"));
  }
  const sourceStat = await fromPromise(lstat(input.sourcePath, { bigint: true }));
  if (
    !sourceStat.ok
    || !sourceStat.value.isFile()
    || sourceStat.value.isSymbolicLink()
    || sourceStat.value.nlink !== 1n
    || sourceStat.value.size > BigInt(maxBytes)
  ) {
    return err(new Error("Completion attachment is not a bounded regular file"));
  }
  const workspaceReal = await fromPromise(realpath(input.workspaceDir));
  const sourceReal = await fromPromise(realpath(input.sourcePath));
  if (!workspaceReal.ok || !sourceReal.ok || !isConfinedPath(workspaceReal.value, sourceReal.value)) {
    return err(new Error("Completion attachment is outside the producing workspace"));
  }

  const opened = await fromPromise(open(input.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW));
  if (!opened.ok) return opened;
  const handle = opened.value;
  const pinned = await fromPromise(handle.stat({ bigint: true }));
  if (
    !pinned.ok
    || !pinned.value.isFile()
    || pinned.value.nlink !== 1n
    || pinned.value.dev !== sourceStat.value.dev
    || pinned.value.ino !== sourceStat.value.ino
    || pinned.value.size !== sourceStat.value.size
    || pinned.value.size > BigInt(maxBytes)
  ) {
    await close(handle);
    return err(new Error("Completion attachment changed before snapshotting"));
  }

  const content = Buffer.alloc(Number(pinned.value.size));
  let offset = 0;
  while (offset < content.length) {
    const read = await fromPromise(handle.read(content, offset, content.length - offset, offset));
    if (!read.ok) {
      await close(handle);
      return read;
    }
    if (read.value.bytesRead === 0) {
      await close(handle);
      return err(new Error("Completion attachment changed while snapshotting"));
    }
    offset += read.value.bytesRead;
  }
  const finalStat = await fromPromise(handle.stat({ bigint: true }));
  const closed = await close(handle);
  if (!finalStat.ok) return finalStat;
  if (!closed.ok) return closed;
  if (
    finalStat.value.dev !== pinned.value.dev
    || finalStat.value.ino !== pinned.value.ino
    || finalStat.value.size !== pinned.value.size
    || finalStat.value.mtimeNs !== pinned.value.mtimeNs
    || finalStat.value.ctimeNs !== pinned.value.ctimeNs
  ) {
    return err(new Error("Completion attachment changed while snapshotting"));
  }

  const snapshotDirResult = tryCatch(() => safePath(input.dataDir, SNAPSHOT_DIRECTORY));
  if (!snapshotDirResult.ok) return snapshotDirResult;
  const snapshotDir = snapshotDirResult.value;
  const created = await fromPromise(mkdir(snapshotDir, { recursive: true, mode: 0o700 }));
  if (!created.ok) return created;
  const snapshotDirStat = await fromPromise(lstat(snapshotDir));
  if (
    !snapshotDirStat.ok
    || !snapshotDirStat.value.isDirectory()
    || snapshotDirStat.value.isSymbolicLink()
    || (snapshotDirStat.value.mode & 0o077) !== 0
  ) {
    return err(new Error("Completion attachment snapshot directory is not owner-only"));
  }

  const extension = extname(input.sourcePath).toLowerCase();
  const snapshotPathResult = tryCatch(() => safePath(snapshotDir, `${randomUUID()}${extension}`));
  if (!snapshotPathResult.ok) return snapshotPathResult;
  const snapshotPath = snapshotPathResult.value;
  const snapshotOpened = await fromPromise(open(
    snapshotPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  ));
  if (!snapshotOpened.ok) return snapshotOpened;
  const snapshotHandle = snapshotOpened.value;
  let snapshotOffset = 0;
  while (snapshotOffset < content.length) {
    const written = await fromPromise(snapshotHandle.write(
      content,
      snapshotOffset,
      content.length - snapshotOffset,
      snapshotOffset,
    ));
    if (!written.ok) {
      await close(snapshotHandle);
      await fromPromise(unlink(snapshotPath));
      return err(written.error);
    }
    if (written.value.bytesWritten === 0) {
      await close(snapshotHandle);
      await fromPromise(unlink(snapshotPath));
      return err(new Error("Completion attachment snapshot write stalled"));
    }
    snapshotOffset += written.value.bytesWritten;
  }
  const synced = await fromPromise(snapshotHandle.sync());
  const snapshotClosed = await close(snapshotHandle);
  if (!synced.ok) {
    await fromPromise(unlink(snapshotPath));
    return err(synced.error);
  }
  if (!snapshotClosed.ok) {
    await fromPromise(unlink(snapshotPath));
    return err(snapshotClosed.error);
  }
  const syncSnapshotDirectory = input.syncDirectory ?? syncDirectory;
  const directorySynced = await syncSnapshotDirectory(snapshotDir);
  if (!directorySynced.ok) {
    await fromPromise(unlink(snapshotPath));
    return directorySynced;
  }
  if (created.value !== undefined) {
    const parentSynced = await syncSnapshotDirectory(dirname(snapshotDir));
    if (!parentSynced.ok) {
      await fromPromise(unlink(snapshotPath));
      return parentSynced;
    }
  }

  const sourceName = basename(input.sourcePath);
  const snapshot: AnnouncementDeadLetterAttachmentSnapshot = {
    kind: "snapshot",
    sourceAgentId: input.sourceAgentId ?? "default",
    sourcePath: input.sourcePath,
    path: snapshotPath,
    fileName: sourceName.length <= 255 ? sourceName : sourceName.slice(-255),
    mimeType: mimeTypeFor(input.sourcePath),
    contentDigest: createHash("sha256").update(content).digest("hex"),
    sizeBytes: content.length,
  };
  return ok({
    ...snapshot,
    cleanup: () => cleanupCompletionAttachmentSnapshot(input.dataDir, snapshot),
  });
}

export async function verifyCompletionAttachmentSnapshot(
  dataDir: string,
  attachment: AnnouncementDeadLetterAttachmentSnapshot,
): Promise<Result<AnnouncementDeadLetterAttachmentSnapshot, Error>> {
  const snapshotPath = resolveSnapshotPath(dataDir, attachment);
  if (!snapshotPath.ok) return snapshotPath;
  const content = await readPinnedFile(snapshotPath.value, attachment.sizeBytes);
  if (!content.ok) return content;
  const digest = createHash("sha256").update(content.value).digest("hex");
  return digest === attachment.contentDigest
    ? ok(attachment)
    : err(new Error("Completion attachment snapshot digest does not match"));
}

export async function cleanupCompletionAttachmentSnapshot(
  dataDir: string,
  attachment: AnnouncementDeadLetterAttachmentSnapshot,
): Promise<Result<void, Error>> {
  const snapshotPath = resolveSnapshotPath(dataDir, attachment);
  if (!snapshotPath.ok) return snapshotPath;
  const removed = await fromPromise(unlink(snapshotPath.value));
  if (!removed.ok && (removed.error as NodeJS.ErrnoException).code !== "ENOENT") return removed;
  return ok(undefined);
}

export async function reconcileCompletionAttachmentSnapshots(
  dataDir: string,
  referencedPaths: readonly string[],
): Promise<Result<void, Error>> {
  const snapshotDirResult = tryCatch(() => safePath(dataDir, SNAPSHOT_DIRECTORY));
  if (!snapshotDirResult.ok) return snapshotDirResult;
  const snapshotDir = resolve(snapshotDirResult.value);
  const directoryStat = await fromPromise(lstat(snapshotDir));
  if (!directoryStat.ok) {
    return (directoryStat.error as NodeJS.ErrnoException).code === "ENOENT"
      ? ok(undefined)
      : directoryStat;
  }
  if (
    !directoryStat.value.isDirectory()
    || directoryStat.value.isSymbolicLink()
    || (directoryStat.value.mode & 0o077) !== 0
  ) {
    return err(new Error("Completion attachment snapshot directory is not owner-only"));
  }
  const referenced = new Set(referencedPaths.map((path) => resolve(path)));
  const listed = await fromPromise(readdir(snapshotDir, { withFileTypes: true }));
  if (!listed.ok) return listed;
  let removed = false;
  for (const entry of listed.value) {
    const candidate = tryCatch(() => safePath(snapshotDir, entry.name));
    if (!candidate.ok) return candidate;
    if (referenced.has(resolve(candidate.value))) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      return err(new Error("Completion attachment snapshot directory contains an invalid entry"));
    }
    const unlinked = await fromPromise(unlink(candidate.value));
    if (!unlinked.ok) return unlinked;
    removed = true;
  }
  return removed ? syncDirectory(snapshotDir) : ok(undefined);
}
