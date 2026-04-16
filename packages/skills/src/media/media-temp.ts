/**
 * Managed temp directory for media processing files with heartbeat cleanup.
 *
 * Provides safe, auto-cleaning scratch space for audio conversion and media
 * staging. All path construction within the managed directory uses safePath()
 * from @comis/core/security -- NEVER path.join().
 *
 * @module
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { safePath } from "@comis/core";

/** Configuration for the managed temp directory. */
export interface MediaTempConfig {
  /** Base directory for temp files (default: os.tmpdir()). */
  readonly baseDir?: string;
  /** Filename prefix for the managed subdirectory (default: "comis-media-"). */
  readonly prefix?: string;
  /** TTL in ms before a file is considered stale (default: 1,800,000 = 30 min). */
  readonly ttlMs?: number;
  /** Cleanup interval in ms (default: 300,000 = 5 min). */
  readonly cleanupIntervalMs?: number;
}

/** Logger interface for temp manager -- minimal surface. */
export interface MediaTempLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Managed temp directory for media processing scratch files. */
export interface MediaTempManager {
  /** Create the managed subdirectory via fs.mkdtemp(). */
  init(): Promise<Result<void, Error>>;
  /** Generate a unique file path within the managed directory. */
  createTempPath(suffix: string): string;
  /** Delete a specific temp file. */
  remove(filePath: string): Promise<Result<void, Error>>;
  /** Remove files older than TTL. Returns count of files removed. */
  cleanup(): Promise<Result<number, Error>>;
  /** Start periodic cleanup with setInterval. */
  startCleanupInterval(): void;
  /** Stop periodic cleanup. */
  stopCleanupInterval(): void;
  /** Get the managed directory path (for testing/logging). */
  getManagedDir(): string | undefined;
}

/**
 * Create a managed temp directory for media processing files.
 *
 * The managed directory is created under `baseDir` (default: os.tmpdir())
 * with a unique suffix appended by Node.js mkdtemp. Files are cleaned up
 * when older than `ttlMs` (default: 30 minutes). A heartbeat cleanup runs
 * every `cleanupIntervalMs` (default: 5 minutes) via setInterval with
 * .unref() so it does not prevent Node.js process exit.
 */
export function createMediaTempManager(
  config: MediaTempConfig,
  logger: MediaTempLogger,
): MediaTempManager {
  const baseDir = config.baseDir ?? os.tmpdir();
  const prefix = config.prefix ?? "comis-media-";
  const ttlMs = config.ttlMs ?? 1_800_000;
  const cleanupIntervalMs = config.cleanupIntervalMs ?? 300_000;

  let managedDir: string | undefined;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;

  const manager: MediaTempManager = {
    async init(): Promise<Result<void, Error>> {
      try {
        // mkdtemp expects a full path prefix -- it appends 6 random chars.
        // We concatenate with "/" directly because this is an OS temp dir
        // operation on a constant prefix (not user input), and the target
        // platform is Linux. safePath is not applicable here because mkdtemp
        // needs a prefix string, not a directory + filename.
        managedDir = await fs.mkdtemp(baseDir + "/" + prefix);
        return ok(undefined);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        return err(error);
      }
    },

    createTempPath(suffix: string): string {
      if (managedDir === undefined) {
        throw new Error("MediaTempManager not initialized -- call init() first");
      }
      return safePath(managedDir, crypto.randomUUID() + suffix);
    },

    async remove(filePath: string): Promise<Result<void, Error>> {
      try {
        await fs.unlink(filePath);
      } catch {
        // File may already be deleted -- best-effort removal
      }
      return ok(undefined);
    },

    async cleanup(): Promise<Result<number, Error>> {
      if (managedDir === undefined) {
        return ok(0);
      }

      try {
        let entries: string[];
        try {
          entries = await fs.readdir(managedDir);
        } catch (readErr: unknown) {
          // Directory doesn't exist yet -- nothing to clean
          if (readErr instanceof Error && "code" in readErr && readErr.code === "ENOENT") {
            return ok(0);
          }
          // Other readdir errors (permissions, ENOTDIR, etc.) propagate
          throw readErr;
        }

        const now = Date.now();
        let removed = 0;

        for (const entry of entries) {
          const filePath = safePath(managedDir, entry);
          try {
            const stat = await fs.stat(filePath);
            if (now - stat.mtimeMs > ttlMs) {
              try { await fs.unlink(filePath); } catch { /* best-effort cleanup */ }
              removed++;
            }
          } catch {
            // File disappeared between readdir and stat -- skip
          }
        }

        if (removed > 0) {
          logger.debug({ removed, managedDir }, "Media temp cleanup cycle");
        }

        return ok(removed);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger.error(
          {
            err: error,
            hint: "Media temp directory cleanup failed -- check filesystem permissions for the temp directory",
            errorKind: "resource" as const,
          },
          "Media temp cleanup failed",
        );
        return err(error);
      }
    },

    startCleanupInterval(): void {
      // setInterval is the chosen approach: "heartbeat cleanup runs every
      // 5 minutes" = periodic cleanup. Architecturally simpler than
      // subscribing to TypedEventBus heartbeat from @comis/scheduler
      // and functionally equivalent at the same 5-minute interval.
      cleanupTimer = setInterval(async () => {
        await manager.cleanup();
      }, cleanupIntervalMs);
      cleanupTimer.unref();
    },

    stopCleanupInterval(): void {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = undefined;
      }
    },

    getManagedDir(): string | undefined {
      return managedDir;
    },
  };

  return manager;
}
