// SPDX-License-Identifier: Apache-2.0
/**
 * Symlink-safe file-append helper for diagnostic artifact writers.
 *
 * `appendRegularFile()` is the runtime-side primitive that the
 * `@comis/observability` writer chassis (Plan 45-01 Task 9) calls under
 * the hood. It guarantees three properties at the actual `open()`
 * boundary that no path-string check can guarantee on its own:
 *
 *   1. **O_NOFOLLOW** — the kernel refuses to traverse a final
 *      component that is itself a symlink. POSIX-only flag; conditionally
 *      OR'd in via the same probe pattern as `@comis/observability`'s
 *      `resolveSafeOpenFlags`.
 *
 *   2. **`lstat` on the immediate parent** — refuses to write into a
 *      directory whose final component is a symlink. Catches the
 *      `evil-link → /elsewhere` case that O_NOFOLLOW alone cannot
 *      (O_NOFOLLOW only inspects the FINAL component of the path; the
 *      `dirname()` slot is opened as a regular path-walk by the kernel).
 *
 *   3. **`fchmodSync(fd, 0o600)`** — forces owner-only permissions on
 *      every successful open, even when the file already existed with
 *      wider permissions. The chmod is defensive against an earlier
 *      buggy writer that left a diagnostics file world-readable; the
 *      chmod-by-fd variant guarantees we never chmod a file that was
 *      swapped after we opened it.
 *
 * Returns `Result<{ totalBytes }, SymlinkParentRejected |
 * FileSizeLimitExceeded | Error>` per AGENTS.md §2.1. The size cap
 * (`maxFileBytes`) is optional; when set, the helper rejects an append
 * that would push the cumulative size past the cap (strict greater-than
 * — an append landing exactly at the cap is allowed).
 *
 * The implementation is intentionally synchronous (`fs.openSync` /
 * `fs.writeSync` / `fs.fstatSync`) — the observability writer chassis
 * (queued-file-writer) runs each open() inside a Promise.resolve() chain
 * so the synchronous I/O does not pin the event loop, and the open() +
 * fchmod + write + close sequence MUST be atomic w.r.t. surrounding
 * concurrent callers in the same writer (the queued promise chain
 * enforces sequencing; this helper enforces correctness of each step).
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { ok, err, type Result } from "@comis/shared";

/**
 * Returned when the immediate parent of the target is a symbolic link.
 *
 * O_NOFOLLOW catches a symlinked *final* component (the file itself);
 * the parent-`lstat` check is required to catch a symlinked
 * directory at the slot above the file.
 */
export class SymlinkParentRejected extends Error {
  public readonly name = "SymlinkParentRejected" as const;
  public readonly code = "SYMLINK_PARENT_REJECTED" as const;
  public readonly parent: string;

  constructor(parent: string) {
    super(
      `Refusing to write under a symlinked parent directory: "${parent}"`,
    );
    this.parent = parent;
  }
}

/** Returned when the size cap would be exceeded by the proposed append. */
export class FileSizeLimitExceeded extends Error {
  public readonly name = "FileSizeLimitExceeded" as const;
  public readonly code = "FILE_SIZE_LIMIT_EXCEEDED" as const;
  public readonly attemptedBytes: number;
  public readonly maxBytes: number;

  constructor(attemptedBytes: number, maxBytes: number) {
    super(
      `Append would exceed file size cap: ${attemptedBytes} > ${maxBytes} bytes`,
    );
    this.attemptedBytes = attemptedBytes;
    this.maxBytes = maxBytes;
  }
}

/** Options for `appendRegularFile`. */
export interface AppendRegularFileOptions {
  /** Absolute path to the target file. */
  readonly path: string;
  /** Bytes to append (encoded UTF-8 when string). */
  readonly content: string | Buffer;
  /** Maximum cumulative file size (bytes); omit for no cap. */
  readonly maxFileBytes?: number;
}

/** Result payload on success — total size of the file post-append. */
export interface AppendRegularFileSuccess {
  readonly totalBytes: number;
}

export type AppendRegularFileError =
  | SymlinkParentRejected
  | FileSizeLimitExceeded
  | Error;

/** O_NOFOLLOW probe — POSIX-only constant, undefined on Windows. */
function resolveOpenFlags(): number {
  let flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY;
  const nofollow = (fs.constants as Record<string, number | undefined>)[
    "O_NOFOLLOW"
  ];
  if (typeof nofollow === "number") flags |= nofollow;
  return flags;
}

/**
 * Append `content` to `path` under symlink-safe semantics.
 *
 * Steps (all-or-nothing — fd is closed in every exit path):
 *   1. `lstat` the immediate parent; reject `SymlinkParentRejected`
 *      when it's a symlink.
 *   2. `openSync` with `O_APPEND | O_CREAT | O_WRONLY | O_NOFOLLOW`,
 *      mode `0o600`.
 *   3. `fchmodSync(fd, 0o600)` — defensive owner-only enforcement.
 *   4. `fstatSync(fd)` — read current size. If `maxFileBytes` is set
 *      and `current + content > max`, close fd and return
 *      `FileSizeLimitExceeded`.
 *   5. `writeSync(fd, contentBuffer)`.
 *   6. `closeSync(fd)`.
 *   7. Return `ok({ totalBytes })`.
 *
 * @param options - target path, content, optional size cap
 * @returns Result with `{ totalBytes }` on success, or one of the
 *   sentinel errors on failure.
 */
export function appendRegularFile(
  options: AppendRegularFileOptions,
): Result<AppendRegularFileSuccess, AppendRegularFileError> {
  const target = options.path;
  const buf =
    typeof options.content === "string"
      ? Buffer.from(options.content, "utf8")
      : options.content;
  const parentDir = path.dirname(target);

  // Step 1: lstat parent — refuse symlinked parent.
  try {
    const parentStat = fs.lstatSync(parentDir);
    if (parentStat.isSymbolicLink()) {
      return err(new SymlinkParentRejected(parentDir));
    }
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // Step 2: open under symlink-safe flags.
  let fd: number;
  try {
    fd = fs.openSync(target, resolveOpenFlags(), 0o600);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  try {
    // Step 3: defensive chmod.
    fs.fchmodSync(fd, 0o600);

    // Step 4: size-cap check.
    const stat = fs.fstatSync(fd);
    const projected = stat.size + buf.length;
    if (
      typeof options.maxFileBytes === "number" &&
      projected > options.maxFileBytes
    ) {
      return err(new FileSizeLimitExceeded(projected, options.maxFileBytes));
    }

    // Step 5: write.
    fs.writeSync(fd, buf);

    // Step 6: re-stat for the new total (post-write).
    const newSize = fs.fstatSync(fd).size;

    return ok({ totalBytes: newSize });
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  } finally {
    // Step 7: always close the fd, even on error.
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed or invalid — ignore.
    }
  }
}
