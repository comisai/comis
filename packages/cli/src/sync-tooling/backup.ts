// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI helper consumed by command entry points; throws caught at Commander.js boundary per AGENTS.md §2.1.
/**
 * Pre-mutation backup helper for sync-tooling `--write` operations.
 *
 * Writes a byte-equal copy of the active config under `~/.comis/` with
 * a timestamped filename:
 *
 *   config.pre-<prefix>-<ISO-with-ms>-<6-hex>.yaml
 *   e.g. config.pre-sync-tooling-2026-05-10T12-34-56.789-a3f2c1.yaml
 *        config.pre-tooling-fill-2026-05-10T12-34-56.789-a3f2c1.yaml
 *
 * The `prefix` defaults to `"sync-tooling"`; the `tooling-fill` command
 * passes `"tooling-fill"` to land its backups in the same location.
 *
 * The 6-char hex suffix is `crypto.randomBytes(3).toString('hex')`,
 * not `Math.random` — collisions in the same millisecond are
 * vanishingly rare and the suffix carries no security claim.
 *
 * Backup-fail-fast: callers MUST NOT proceed with mutation if
 * `writeBackup` returns err. The caller maps a Result.err here to
 * exit code 2 with the failed backup path on stderr.
 *
 * @module
 */

import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { PathTraversalError, safePath, systemNowDate } from "@comis/core";
import { ok, err, tryCatch, type Result } from "@comis/shared";

/**
 * Discriminated error type for `writeBackup`.
 *
 * - `SOURCE_READ_FAILED` — the source `configPath` could not be read.
 *   The backup file was never created.
 * - `BACKUP_WRITE_FAILED` — the source was read but the backup write
 *   (or path resolution under `~/.comis/`) failed. The source file is
 *   unchanged; mutation must NOT proceed.
 */
export type BackupError =
  | { code: "SOURCE_READ_FAILED"; path: string; cause: string }
  | { code: "BACKUP_WRITE_FAILED"; path: string; cause: string };

/**
 * Allowed character set for the backup-filename `prefix` argument.
 *
 * Restricting `prefix` to `[a-z0-9-]+` accomplishes two things:
 *  - Prevents filesystem-unsafe characters (slash, colon, null byte,
 *    backslash, etc.) from being embedded into the backup filename
 *    (WR-02 — the cross-platform filename hazard).
 *  - Makes the prefix safe to interpolate into a RegExp literal in
 *    `pruneOldBackups` without escape — none of the allowed characters
 *    have regex semantics (WR-01 — the ReDoS / unintended-match hazard).
 *
 * Production callers pass the literals "sync-tooling" or "tooling-fill",
 * both of which satisfy this allowlist. The check is defensive: it
 * guards against a future caller threading an environment-derived
 * value through this API.
 */
const PREFIX_ALLOWLIST = /^[a-z0-9-]+$/;

function validatePrefix(prefix: string): void {
  if (!PREFIX_ALLOWLIST.test(prefix)) {
    throw new Error(
      `Invalid backup prefix ${JSON.stringify(prefix)}; must match /^[a-z0-9-]+$/`,
    );
  }
}

/**
 * Build a backup filename with a customizable command prefix.
 *
 * The optional parameters exist for testability — production callers
 * pass no args (sync-tooling) or only `prefix` (tooling-fill) and get
 * a fresh `Date` + `randomBytes` each call.
 *
 * `prefix` is validated against `/^[a-z0-9-]+$/`; non-conforming
 * prefixes throw synchronously.
 *
 * @param now - Override the timestamp (default: `systemNowDate()`).
 * @param rng - Override the 6-char hex suffix generator (default: `randomBytes(3).toString('hex')`).
 * @param prefix - Command prefix for the filename (default: `"sync-tooling"`).
 */
export function buildBackupFilename(
  now: Date = systemNowDate(),
  rng: () => string = () => randomBytes(3).toString("hex"),
  prefix: string = "sync-tooling",
): string {
  validatePrefix(prefix);
  // toISOString() → "2026-05-10T12:34:56.789Z"
  // Replace ':' → '-' (not filesystem-safe on all platforms) and drop trailing 'Z'.
  const iso = now.toISOString();
  const fsSafe = iso.replace(/:/g, "-").replace(/Z$/, "");
  const suffix = rng();
  return `config.pre-${prefix}-${fsSafe}-${suffix}.yaml`;
}

