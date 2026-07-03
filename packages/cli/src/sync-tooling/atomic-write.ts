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
 * This is the only atomic-write implementation in the codebase.
 * `packages/daemon/src/config/last-known-good.ts` uses `copyFileSync`
 * with no fsync; `packages/cli/src/commands/configure.ts` uses plain
 * `writeFileSync`. Neither is atomic; do not adapt either.
 *
 * @module
 */

import * as fs from "node:fs";
import { dirname } from "node:path";
import { ok, err, isFsyncDisabledByPermissionModel, type Result } from "@comis/shared";

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
 * - `CHOWN_FAILED` — rename succeeded but the post-write ownership
 *   restoration failed (e.g. caller lacks `CAP_CHOWN` and the original
 *   file was owned by a different uid). The new content is on disk,
 *   but its owner is the calling process rather than the original
 *   owner, which can lock the daemon out on next boot if the daemon
 *   runs as a service user. Caller should treat this as fatal and
 *   either re-run with sufficient privileges or chown manually.
 */
export type AtomicWriteError =
  | { code: "WRITE_FAILED"; path: string; cause: string }
  | { code: "RENAME_FAILED"; tempPath: string; targetPath: string; cause: string }
  | { code: "CHOWN_FAILED"; targetPath: string; uid: number; gid: number; cause: string };

/**
 * Atomically write `content` to `configPath`.
 *
 * Steps:
 *   1. Stat the existing target (if any) to capture uid:gid for ownership
 *      preservation across the rename.
 *   2. Open `${configPath}.sync-tooling.tmp` with mode 0o600.
 *   3. Write `content`, fsync the file fd, close it.
 *   4. Rename the temp over the target (atomic on POSIX same-fs).
 *   5. Open the parent directory and fsync it (Linux durability).
 *   6. If the original file was owned by a different uid:gid than the
 *      caller, `chownSync` the new file back to the original owner.
 *      This prevents the common production trap where running the CLI
 *      as root (because `systemctl` requires it) silently re-owns
 *      `~/.comis/config.yaml` to root and locks the unprivileged daemon
 *      service user out at the next restart.
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

  // Step 0: capture original ownership for preservation. If the file
  // doesn't exist yet (first-time write), there's nothing to preserve and
  // the new file inherits the caller's uid:gid — which is the correct
  // behavior for a brand-new config.
  let preserveUid: number | undefined;
  let preserveGid: number | undefined;
  try {
    const originalStat = fs.statSync(configPath);
    preserveUid = originalStat.uid;
    preserveGid = originalStat.gid;
  } catch {
    // ENOENT — first-time write, no ownership to preserve.
  }

  // Step 1: temp file open + write + fsync.
  try {
    fd = fs.openSync(tempPath, "w", 0o600);
    fs.writeSync(fd, content);
    // Best-effort durability fsync — Node's Permission Model disables the
    // fsync API; swallow that refusal (bytes already written) but let genuine
    // I/O errors fall through to the WRITE_FAILED path below.
    try {
      fs.fsyncSync(fd);
    } catch (fsyncErr) {
      if (!isFsyncDisabledByPermissionModel(fsyncErr)) throw fsyncErr;
    }
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

  // Step 2: close the temp fd.
  try {
    fs.closeSync(fd);
  } catch (e) {
    return err({ code: "WRITE_FAILED", path: tempPath, cause: String(e) });
  }

  // Step 3: atomic rename over the target.
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

  // Step 4: fsync the parent directory so the rename is itself crash-safe
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

  // Step 5: ownership preservation. The rename creates a file owned
  // by the calling process; if the original was owned by a different
  // uid:gid (e.g. CLI run as root, daemon runs as `comis`), chown
  // back to the original owner. Skip the chown when uid:gid already
  // match — that's the common path on dev workstations and doesn't
  // need CAP_CHOWN.
  if (preserveUid !== undefined && preserveGid !== undefined) {
    let needsChown = true;
    try {
      const newStat = fs.statSync(configPath);
      needsChown = newStat.uid !== preserveUid || newStat.gid !== preserveGid;
    } catch {
      // statSync on the new file shouldn't fail (we just renamed into it),
      // but if it does, fall through and attempt the chown.
    }
    if (needsChown) {
      try {
        fs.chownSync(configPath, preserveUid, preserveGid);
      } catch (e) {
        return err({
          code: "CHOWN_FAILED",
          targetPath: configPath,
          uid: preserveUid,
          gid: preserveGid,
          cause: String(e),
        });
      }
    }
  }

  return ok(undefined);
}
