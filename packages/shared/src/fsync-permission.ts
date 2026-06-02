// SPDX-License-Identifier: Apache-2.0
/**
 * Detects Node's Permission Model refusal of the fsync family.
 *
 * Under `node --permission`, `fs.fsyncSync`, `fs.fdatasyncSync`, and
 * `FileHandle.sync()` are categorically disabled — each operates on a raw file
 * descriptor the model cannot path-check, so Node refuses them outright with:
 *
 *   "fsync API is disabled when Permission Model is enabled."
 *
 * There is no `--allow-fsync` grant to re-enable it. The production daemon runs
 * under `--permission` (see the systemd unit), so any durability fsync on the
 * boot or runtime path MUST tolerate this refusal or the daemon FATAL-crashes
 * on startup (observed on a production VPS, 2026-06-02: the data-dir lock's
 * fsync killed every boot attempt).
 *
 * fsync is a durability optimization layered on top of an already-completed
 * write+rename: skipping it only widens the power-failure window, it never
 * loses data that was cleanly written before shutdown. Callers therefore
 * swallow THIS error specifically and still surface genuine I/O failures
 * (EIO, ENOSPC, EBADF) so real disk problems are not masked.
 *
 * Pure predicate (no Node imports) so it can live in `@comis/shared` and be
 * reused by every fsync site across packages.
 */
export function isFsyncDisabledByPermissionModel(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false;
  // The permission model attaches `ERR_ACCESS_DENIED` to refused operations;
  // match it directly (robust to message wording across Node 22.x releases).
  if ((e as { code?: unknown }).code === "ERR_ACCESS_DENIED") return true;
  // Fall back to the documented message — requires BOTH "fsync" and
  // "permission model" so a generic permission-model denial (or an unrelated
  // fsync I/O error) is not mistaken for this specific refusal.
  const message = (e as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    /fsync/i.test(message) &&
    /permission model/i.test(message)
  );
}