/**
 * Write a byte-equal backup of `configPath` under `${homeDir}/.comis/`.
 *
 * Returns the absolute backup path on success. The backup is written
 * with mode 0o600 — same restrictiveness as the source config.
 *
 * MUST be called BEFORE any mutation. If this returns err, the caller
 * MUST abort with exit code 2 and emit the failed backup path on
 * stderr (backup-fail-fast).
 *
 * @param configPath - Absolute path of the source config to back up.
 * @param homeDir - Operator's home directory; backup goes under `${homeDir}/.comis/`.
 * @param prefix - Command prefix for the backup filename (default: `"sync-tooling"`).
 */
export function writeBackup(
  configPath: string,
  homeDir: string,
  prefix: string = "sync-tooling",
): Result<{ backupPath: string }, BackupError> {
  // Step 1: read the source as raw bytes (Buffer, not utf-8 decoded).
  // We intentionally preserve byte-for-byte equality so tests can assert
  // Buffer.compare === 0.
  let content: Buffer;
  try {
    content = fs.readFileSync(configPath);
  } catch (e) {
    return err({
      code: "SOURCE_READ_FAILED",
      path: configPath,
      cause: String(e),
    });
  }

  // Step 2: resolve the backup path under ${homeDir}/.comis/<filename>.
  // safePath throws PathTraversalError on null bytes / traversal escapes;
  // we wrap with tryCatch and surface as BACKUP_WRITE_FAILED so the caller
  // sees a single failure mode for "could not produce a backup."
  const filename = buildBackupFilename(systemNowDate(), undefined, prefix);
  const safePathResult = tryCatch(() => safePath(homeDir, ".comis", filename));
  if (!safePathResult.ok) {
    const cause =
      safePathResult.error instanceof PathTraversalError
        ? safePathResult.error.message
        : String(safePathResult.error);
    return err({ code: "BACKUP_WRITE_FAILED", path: filename, cause });
  }
  const backupPath = safePathResult.value;

  // Step 3: write the backup with mode 0o600.
  try {
    fs.writeFileSync(backupPath, content, { mode: 0o600 });
  } catch (e) {
    return err({
      code: "BACKUP_WRITE_FAILED",
      path: backupPath,
      cause: String(e),
    });
  }

  return ok({ backupPath });
}

/**
 * Prune `config.pre-<prefix>-*.yaml` backups under `${homeDir}/.comis/`,
 * keeping the `keep` most recent. Default keep=5.
 *
 * Best-effort: any I/O error is swallowed (returns 0) — backup retention
 * is housekeeping, not a correctness requirement. Callers should invoke
 * after a successful mutation, not before — pruning a backup the operator
 * may need is far worse than retaining a few extra files.
 *
 * Returns the number of files actually deleted, for telemetry / summary
 * lines.
 *
 * @param homeDir - Operator's home directory; pruning scoped to `${homeDir}/.comis/`.
 * @param prefix - Backup filename prefix to match (e.g. "sync-tooling" or "tooling-fill").
 * @param keep - Most recent N to retain (default 5).
 */
export function pruneOldBackups(
  homeDir: string,
  prefix: string,
  keep: number = 5,
): { deleted: number } {
  // Validate prefix against the same allowlist used by buildBackupFilename.
  // pruneOldBackups is best-effort, so a malformed prefix returns
  // { deleted: 0 } rather than throwing — pruning a wider regex than
  // intended is far worse than skipping retention this call.
  if (!PREFIX_ALLOWLIST.test(prefix)) {
    return { deleted: 0 };
  }

  const dirPathRes = tryCatch(() => safePath(homeDir, ".comis"));
  if (!dirPathRes.ok) return { deleted: 0 };
  const dirPath = dirPathRes.value;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return { deleted: 0 };
  }

  // Match the backup pattern with a prefix-specific anchor. Anchor on the
  // literal prefix to avoid pruning sync-tooling backups when called for
  // tooling-fill (and vice versa). The prefix is guaranteed by
  // PREFIX_ALLOWLIST above to contain no regex metacharacters, so direct
  // interpolation is safe (no ReDoS / unintended-match surface).
  const re = new RegExp(`^config\\.pre-${prefix}-.+\\.yaml$`);
  const candidates = entries
    .filter((e) => e.isFile() && re.test(e.name))
    .map((e) => {
      const fullPathRes = tryCatch(() => safePath(homeDir, ".comis", e.name));
      if (!fullPathRes.ok) return null;
      try {
        return { path: fullPathRes.value, mtimeMs: fs.statSync(fullPathRes.value).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; mtimeMs: number } => x !== null);

  if (candidates.length <= keep) return { deleted: 0 };

  // Sort newest-first; drop the first `keep`; delete the rest.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toDelete = candidates.slice(keep);
  let deleted = 0;
  for (const { path } of toDelete) {
    try {
      fs.unlinkSync(path);
      deleted++;
    } catch {
      // best-effort
    }
  }
  return { deleted };
}
