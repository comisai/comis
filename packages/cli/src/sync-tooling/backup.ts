// SPDX-License-Identifier: Apache-2.0
/**
 * Pre-mutation backup helper for sync-tooling `--write` operations.
 *
 * Writes a byte-equal copy of the active config under `~/.comis/` with
 * a timestamped filename matching the D-10 pattern:
 *
 *   config.pre-<prefix>-<ISO-with-ms>-<6-hex>.yaml
 *   e.g. config.pre-sync-tooling-2026-05-10T12-34-56.789-a3f2c1.yaml
 *        config.pre-tooling-fill-2026-05-10T12-34-56.789-a3f2c1.yaml
 *
 * The `prefix` defaults to `"sync-tooling"` for back-compat with Phase 25
 * callers; Phase 26 (`comis config tooling-fill`) passes `"tooling-fill"`
 * to land its backups beside Phase 25's.
 *
 * The 6-char hex suffix is `crypto.randomBytes(3).toString('hex')`,
 * not `Math.random` — collisions in the same millisecond are
 * vanishingly rare and the suffix carries no security claim.
 *
 * Backup-fail-fast (D-12): callers MUST NOT proceed with mutation
 * if `writeBackup` returns err. The Wave 3 caller maps a Result.err
 * here to exit code 2 with the failed backup path on stderr.
 *
 * @module
 */

import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { safePath, PathTraversalError } from "@comis/core";
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
 * Build a backup filename per D-10 with a customizable command prefix.
 *
 * The optional parameters exist for testability — production callers
 * pass no args (Phase 25 sync-tooling) or only `prefix` (Phase 26
 * tooling-fill) and get a fresh `Date` + `randomBytes` each call.
 *
 * @param now - Override the timestamp (default: `new Date()`).
 * @param rng - Override the 6-char hex suffix generator (default: `randomBytes(3).toString('hex')`).
 * @param prefix - Command prefix for the filename (default: `"sync-tooling"` for back-compat).
 */
export function buildBackupFilename(
  now: Date = new Date(),
  rng: () => string = () => randomBytes(3).toString("hex"),
  prefix: string = "sync-tooling",
): string {
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
 * stderr (D-12 backup-fail-fast).
 *
 * @param configPath - Absolute path of the source config to back up.
 * @param homeDir - Operator's home directory; backup goes under `${homeDir}/.comis/`.
 * @param prefix - Command prefix for the backup filename (default: `"sync-tooling"` for back-compat).
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
  const filename = buildBackupFilename(new Date(), undefined, prefix);
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
