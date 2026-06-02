// SPDX-License-Identifier: Apache-2.0
/**
 * Detects Node's Permission Model refusal of the fd-based fs API family.
 *
 * Under `node --permission`, the syscalls that operate on a raw file
 * descriptor the model cannot path-check are categorically disabled —
 * `fs.fsyncSync`, `fs.fdatasyncSync`, `FileHandle.sync()`, AND
 * `fs.fchmodSync` / `fs.fchownSync` — each refused outright with the shared
 * wording:
 *
 *   "<syscall> API is disabled when Permission Model is enabled."
 *
 * There is no allow-flag to re-enable them. The production daemon runs under
 * `--permission` (see the systemd unit), so any of these calls on the boot or
 * runtime path MUST tolerate the refusal or the operation fails. Observed on a
 * production VPS (2026-06-02): the data-dir lock's fsync killed every boot
 * attempt; later, fchmod refusals broke MCP OAuth discovery (no
 * OAuth-protected MCP server could connect) and session-metadata writes.
 *
 * These calls are best-effort hardening layered on an already-completed
 * write/open: fsync is a durability optimization over a finished write+rename
 * (skipping it only widens the power-failure window), and the fchmod is a
 * defensive re-assertion of a mode the file was already opened with (0o600).
 * Skipping either never loses data nor loosens perms on a freshly-created
 * file. Callers therefore swallow THIS refusal specifically and still surface
 * genuine I/O failures (EIO, ENOSPC, EBADF) so real disk problems are not
 * masked.
 *
 * Pure predicate (no Node imports) so it can live in `@comis/shared` and be
 * reused by every such site across packages. (Named for fsync — the first and
 * canonical member of the family — but matches the whole disabled-API set.)
 */
export function isFsyncDisabledByPermissionModel(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false;
  // The permission model attaches `ERR_ACCESS_DENIED` to refused operations;
  // match it directly (robust to message wording across Node 22.x releases).
  if ((e as { code?: unknown }).code === "ERR_ACCESS_DENIED") return true;
  // Fall back to the documented message. Under --permission Node disables the
  // entire fd-based fs API family (fsync, fdatasync, fchmod, fchown) with the
  // shared wording "<syscall> API is disabled when Permission Model is
  // enabled." Match that exact categorical phrase so a generic permission-model
  // denial, or an unrelated I/O error that merely mentions one of these
  // syscalls, is NOT mistaken for the API-disablement refusal.
  const message = (e as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    /\bis disabled when permission model is enabled\b/i.test(message)
  );
}
