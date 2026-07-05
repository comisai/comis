// SPDX-License-Identifier: Apache-2.0
/**
 * Durable Matrix session state: a small on-disk store, one JSON file under a
 * per-adapter `stateDir`, holding the `/sync` token, the device id, the
 * password-login access token, and the initial-sync watermark.
 *
 * Security posture (T-4, credential-at-rest):
 *  - The directory is created 0700 and the state file 0600 — no group/other
 *    bits — because the file holds the access token and device identity. The
 *    modes are set EXPLICITLY and re-`chmod`'d on every save: `mkdir`'s mode is
 *    ignored once the directory exists, and `writeFile`'s mode is ignored once
 *    the file exists, so relying on the creation mode alone would leave a
 *    later-widened directory or a pre-existing file world-readable.
 *  - Every path is built through `safePath`, never raw path joining, so a
 *    malformed segment can never escape the stateDir.
 *
 * Correctness posture (T-1, backlog replay):
 *  - `load()` returns defaults (watermark 0) ONLY for a genuinely fresh
 *    stateDir (the file is absent). A present-but-corrupt file is a hard error,
 *    never a silent reset — resetting the watermark to 0 would replay the whole
 *    room backlog past the initial-sync guard.
 *
 * The crypto-store snapshot is a separate concern and lands later; this store
 * intentionally owns only the plaintext-lifecycle fields and exposes its path
 * builder so an additional persisted artifact can reuse the same guard.
 *
 * @module
 */

import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import type { Result } from "@comis/shared";
import { ok, err, fromPromise, tryCatch } from "@comis/shared";
import { safePath } from "@comis/core";

/** The single JSON file the state store persists into the stateDir. */
const MATRIX_STATE_FILE = "sync-state.json";

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
 * @returns A store whose `save`/`load` round-trip the MatrixState.
 */
export function createMatrixStateStore(stateDir: string): MatrixStateStore {
  return {
    async load(): Promise<Result<MatrixState, Error>> {
      const built = tryCatch(() => matrixStateFilePath(stateDir, MATRIX_STATE_FILE));
      if (!built.ok) return err(built.error);

      const read = await fromPromise(readFile(built.value, "utf-8"));
      if (!read.ok) {
        // A genuinely fresh stateDir → defaults. A corrupt or unreadable file
        // is NOT silently defaulted: a watermark reset to 0 would replay the
        // whole backlog past the initial-sync guard (T-1).
        if (isNotFound(read.error)) return ok({ ...DEFAULT_STATE });
        return err(read.error);
      }

      const parsed = tryCatch(() => JSON.parse(read.value) as unknown);
      if (!parsed.ok) {
        return err(
          new Error(
            "Matrix state file is not valid JSON — refusing to reset the sync watermark (would replay backlog); repair or remove the file",
          ),
        );
      }
      return ok(toState(parsed.value));
    },

    async save(state: MatrixState): Promise<Result<void, Error>> {
      return fromPromise(
        (async () => {
          // mkdir's mode is ignored when the directory already exists, and
          // writeFile's mode is ignored when the file already exists — chmod
          // after each so the owner-only bits hold on every save, not just on
          // first creation.
          await mkdir(stateDir, { recursive: true, mode: DIR_MODE });
          await chmod(stateDir, DIR_MODE);
          const file = matrixStateFilePath(stateDir, MATRIX_STATE_FILE);
          await writeFile(file, JSON.stringify(state), { mode: FILE_MODE });
          await chmod(file, FILE_MODE);
        })(),
      );
    },
  };
}
