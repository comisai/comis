// SPDX-License-Identifier: Apache-2.0
/**
 * Durable Matrix session state: a small on-disk store, one JSON file under a
 * per-adapter `stateDir`, holding the `/sync` token, the device id, the
 * password-login access token, and the initial-sync watermark.
 *
 * Security posture (T-4, credential-at-rest):
 *  - The directory is created 0700 and both the state file and its write-temp
 *    0600 — no group/other bits — because the file holds the access token and
 *    device identity. The modes are set EXPLICITLY and re-`chmod`'d on every
 *    save: `mkdir`'s mode is ignored once the directory exists, and
 *    `writeFile`'s mode is ignored once the file exists, so relying on the
 *    creation mode alone would leave a later-widened directory or a pre-existing
 *    file world-readable. The temp is chmod'd 0600 BEFORE the rename, so the
 *    real file is never briefly world-readable.
 *  - Every path is built through `safePath`, never raw path joining, so a
 *    malformed segment can never escape the stateDir.
 *
 * Correctness / availability posture:
 *  - Writes are ATOMIC: the state is written to a temp file then `rename`d over
 *    the target (rename is atomic on POSIX). `save()` runs on every delivered
 *    message and every sync-token batch, so a crash / power-loss during a direct
 *    write could truncate the file; the temp-then-rename leaves either the old
 *    or the new file, never a partial one.
 *  - `load()` returns defaults for a fresh stateDir (the file is absent) AND
 *    recovers to defaults — with a loud WARN — from a present-but-corrupt file,
 *    rather than bricking the channel until an operator deletes the file. This
 *    is safe because the AUTHORITATIVE boot-backlog guard is the sync-ready gate
 *    (an initial sync started without a token never delivers the backlog to the
 *    handler), not the watermark: a lost watermark degrades to a guarded fresh
 *    sync, not a replay (T-1). A genuine read I/O error (e.g. a permission
 *    problem) remains a hard error — that is operator misconfiguration, not the
 *    self-inflicted corruption path.
 *
 * The crypto-store snapshot is a separate concern and lands later; this store
 * intentionally owns only the plaintext-lifecycle fields and exposes its path
 * builder so an additional persisted artifact can reuse the same guard.
 *
 * @module
 */

import { mkdir, writeFile, readFile, chmod, rename } from "node:fs/promises";
import type { Result } from "@comis/shared";
import { ok, err, fromPromise, tryCatch } from "@comis/shared";
import { safePath } from "@comis/core";
import type { ComisLogger } from "@comis/core";

/** The single JSON file the state store persists into the stateDir. */
const MATRIX_STATE_FILE = "sync-state.json";
/** The temp file an atomic save writes before renaming over the target. */
const MATRIX_STATE_TMP_FILE = "sync-state.json.tmp";

/** Owner-only directory permissions (rwx------), no group/other bits. */
const DIR_MODE = 0o700;
/** Owner-only file permissions (rw-------), no group/other bits. */
const FILE_MODE = 0o600;

/** The durable per-adapter Matrix session state. */
export interface MatrixState {
  /** The `/sync` since-token, so a restart resumes rather than re-syncing. */
  syncToken?: string;
  /** The device id whose identity must survive restarts (the E2EE seam). */
  deviceId?: string;
  /** The access token minted by a password login, persisted across restarts. */
  accessToken?: string;
  /**
   * Highest processed `origin_server_ts` PER ROOM (`roomId -> ts`); the
   * backlog-replay guard. Per-room because Matrix gives no cross-room timestamp
   * monotonicity — a single scalar drops live messages in a quiet room after a
   * busier room advances, and fails to exclude a mid-run-joined room's backlog.
   */
  watermarks: Record<string, number>;
}

/** Load/save the durable Matrix session state. */
export interface MatrixStateStore {
  /** Load the persisted state; defaults (watermark 0) when none exists yet. */
  load(): Promise<Result<MatrixState, Error>>;
  /** Persist the state atomically-enough for a single-writer adapter. */
  save(state: MatrixState): Promise<Result<void, Error>>;
}

/** The state of a stateDir that has never been written. */
const DEFAULT_STATE: MatrixState = { watermarks: {} };

/**
 * Build a stateDir-relative file path through the traversal guard.
 *
 * Exposed so the store's callers (and any co-located persisted artifact) build
 * every path the same guarded way rather than joining strings by hand.
 *
 * @param stateDir - The absolute per-adapter state directory.
 * @param name - The file name within the stateDir.
 * @returns The resolved, guarded absolute path.
 * @throws PathTraversalError if the segment escapes the stateDir.
 */
