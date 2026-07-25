// SPDX-License-Identifier: Apache-2.0
/** Safe snapshot preparation for files produced by background agent runs. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { resolveWorkspaceDir, safePath, type AgentConfig } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const SNAPSHOT_DIRECTORY = "completion-attachments";

export interface PreparedCompletionAttachment {
  path: string;
  fileName: string;
  mimeType: string;
  contentDigest: string;
  sizeBytes: number;
  cleanup(): Promise<Result<void, Error>>;
}

export interface PrepareCompletionAttachmentInput {
  dataDir: string;
  workspaceDir: string;
  sourcePath: string;
  maxBytes?: number;
}

export function createCompletionAttachmentPreparer(input: {
  dataDir: string;
  agents: Record<string, AgentConfig>;
}): (attachment: { sourceAgentId: string; path: string }) => Promise<Result<PreparedCompletionAttachment, Error>> {
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

function isConfinedPath(workspacePath: string, candidatePath: string): boolean {
  const segment = relative(workspacePath, candidatePath);
  if (segment === "" || segment === ".." || segment.startsWith(`..${sep}`)) {
    return false;
  }
  const reconstructed = tryCatch(() => safePath(workspacePath, segment));
  return reconstructed.ok && resolve(reconstructed.value) === resolve(candidatePath);
}

/**
 * Pin, bound, hash, and snapshot one generated file before it crosses a
 * channel boundary. The source must be a single-link regular file inside the
 * producing agent's real workspace; the channel receives only the owner-only
 * immutable snapshot.
 */
export async function prepareCompletionAttachment(
  input: PrepareCompletionAttachmentInput,
): Promise<Result<PreparedCompletionAttachment, Error>> {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return err(new Error("Completion attachment byte limit is invalid"));
  }

  const workspaceStat = await fromPromise(lstat(input.workspaceDir));
  if (!workspaceStat.ok || !workspaceStat.value.isDirectory() || workspaceStat.value.isSymbolicLink()) {
    return err(new Error("Completion attachment workspace is not a regular directory"));
  }
  const sourceStat = await fromPromise(lstat(input.sourcePath));
  if (
    !sourceStat.ok
    || !sourceStat.value.isFile()
    || sourceStat.value.isSymbolicLink()
    || sourceStat.value.nlink !== 1
    || sourceStat.value.size > maxBytes
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
  const pinned = await fromPromise(handle.stat());
  if (
    !pinned.ok
    || !pinned.value.isFile()
    || pinned.value.nlink !== 1
    || pinned.value.dev !== sourceStat.value.dev
    || pinned.value.ino !== sourceStat.value.ino
    || pinned.value.size !== sourceStat.value.size
    || pinned.value.size > maxBytes
  ) {
    await close(handle);
    return err(new Error("Completion attachment changed before snapshotting"));
  }

  const content = Buffer.alloc(pinned.value.size);
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
  const finalStat = await fromPromise(handle.stat());
  const closed = await close(handle);
  if (!finalStat.ok) return finalStat;
  if (!closed.ok) return closed;
  if (
    finalStat.value.dev !== pinned.value.dev
    || finalStat.value.ino !== pinned.value.ino
    || finalStat.value.size !== pinned.value.size
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

  const sourceName = basename(input.sourcePath);
  return ok({
    path: snapshotPath,
    fileName: sourceName.length <= 255 ? sourceName : sourceName.slice(-255),
    mimeType: mimeTypeFor(input.sourcePath),
    contentDigest: createHash("sha256").update(content).digest("hex"),
    sizeBytes: content.length,
    cleanup: () => fromPromise(unlink(snapshotPath)),
  });
}
