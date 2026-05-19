// SPDX-License-Identifier: Apache-2.0
/**
 * Symlink-safe file-append helper for diagnostic artifact writers.
 *
 * `appendRegularFile()` is the runtime-side primitive that the
 * `@comis/observability` writer chassis calls under the hood. It
 * guarantees three properties at the actual `open()` boundary that no
 * path-string check can guarantee on its own:
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

import { safePath } from "@comis/core";
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

/**
 * Returned when the resolved real path of the target (or its parent
 * when the target doesn't yet exist) escapes the configured
 * `confinedBaseDir`.
 *
 * The existing `SymlinkParentRejected` check only `lstat`s the IMMEDIATE
 * parent — an attacker controlling a grandparent (or any higher ancestor)
 * can pre-stage a symlink there which the kernel follows during normal
 * path-walk (O_NOFOLLOW inspects only the final component). When the
 * caller supplies `confinedBaseDir`, the helpers run
 * `fs.realpathSync(target_or_parent)` and assert the resolved path is
 * inside `fs.realpathSync(confinedBaseDir)`, closing the ancestor gap.
 * The option is opt-in so non-observability callers that write outside
 * `~/.comis/` continue to work.
 */
export class PathEscapesConfinementError extends Error {
  public readonly name = "PathEscapesConfinementError" as const;
  public readonly code = "PATH_ESCAPES_CONFINEMENT" as const;
  public readonly resolvedPath: string;
  public readonly baseDir: string;

