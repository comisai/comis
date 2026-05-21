// SPDX-License-Identifier: Apache-2.0
/**
 * `readFileSnapshot` — sha256-hashing + POSIX stat helper for the
 * `config.observe` audit record (design §9.2) and any other consumer
 * that needs a single-pass file identity + stat snapshot.
 *
 * Design intent:
 *   - One call returns everything needed to populate the §9.2 file-state
 *     block: hash, bytes, mtimeMs/ctimeMs, dev/ino/mode/nlink/uid/gid.
 *   - `dev` and `ino` are STRINGIFIED — POSIX `stat.st_dev` and
 *     `st_ino` can exceed the JavaScript safe-integer range on some
 *     filesystems; the canonical §9.2 contract is `string | null`.
 *   - `lstat` (not `stat`) — symlink semantics matter for the dir-mode
 *     `0o700` invariant documented in design §1.4. A snapshot taken
 *     through a symlinked parent is rejected; the caller's
 *     symlink-rejecting writers (`appendRegularFile`) already enforce
 *     this for the target, and the snapshot mirrors the policy at
 *     read-time.
 *   - Defensive against every filesystem error: any failure (ENOENT,
 *     EACCES, EPERM, EISDIR-ish) → returns `null`. The caller's audit
 *     record reserves space for `exists:false` so a `null` snapshot is
 *     the correct "no usable record" signal.
 *
 * Symmetry with existing precedent:
 *   - `createCacheTrace` returns `null` when disabled (per
 *     `cache-trace/runtime.ts`). The null contract here matches.
 *   - No `Result<T, E>` because there's nothing actionable a caller can
 *     do with the error — the audit record's `exists:false` branch is
 *     the canonical recovery. Tight contract: snapshot or null.
 *
 * No log emit on failure — this is a pure helper. The caller decides
 * how to surface the absent snapshot.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

/**
 * One-shot identity + stat snapshot of a regular file.
 *
 * Field group:
 *   - **Hash** — `hash`: 64-char lowercase sha256 hex of the file bytes.
 *   - **Size** — `bytes`: file size in bytes (`buf.byteLength`).
 *   - **Time** — `mtimeMs`, `ctimeMs`: epoch milliseconds from `lstat`.
 *   - **Identity** — `dev`, `ino`: stringified for JS-safe-integer
 *     overflow protection (design §9.2 contract).
 *   - **Permissions / ownership** — `mode`, `nlink`, `uid`, `gid`:
 *     POSIX-native numbers.
 */
export interface FileSnapshot {
  /** 64-char lowercase sha256 hex of the file bytes. */
  readonly hash: string;
  /** File size in bytes. */
  readonly bytes: number;
  /** Modification time in epoch milliseconds. */
  readonly mtimeMs: number;
  /** Inode-change time in epoch milliseconds. */
  readonly ctimeMs: number;
  /** POSIX `stat.st_dev` stringified (JS safe-integer overflow protection). */
  readonly dev: string;
  /** POSIX `stat.st_ino` stringified (JS safe-integer overflow protection). */
  readonly ino: string;
  /** POSIX `stat.st_mode` (file-type + permission bits). */
  readonly mode: number;
  /** POSIX `stat.st_nlink` (hard-link count). */
  readonly nlink: number;
  /** POSIX `stat.st_uid` (owner UID). */
  readonly uid: number;
  /** POSIX `stat.st_gid` (owner GID). */
  readonly gid: number;
}

/**
 * Read a single-pass identity + stat snapshot of `filePath`.
 *
 * Returns `null` when:
 *   - the file does not exist (ENOENT),
 *   - the path is not a regular file (directory, symlink, socket,
 *     FIFO, block/char device),
 *   - any other filesystem error fires (EACCES, EPERM, etc.).
 *
 * The `null` contract is intentional — every caller of this helper
 * is an audit-record producer, and the `exists:false` branch of the
 * design-§9.2 schema is the canonical recovery. There is no
 * actionable distinction between "file missing" and "file present
 * but unreadable" at the audit-record level.
 *
 * `filePath` MUST be absolute. This helper does NOT compose paths —
 * the caller is responsible for `safePath`-rooted construction.
 */
export function readFileSnapshot(filePath: string): FileSnapshot | null {
  try {
    // lstat (not stat) so symlinks are rejected as non-files — the
    // dir-mode 0o700 invariant from design §1.4 extends to read-time:
    // an audit producer should not silently follow a symlink to a
    // sibling that may live outside the confined ancestor.
    const stat = lstatSync(filePath);
    if (!stat.isFile()) {
      return null;
    }
    const buf = readFileSync(filePath);
    const hash = createHash("sha256").update(buf).digest("hex");
    return {
      hash,
      bytes: buf.byteLength,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: String(stat.dev),
      ino: String(stat.ino),
      mode: stat.mode,
      nlink: stat.nlink,
      uid: stat.uid,
      gid: stat.gid,
    };
  } catch {
    // Any filesystem error → null. The caller's `exists:false` branch
    // covers this uniformly.
    return null;
  }
}
