// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory pointer-file writer (best-effort sidecar).
 *
 * Per design §6.1 and §2.3, the trajectory recorder writes a best-effort
 * pointer file alongside the per-session JSONL at
 * `<sessionFile>.trajectory-path.json` with the shape:
 *
 * ```
 * {
 *   "traceSchema": "comis-trajectory-pointer",
 *   "schemaVersion": 1,
 *   "sessionId": "...",
 *   "runtimeFile": "/abs/path/to/<sessionFile>.trajectory.jsonl"
 * }
 * ```
 *
 * The pointer lets operators tailing `~/.comis/sessions/<id>.jsonl` find
 * where the trajectory lives when `COMIS_TRAJECTORY_DIR` redirects it.
 *
 * Safety contract (design §1.4 + §2.3):
 *   - Open with `O_CREAT | O_TRUNC | O_WRONLY | O_NOFOLLOW`, mode `0o600`.
 *   - Reject symlinked parent dirs (`lstatSync(dir).isSymbolicLink()`).
 *   - Best-effort: any error during the lstat/open/write/close trio is
 *     swallowed silently. A missing pointer file MUST NOT block trajectory
 *     writes — the pointer is purely a discovery hint, not a data dependency.
 *
 * The recorder is the only production caller; pointer-file writes happen
 * during recorder construction immediately after the writer is bound.
 *
 * @module
 */

import {
  closeSync,
  lstatSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  resolveTrajectoryPointerFilePath,
  resolveTrajectoryPointerOpenFlags,
} from "./paths.js";

/** Parameters for `writeTrajectoryPointerFileBestEffort`. */
export interface WriteTrajectoryPointerFileParams {
  /** Absolute path to the per-session JSONL writer's output file. */
  readonly sessionFile: string;
  /** Session identifier — written verbatim into the pointer body. */
  readonly sessionId: string;
  /** Absolute path to the resolved trajectory JSONL file. */
  readonly runtimeFile: string;
}

/**
 * Pointer-file mode — `0o600` per design §1.4 (every artifact file mode
 * is `0o600`).
 */
const POINTER_FILE_MODE = 0o600 as const;

/**
 * Pointer record schema literals — pinned per design §6.1 so parsers
 * fence-check on read.
 */
const POINTER_TRACE_SCHEMA = "comis-trajectory-pointer" as const;
const POINTER_SCHEMA_VERSION = 1 as const;

/**
 * Write the `<sessionFile>.trajectory-path.json` pointer file (best-effort).
 *
 * Behavior:
 *   - When the parent directory is a symbolic link, silently no-op.
 *   - When `open(O_CREAT|O_TRUNC|O_WRONLY|O_NOFOLLOW)` rejects (e.g.,
 *     `ELOOP` because the pointer file itself is a symlink, or `EACCES`
 *     because the parent isn't writable), silently no-op.
 *   - On any other error during the write/close, silently no-op.
 *
 * The contract is "best effort" by design — operators MUST not assume
 * the pointer file always exists. The trajectory file itself is the
 * source of truth; the pointer is a hint for discovery.
 *
 * Returns `void` so callers (the recorder factory) can fire-and-forget.
 */
export function writeTrajectoryPointerFileBestEffort(
  params: WriteTrajectoryPointerFileParams,
): void {
  const pointerPath = resolveTrajectoryPointerFilePath(params.sessionFile);
  const parentDir = dirname(pointerPath);

  // Reject symlinked parents per design §2.3. lstat catches the case
  // where the parent dir is a symlink (which the O_NOFOLLOW open would
  // also reject, but we want a clean no-op rather than relying on the
  // open-time errno).
  try {
    const parentStat = lstatSync(parentDir);
    if (parentStat.isSymbolicLink()) return;
  } catch {
    // Parent doesn't exist or stat failed — bail out silently. The
    // recorder's own file write will likely fail too; that's the
    // recorder's concern, not ours.
    return;
  }

  const body = JSON.stringify({
    traceSchema: POINTER_TRACE_SCHEMA,
    schemaVersion: POINTER_SCHEMA_VERSION,
    sessionId: params.sessionId,
    runtimeFile: params.runtimeFile,
  });

  let fd = -1;
  try {
    fd = openSync(
      pointerPath,
      resolveTrajectoryPointerOpenFlags(),
      POINTER_FILE_MODE,
    );
    writeSync(fd, body);
  } catch {
    // Best-effort — any open/write error is swallowed. Possible causes:
    //   - ELOOP: pointer path itself is a symlink (O_NOFOLLOW)
    //   - EACCES: parent dir not writable
    //   - ENOSPC, EIO, etc.
    // The pointer is a discovery hint, not a data dependency.
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // Close errors after a successful write are unobservable in
        // practice for regular files; swallow defensively.
      }
    }
  }
}
