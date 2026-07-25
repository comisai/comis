// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ErrorKind } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

export type DurableFileError = {
  code: "invalid_input" | "io";
  errorKind: ErrorKind;
  message: string;
};

export type ReplaceDurableFileInput = {
  filePath: string;
  bytes: Buffer;
  temporaryToken: () => string;
};

export async function replaceDurableFile(
  input: ReplaceDurableFileInput,
): Promise<Result<void, DurableFileError>> {
  if (!path.isAbsolute(input.filePath) || !Buffer.isBuffer(input.bytes)) {
    return err(durableFileError("invalid_input", "validation", "Durable file replacement requires an absolute path and exact bytes"));
  }
  const token = tryCatch(input.temporaryToken);
  if (!token.ok || !/^[A-Za-z0-9_-]{1,128}$/.test(token.value)) {
    return err(durableFileError("invalid_input", "validation", "Durable file replacement received an invalid temporary-file token"));
  }

  const directory = path.dirname(input.filePath);
  const temporaryPath = `${input.filePath}.${token.value}.tmp`;
  const made = await fromPromise(fs.mkdir(directory, { recursive: true, mode: 0o700 }));
  if (!made.ok) return err(ioError());
  const securedDirectory = await fromPromise(fs.chmod(directory, 0o700));
  if (!securedDirectory.ok) return err(ioError());
  const opened = await fromPromise(fs.open(temporaryPath, "wx", 0o600));
  if (!opened.ok) return err(ioError());

  const handle = opened.value;
  const wrote = await fromPromise(handle.writeFile(input.bytes));
  if (!wrote.ok) return cleanupFailure(handle, temporaryPath);
  const synced = await fromPromise(handle.sync());
  if (!synced.ok) return cleanupFailure(handle, temporaryPath);
  const closed = await fromPromise(handle.close());
  if (!closed.ok) return cleanupFailure(undefined, temporaryPath);

  const renamed = await fromPromise(fs.rename(temporaryPath, input.filePath));
  if (!renamed.ok) return cleanupFailure(undefined, temporaryPath);
  const securedFile = await fromPromise(fs.chmod(input.filePath, 0o600));
  if (!securedFile.ok) return err(ioError());

  const openedDirectory = await fromPromise(fs.open(directory, "r"));
  if (!openedDirectory.ok) return err(ioError());
  const directoryHandle = openedDirectory.value;
  const syncedDirectory = await fromPromise(directoryHandle.sync());
  const closedDirectory = await fromPromise(directoryHandle.close());
  if (!syncedDirectory.ok || !closedDirectory.ok) return err(ioError());
  return ok(undefined);
}

async function cleanupFailure(
  handle: fs.FileHandle | undefined,
  temporaryPath: string,
): Promise<Result<void, DurableFileError>> {
  if (handle !== undefined) await fromPromise(handle.close());
  await fromPromise(fs.unlink(temporaryPath));
  return err(ioError());
}

function ioError(): DurableFileError {
  return durableFileError("io", "internal", "Unable to durably replace scheduler authority file");
}

function durableFileError(
  code: DurableFileError["code"],
  errorKind: ErrorKind,
  message: string,
): DurableFileError {
  return { code, errorKind, message };
}
