// SPDX-License-Identifier: Apache-2.0
/**
 * Atomic file write — temp + fsync + rename + parent-dir-fsync.
 *
 * Linux durability invariant: after `atomicWriteFile` returns ok, even
 * `kill -9` between writes leaves the filesystem in a consistent state
 * where `configPath` is either the old version OR the new version,
 * never partial. The parent-directory fsync ensures the rename itself
 * is durable on ext4.
 *
 * On macOS, fsync of a directory fd may return EINVAL (or be a no-op);
 * the parent-dir fsync error is swallowed so dev-on-macos works while
 * Linux production gets full durability.
 *
 * NEW pattern in this codebase — there is no reference impl to mirror.
 * `packages/daemon/src/config/last-known-good.ts` uses `copyFileSync`
 * with no fsync; `packages/cli/src/commands/configure.ts` uses plain
 * `writeFileSync`. Neither is atomic; do not adapt either.
 *
 * @module
 */

import * as fs from "node:fs";
import { dirname } from "node:path";
import { ok, err, type Result } from "@comis/shared";

/** Suffix for the temp file used during the atomic write dance. */
const TEMP_SUFFIX = ".sync-tooling.tmp";

/**
 * Discriminated error type for `atomicWriteFile`.
 *
 * - `WRITE_FAILED` — temp file open / write / fsync / close failed.
 *   The temp file (`path`) has been best-effort removed; the target
 *   file is unchanged.
 * - `RENAME_FAILED` — temp file was written successfully but the
 *   atomic rename to `targetPath` failed (e.g. EXDEV cross-device,
 *   EBUSY). The temp file is left in place so the caller can decide
 *   whether to clean up or salvage.
 */
export type AtomicWriteError =
  | { code: "WRITE_FAILED"; path: string; cause: string }
  | { code: "RENAME_FAILED"; tempPath: string; targetPath: string; cause: string };

/**
 * Atomically write `content` to `configPath`.
 *
 * Steps:
 *   1. Open `${configPath}.sync-tooling.tmp` with mode 0o600.
 *   2. Write `content`, fsync the file fd, close it.
 *   3. Rename the temp over the target (atomic on POSIX same-fs).
 *   4. Open the parent directory and fsync it (Linux durability).
 *
 * @param configPath - Absolute path of the target file to atomically replace.
 * @param content - File contents to write (UTF-8 string).
 */
export function atomicWriteFile(
  configPath: string,
  content: string,
): Result<void, AtomicWriteError> {
  const tempPath = configPath + TEMP_SUFFIX;
  let fd: number | undefined;

  // Phase 1: temp file open + write + fsync.
  try {
    fd = fs.openSync(tempPath, "w", 0o600);
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } catch (e) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort: fd may already be invalid
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // best-effort: temp may not exist
    }
    return err({ code: "WRITE_FAILED", path: tempPath, cause: String(e) });
  }

  // Phase 2: close the temp fd.
  try {
    fs.closeSync(fd);
  } catch (e) {
    return err({ code: "WRITE_FAILED", path: tempPath, cause: String(e) });
  }

  // Phase 3: atomic rename over the target.
  try {
    fs.renameSync(tempPath, configPath);
  } catch (e) {
    return err({
      code: "RENAME_FAILED",
      tempPath,
      targetPath: configPath,
      cause: String(e),
    });
  }

  // Phase 4: fsync the parent directory so the rename is itself crash-safe
  // on Linux ext4. macOS may not support directory fsync (EINVAL / ENOTSUP)
  // — swallow the error, this is a Linux-durability nice-to-have.
  try {
    const dirFd = fs.openSync(dirname(configPath), "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Non-fatal: macOS dev environments may reject dir-fd fsync.
  }

  return ok(undefined);
}
