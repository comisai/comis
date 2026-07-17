// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Node filesystem callbacks throw only inside tryCatch boundaries that immediately return Result.
/** Crash-durable owner-only registry for graph-report callback targets. */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { safePath } from "@comis/core";
import type {
  GraphReportCallbackRegistration,
  GraphReportStoreReplaceError,
  GraphReportTargetStore,
} from "@comis/orchestrator";
import { err, ok, tryCatch, type Result } from "@comis/shared";

const SNAPSHOT_FILE = "graph-report-targets.json";

function noFollowFlag(): number {
  return (fs.constants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
}

function directoryFlag(): number {
  return (fs.constants as Record<string, number | undefined>).O_DIRECTORY ?? 0;
}

function writeFully(fd: number, content: Buffer): Result<void, Error> {
  let offset = 0;
  while (offset < content.length) {
    const written = tryCatch(() => fs.writeSync(fd, content, offset, content.length - offset));
    if (!written.ok) return written;
    if (written.value <= 0) return err(new Error("Graph report target snapshot write made no progress"));
    offset += written.value;
  }
  return ok(undefined);
}

function readSnapshot(target: string): Result<readonly unknown[], Error> {
  let fd: number | undefined;
  const read = tryCatch(() => {
    const openedFd = fs.openSync(target, fs.constants.O_RDONLY | noFollowFlag());
    fd = openedFd;
    if (!fs.fstatSync(openedFd).isFile()) throw new Error("Graph report target snapshot is not a regular file");
    return fs.readFileSync(openedFd, "utf8");
  });
  const fdToClose = fd;
  if (fdToClose !== undefined) {
    const closed = tryCatch(() => fs.closeSync(fdToClose));
    if (read.ok && !closed.ok) return closed;
  }
  if (!read.ok) {
    if ((read.error as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
    return read;
  }
  const parsed = tryCatch(() => JSON.parse(read.value) as unknown);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value)) {
    return err(new Error("Graph report target snapshot must contain an array"));
  }
  return ok(parsed.value);
}

function replaceSnapshot(
  dataDir: string,
  target: string,
  records: readonly GraphReportCallbackRegistration[],
): Result<void, GraphReportStoreReplaceError> {
  const temp = safePath(dataDir, `.graph-report-targets-${randomBytes(12).toString("hex")}.tmp`);
  let fd: number | undefined;
  let renamed = false;
  const replaced = tryCatch(() => {
    const parent = fs.lstatSync(dataDir);
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new Error("Graph report target directory must be a real directory");
    }
    const openedFd = fs.openSync(
      temp,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollowFlag(),
      0o600,
    );
    fd = openedFd;
    fs.fchmodSync(openedFd, 0o600);
    const written = writeFully(openedFd, Buffer.from(JSON.stringify(records), "utf8"));
    if (!written.ok) throw written.error;
    fs.fsyncSync(openedFd);
    fs.closeSync(openedFd);
    fd = undefined;
    fs.renameSync(temp, target);
    renamed = true;

    const directoryFd = fs.openSync(
      dataDir,
      fs.constants.O_RDONLY | directoryFlag() | noFollowFlag(),
    );
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  });
  const fdToClose = fd;
  if (fdToClose !== undefined) {
    tryCatch(() => fs.closeSync(fdToClose));
  }
  if (!renamed) {
    const removed = tryCatch(() => fs.unlinkSync(temp));
    if (!removed.ok && (removed.error as NodeJS.ErrnoException).code !== "ENOENT") {
      return err({ cause: removed.error, snapshot: "unchanged" });
    }
  }
  if (!replaced.ok) {
    return err({ cause: replaced.error, snapshot: renamed ? "visible" : "unchanged" });
  }
  return ok(undefined);
}

/** Create the sync registry used by the interactive callback authority. */
export function createGraphReportTargetStore(deps: { dataDir: string }): GraphReportTargetStore {
  const target = safePath(deps.dataDir, SNAPSHOT_FILE);
  return {
    load: () => readSnapshot(target),
    replace: (records) => replaceSnapshot(deps.dataDir, target, records),
  };
}