  constructor(resolvedPath: string, baseDir: string) {
    super(
      `Refusing to write at "${resolvedPath}": resolved path escapes confinement base "${baseDir}"`,
    );
    this.resolvedPath = resolvedPath;
    this.baseDir = baseDir;
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
  /**
   * Opt-in real-path confinement base.
   *
   * When supplied, after the existing parent-`lstat` check passes the
   * helper runs `fs.realpathSync` on `target` (or its parent when the
   * target doesn't yet exist) and on `confinedBaseDir`, then asserts
   * the resolved target stays inside the resolved base. Returns
   * `PathEscapesConfinementError` on mismatch.
   *
   * The option closes the ancestor-symlink gap that O_NOFOLLOW +
   * parent-`lstat` together do NOT cover. Observability callers pass
   * `~/.comis/` here; non-observability callers (daemon scratchpads,
   * etc.) may legitimately omit it.
   */
  readonly confinedBaseDir?: string;
}

/** Result payload on success — total size of the file post-append. */
export interface AppendRegularFileSuccess {
  readonly totalBytes: number;
}

export type AppendRegularFileError =
  | SymlinkParentRejected
  | PathEscapesConfinementError
  | FileSizeLimitExceeded
  | Error;

/**
 * Assert `target`'s resolved real path stays inside `confinedBaseDir`'s
 * resolved real path.
 *
 * Behaviour:
 *   - `fs.realpathSync(confinedBaseDir)` — must exist (callers pass
 *     `~/.comis/` which is always pre-created by the daemon bootstrap).
 *   - `fs.realpathSync(target)` — when `target` doesn't yet exist
 *     (the typical first-write case for append), the ENOENT path
 *     resolves the parent and joins the basename. Other errors
 *     propagate to the caller's outer try/catch which converts to
 *     `Result.err`.
 *   - Boundary safety: matches `resolvedBase === resolvedTarget` OR
 *     `resolvedTarget.startsWith(resolvedBase + path.sep)`. The
 *     `+ path.sep` guard prevents a sibling-prefix path like
 *     `/tmp/base-evil/x` from sneaking past a naive `startsWith(base)`.
 *
 * Returns the rejection error when the check fails, `undefined` on
 * pass. Caller wraps in a `Result.err(...)` at the call site.
 *
 * @allow-throw: helper throws unexpected fs errors (non-ENOENT realpath)
 *   for the caller's outer try/catch to convert to `Result.err`. The
 *   surrounding callers (`appendRegularFile` step 1b, `writeRegularFile`
 *   step 1b) already wrap this in a try/catch that returns
 *   `Result.err`, preserving the package-wide Result invariant at the
 *   public boundary.
 */
function assertConfinedPath(
  target: string,
  confinedBaseDir: string,
): PathEscapesConfinementError | undefined {
  const baseResolved = fs.realpathSync(confinedBaseDir);
  let targetResolved: string;
  try {
    targetResolved = fs.realpathSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Target doesn't exist yet (first-write case). Resolve the parent
      // and join the basename — the ENOENT path can still surface an
      // escaping ancestor symlink via the parent's realpath. We use
      // `safePath(parentResolved, basename)` to satisfy the workspace
      // safePath rule; the basename is a single non-traversal segment
      // so the safePath check trivially passes (and ENOENT inside its
      // symlink-walk is swallowed — the target doesn't exist yet).
      const parentResolved = fs.realpathSync(path.dirname(target));
      targetResolved = safePath(parentResolved, path.basename(target));
    } else {
      // @allow-throw: unexpected fs error (EACCES, ENOTDIR on a
      // mid-path file, EIO, etc.) — propagate to the caller's outer
      // try/catch which converts to Result.err.
      throw err;
    }
  }
  if (
    targetResolved !== baseResolved &&
    !targetResolved.startsWith(baseResolved + path.sep)
  ) {
    return new PathEscapesConfinementError(targetResolved, baseResolved);
  }
  return undefined;
}

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

  // Step 1b: opt-in confinement-base check. Closes the ancestor-symlink
  // gap that step 1 misses (lstat only inspects the immediate parent).
  // When `confinedBaseDir` is undefined the check is skipped —
  // back-compat for non-observability callers.
  if (options.confinedBaseDir !== undefined) {
    try {
      const rejection = assertConfinedPath(target, options.confinedBaseDir);
      if (rejection !== undefined) return err(rejection);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
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

// ---------------------------------------------------------------------------
// writeRegularFile — symlink-safe write-truncate.
// ---------------------------------------------------------------------------

/** Options for `writeRegularFile`. */
export interface WriteRegularFileOptions {
  /** Absolute path to the target file. */
  readonly path: string;
  /** Bytes to write (encoded UTF-8 when string). Truncates existing content. */
  readonly content: string | Buffer;
  /**
   * When `true` (default), unlink any existing file/symlink at `path`
   * before opening. The unlink-before-open closes the window where an
   * attacker could pre-stage a symlink at `path` between caller's
   * existence check and the open.
   *
   * The subsequent open uses `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW`,
   * so any concurrent re-creation (race) fails with EEXIST rather than
   * silently following the new symlink.
   *
   * Set to `false` only when the caller has a stronger atomicity guarantee
   * (e.g., the path was just renamed-in via fs.renameSync); the open then
   * uses `O_CREAT | O_TRUNC | O_WRONLY | O_NOFOLLOW` which truncates an
   * existing regular file safely but would still follow a symlink at the
   * final component (O_NOFOLLOW rejects that).
   */
  readonly unlinkExisting?: boolean;
  /**
   * Opt-in real-path confinement base. Symmetric to
   * AppendRegularFileOptions.confinedBaseDir — see that field's docs
   * for the threat model and behaviour. Observability callers
   * (config-audit scrub) pass `~/.comis/`; non-observability callers
   * may legitimately omit it.
   */
  readonly confinedBaseDir?: string;
}

/** Result payload on success — total size of the file post-write. */
export interface WriteRegularFileSuccess {
  readonly totalBytes: number;
}

export type WriteRegularFileError =
  | SymlinkParentRejected
  | PathEscapesConfinementError
  | Error;

/** Resolve write-truncate flags with conditional O_NOFOLLOW + EXCL/TRUNC selector. */
function resolveWriteOpenFlags(useExcl: boolean): number {
  let flags =
    fs.constants.O_CREAT |
    fs.constants.O_WRONLY |
    (useExcl ? fs.constants.O_EXCL : fs.constants.O_TRUNC);
  const nofollow = (fs.constants as Record<string, number | undefined>)[
    "O_NOFOLLOW"
  ];
  if (typeof nofollow === "number") flags |= nofollow;
  return flags;
}

/**
 * Write-truncate `content` to `path` under symlink-safe semantics.
 *
 * Steps (all-or-nothing — fd is closed in every exit path):
 *   1. `lstat` the immediate parent; reject `SymlinkParentRejected`
 *      when it's a symlink.
 *   2. If `unlinkExisting !== false` (default true): `unlinkSync(path)`;
 *      swallow ENOENT.
 *   3. `openSync` with `O_CREAT | (O_EXCL when unlinked, else O_TRUNC) |
 *      O_WRONLY | O_NOFOLLOW`, mode `0o600`. The O_NOFOLLOW refuses to
 *      open a symlinked final component; O_EXCL after unlink prevents
 *      TOCTOU race re-creation; O_TRUNC handles the explicit non-unlink
 *      truncate case.
 *   4. `fchmodSync(fd, 0o600)` — defensive owner-only enforcement.
 *   5. `writeSync(fd, contentBuffer)`.
 *   6. `fstatSync(fd)` — read final size.
 *   7. `closeSync(fd)`.
 *   8. Return `ok({ totalBytes })`.
 *
 * @param options - target path, content, optional unlinkExisting flag
 * @returns Result with `{ totalBytes }` on success, or one of the
 *   sentinel errors on failure.
 */
export function writeRegularFile(
  options: WriteRegularFileOptions,
): Result<WriteRegularFileSuccess, WriteRegularFileError> {
  const target = options.path;
  const buf =
    typeof options.content === "string"
      ? Buffer.from(options.content, "utf8")
      : options.content;
  const parentDir = path.dirname(target);
  const unlinkExisting = options.unlinkExisting !== false; // default true

  // Step 1: lstat parent — refuse symlinked parent (same contract as appendRegularFile).
  try {
    const parentStat = fs.lstatSync(parentDir);
    if (parentStat.isSymbolicLink()) {
      return err(new SymlinkParentRejected(parentDir));
    }
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // Step 1b: opt-in confinement-base check. Mirrors the same gate
  // added to `appendRegularFile`. Closes the ancestor-symlink gap that
  // step 1 misses (lstat only inspects the immediate parent).
  // Back-compat: when `confinedBaseDir` is undefined the check is skipped.
  if (options.confinedBaseDir !== undefined) {
    try {
      const rejection = assertConfinedPath(target, options.confinedBaseDir);
      if (rejection !== undefined) return err(rejection);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // Step 2: unlink any existing entry (closes the symlink-pre-stage window).
  if (unlinkExisting) {
    try {
      fs.unlinkSync(target);
    } catch (e) {
      // ENOENT is expected (no prior file); any other error propagates.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  // Step 3: open under symlink-safe + EXCL (post-unlink) or TRUNC (explicit) flags.
  let fd: number;
  try {
    fd = fs.openSync(target, resolveWriteOpenFlags(unlinkExisting), 0o600);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  try {
    // Step 4: defensive chmod.
    fs.fchmodSync(fd, 0o600);

    // Step 5: write.
    fs.writeSync(fd, buf);

    // Step 6: re-stat for the final total.
    const finalSize = fs.fstatSync(fd).size;

    return ok({ totalBytes: finalSize });
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  } finally {
    // Step 7: always close the fd.
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed or invalid — ignore.
    }
  }
}