export function matrixStateFilePath(stateDir: string, name: string): string {
  return safePath(stateDir, name);
}

/** True when a filesystem error is a missing-file (ENOENT) error. */
function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

/**
 * Coerce parsed JSON into a MatrixState, keeping only known, well-typed fields
 * and defaulting the watermark. Absent optionals stay absent so a round-trip
 * compares deep-equal to the saved object.
 */
function toState(raw: unknown): MatrixState {
  const obj = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const state: MatrixState = { watermarks: toWatermarks(obj.watermarks) };
  if (typeof obj.syncToken === "string") state.syncToken = obj.syncToken;
  if (typeof obj.deviceId === "string") state.deviceId = obj.deviceId;
  if (typeof obj.accessToken === "string") state.accessToken = obj.accessToken;
  return state;
}

/**
 * Coerce a parsed value into the per-room watermark map, keeping only
 * finite-number entries. A missing or malformed map yields an empty map (every
 * room then defaults to 0 — still guarded by the sync-ready gate on a boot).
 */
function toWatermarks(raw: unknown): Record<string, number> {
  const watermarks: Record<string, number> = {};
  if (raw === null || typeof raw !== "object") return watermarks;
  for (const [roomId, ts] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof ts === "number" && Number.isFinite(ts)) watermarks[roomId] = ts;
  }
  return watermarks;
}

/**
 * Create a durable state store rooted at `stateDir`.
 *
 * @param stateDir - The absolute per-adapter state directory (created 0700).
 * @param logger - Optional logger; a corrupt-file recovery is logged as a WARN.
 * @returns A store whose `save`/`load` round-trip the MatrixState.
 */
export function createMatrixStateStore(stateDir: string, logger?: ComisLogger): MatrixStateStore {
  return {
    async load(): Promise<Result<MatrixState, Error>> {
      const built = tryCatch(() => matrixStateFilePath(stateDir, MATRIX_STATE_FILE));
      if (!built.ok) return err(built.error);

      const read = await fromPromise(readFile(built.value, "utf-8"));
      if (!read.ok) {
        // A genuinely fresh stateDir → defaults. A genuine read I/O error (e.g.
        // a permission problem) is operator misconfiguration → a hard error.
        if (isNotFound(read.error)) return ok({ ...DEFAULT_STATE });
        return err(read.error);
      }

      const parsed = tryCatch(() => JSON.parse(read.value) as unknown);
      if (!parsed.ok) {
        // A corrupt/partial file (e.g. a pre-atomic-write crash, bit-rot, or a
        // hand-edit) recovers to defaults rather than bricking the channel. The
        // sync-ready gate — not the watermark — is the authoritative boot-backlog
        // guard, so a lost watermark degrades to a guarded fresh sync (T-1).
        logger?.warn(
          {
            channelType: "matrix" as const,
            errorKind: "resource" as const,
            hint: "The Matrix state file was unreadable JSON (likely a partial write from a crash); recovering with fresh defaults — the sync-ready gate keeps the boot backlog guarded",
          },
          "Matrix state file corrupt: recovering with defaults",
        );
        return ok({ ...DEFAULT_STATE });
      }
      return ok(toState(parsed.value));
    },

    async save(state: MatrixState): Promise<Result<void, Error>> {
      return fromPromise(
        (async () => {
          // mkdir's mode is ignored when the directory already exists, and
          // writeFile's mode is ignored when the temp already exists (a prior
          // crashed save) — chmod after each so the owner-only bits hold every
          // save, not just on first creation.
          await mkdir(stateDir, { recursive: true, mode: DIR_MODE });
          await chmod(stateDir, DIR_MODE);
          const file = matrixStateFilePath(stateDir, MATRIX_STATE_FILE);
          const tmp = matrixStateFilePath(stateDir, MATRIX_STATE_TMP_FILE);
          // Write the temp then atomically rename over the target: a crash
          // mid-write leaves either the old or the new file, never a truncated
          // one. Chmod the temp to 0600 BEFORE the rename so the real file is
          // never momentarily world-readable.
          await writeFile(tmp, JSON.stringify(state), { mode: FILE_MODE });
          await chmod(tmp, FILE_MODE);
          await rename(tmp, file);
        })(),
      );
    },
  };
}
