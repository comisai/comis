/**
 * Config backup module: timestamped backup creation with rotation pruning.
 *
 * Creates a copy of the config file before writes, enabling rollback to
 * any previous state. Old backups are automatically pruned beyond a
 * configurable limit (default 10).
 *
 * Uses injectable filesystem operations (BackupDeps) for testability.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import type { ConfigError } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injectable filesystem operations for backup creation and rotation.
 *
 * Allows deterministic testing without real filesystem access.
 */
export interface BackupDeps {
  copyFile: (src: string, dest: string) => Result<void, ConfigError>;
  listDir: (dirPath: string) => Result<string[], ConfigError>;
  removeFile: (filePath: string) => Result<void, ConfigError>;
  fileExists: (filePath: string) => boolean;
  /** Injectable clock for deterministic tests */
  now?: () => Date;
}

/**
 * Options for backup creation.
 */
export interface BackupOptions {
  /** Maximum number of backup files to retain (default 10) */
  maxBackups?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BACKUPS = 10;

/**
 * Format a Date as a compact, filesystem-safe ISO timestamp.
 *
 * Output: YYYYMMDDTHHMMSSZ (no colons, no dashes in time)
 *
 * @example formatTimestamp(new Date("2026-02-12T14:30:00Z")) // "20260212T143000Z"
 */
function formatTimestamp(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${d}T${h}${min}${s}Z`;
}

/**
 * Extract the directory portion of a file path.
 *
 * Uses simple string manipulation to avoid path.join() per security rules.
 */
function dirname(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash === -1) return ".";
  if (lastSlash === 0) return "/";
  return filePath.slice(0, lastSlash);
}

/**
 * Extract the filename portion of a file path.
 */
function basename(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a timestamped backup of a config file with automatic rotation.
 *
 * Copies the source file to `{path}.backup.{YYYYMMDDTHHMMSSZ}` and prunes
 * old backups beyond the configured limit.
 *
 * @param configPath - Absolute path to the config file to back up
 * @param deps - Injectable filesystem operations
 * @param options - Optional backup configuration
 * @returns Result with the backup file path on success, or ConfigError on failure
 *
 * @example
 * const result = createTimestampedBackup("/etc/comis/config.yaml", fsDeps);
 * if (result.ok) {
 *   console.log(`Backup created: ${result.value}`);
 * }
 */
export function createTimestampedBackup(
  configPath: string,
  deps: BackupDeps,
  options?: BackupOptions,
): Result<string, ConfigError> {
  // Verify source exists
  if (!deps.fileExists(configPath)) {
    return err({
      code: "BACKUP_ERROR",
      message: `Source file does not exist: ${configPath}`,
      path: configPath,
    });
  }

  // Generate backup path
  const timestamp = formatTimestamp(deps.now?.() ?? new Date());
  const backupPath = `${configPath}.backup.${timestamp}`;

  // Copy file
  const copyResult = deps.copyFile(configPath, backupPath);
  if (!copyResult.ok) {
    return err(copyResult.error);
  }

  // Rotation: list directory and prune old backups
  const dir = dirname(configPath);
  const base = basename(configPath);
  const backupPrefix = `${base}.backup.`;
  const maxBackups = options?.maxBackups ?? DEFAULT_MAX_BACKUPS;

  const listResult = deps.listDir(dir);
  if (!listResult.ok) {
    // Backup was created successfully, but rotation failed — still return success
    // The backup file exists, rotation is best-effort
    return ok(backupPath);
  }

  // Filter to only backup files matching our naming pattern
  const backupFiles = listResult.value
    .filter((name) => name.startsWith(backupPrefix))
    .sort(); // ISO timestamps sort lexicographically

  // Prune oldest if over limit
  if (backupFiles.length > maxBackups) {
    const toDelete = backupFiles.slice(0, backupFiles.length - maxBackups);
    for (const fileName of toDelete) {
      const filePath = dir === "/" ? `/${fileName}` : `${dir}/${fileName}`;
      deps.removeFile(filePath);
      // Ignore remove errors — pruning is best-effort
    }
  }

  return ok(backupPath);
}
