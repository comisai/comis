// SPDX-License-Identifier: Apache-2.0
/**
 * FileStateTracker -- per-session file read state and guard logic.
 *
 * Tracks file read metadata (path, mtime, offset, limit) and provides
 * guard logic for dedup, staleness, read-before-write enforcement,
 * and device file blocking. Pure logic foundation for file tool safety
 * guards.
 *
 * Content hash fallback: stores SHA-256 hash of first 64KB
 * for full reads, enabling staleness checks to tolerate mtime changes
 * without content changes (common on Windows/macOS with cloud sync).
 *
 * @module
 */

import { createHash } from "node:crypto";

/** Blocked device file paths that agents must never read. */
export const BLOCKED_DEVICE_PATHS: ReadonlySet<string> = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/null",
  "/dev/tty",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
]);

/**
 * Check if a path is a blocked device file.
 *
 * Returns true for exact matches in BLOCKED_DEVICE_PATHS and any path
 * starting with `/dev/fd/`. Returns false for `/dev` itself (directory
 * listing is harmless) and paths containing "dev" in non-/dev contexts.
 */
export function isDeviceFile(path: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(path)) return true;
  if (path.startsWith("/dev/fd/")) return true;
  return false;
}

/** Recorded state for a single file read. */
export interface FileReadState {
  /** File modification time at read time (ms since epoch). */
  mtime: number;
  /** Timestamp when the read was recorded (ms since epoch). */
  readAt: number;
  /** Start offset of the read range, if provided. */
  offset?: number;
  /** Line/byte limit of the read range, if provided. */
  limit?: number;
  /** SHA-256 hash of file content at read time (first 64KB, full reads only). */
  contentHash?: string;
}

/** Staleness check result. */
export type StalenessResult =
  | { stale: false }
  | { stale: true; readMtime: number; currentMtime: number };

/** Per-session file read state tracker. */
export interface FileStateTracker {
  /**
   * Record a successful file read.
   * Updates the state map entry for the given path.
   * When contentSample is provided for full reads (no offset/limit),
   * stores a SHA-256 hash of the first 64KB for staleness fallback.
   */
  recordRead(path: string, mtime: number, offset?: number, limit?: number, contentSample?: Buffer): void;

  /**
   * Check whether a file read should return a compact stub instead of full content.
   *
   * Returns a stub string when: path exists in state map AND currentMtime matches
   * recorded mtime AND offset/limit match the recorded read. Returns false otherwise.
   *
   * @param path - Absolute file path
   * @param currentMtime - Current file mtime (ms since epoch)
   * @param currentSize - Current file size in bytes (used in stub message)
   * @param offset - Start offset of the requested read range
   * @param limit - Line/byte limit of the requested read range
   * @returns Stub message string or false
   */
  shouldReturnStub(
    path: string,
    currentMtime: number,
    currentSize: number,
    offset?: number,
    limit?: number,
  ): string | false;

  /** Returns true if the path has a recorded read. */
  hasBeenRead(path: string): boolean;

  /** Returns the FileReadState or undefined. */
  getReadState(path: string): FileReadState | undefined;

  /**
   * Compare recorded mtime with current mtime.
   * Returns stale:false if path has no recorded read.
   * When mtime differs and a contentHash was recorded, falls back to
   * hash comparison using currentContentSample.
   */
  checkStaleness(path: string, currentMtime: number, currentContentSample?: Buffer): StalenessResult;

  /**
   * Remove recorded read state for a path, forcing the next read to return
   * full content instead of a stub. Called when an edit fails with
   * text_not_found — the LLM's understanding of the file is wrong and it
   * needs a fresh look.
   */
  invalidateRead(path: string): void;

  /**
   * Create a shallow copy of the state map for session forking.
   * Forked session inherits parent's file state.
   */
  clone(): FileStateTracker;
}

/**
 * Format byte size as human-readable string.
 * Examples: "512B", "4.1KB", "1.3MB"
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB`;
}

/**
 * Creates a new FileStateTracker for a session.
 *
 * Instantiation contract:
 * - Top-level sessions: call createFileStateTracker() (fresh state)
 * - Forked sessions: call tracker.clone() (inherits parent's file state)
 * - Sub-agent sessions: call createFileStateTracker() (never clone -- sub-agents
 *   start clean per memory isolation model)
 */
export function createFileStateTracker(): FileStateTracker {
  const state = new Map<string, FileReadState>();

  function createFromState(existingState: Map<string, FileReadState>): FileStateTracker {
    const tracker: FileStateTracker = {
      recordRead(path: string, mtime: number, offset?: number, limit?: number, contentSample?: Buffer): void {
        const entry: FileReadState = {
          mtime,
          readAt: Date.now(),
        };
        if (offset !== undefined) entry.offset = offset;
        if (limit !== undefined) entry.limit = limit;
        // Hash first 64KB when caller provides content sample.
        // Caller is responsible for only passing contentSample on full reads.
        if (contentSample) {
          const sample = contentSample.subarray(0, 65_536);
          entry.contentHash = createHash("sha256").update(sample).digest("hex");
        }
        existingState.set(path, entry);
      },

      shouldReturnStub(
        path: string,
        currentMtime: number,
        currentSize: number,
        offset?: number,
        limit?: number,
      ): string | false {
        const recorded = existingState.get(path);
        if (!recorded) return false;
        if (recorded.mtime !== currentMtime) return false;
        if (recorded.offset !== offset) return false;
        if (recorded.limit !== limit) return false;

        const sizeHuman = formatSize(currentSize);
        const isoDate = new Date(currentMtime).toISOString().split("T")[0];
        return `File unchanged since last read (${sizeHuman}, mtime ${isoDate}). To re-read, use a different offset/limit range.`;
      },

      hasBeenRead(path: string): boolean {
        return existingState.has(path);
      },

      getReadState(path: string): FileReadState | undefined {
        return existingState.get(path);
      },

      checkStaleness(path: string, currentMtime: number, currentContentSample?: Buffer): StalenessResult {
        const recorded = existingState.get(path);
        if (!recorded) return { stale: false };
        if (recorded.mtime === currentMtime) return { stale: false };
        // Mtime changed -- fall back to content hash comparison
        if (recorded.contentHash && currentContentSample) {
          const sample = currentContentSample.subarray(0, 65_536);
          const currentHash = createHash("sha256").update(sample).digest("hex");
          if (recorded.contentHash === currentHash) {
            // Content unchanged despite mtime change -- update mtime to prevent repeated hashing
            recorded.mtime = currentMtime;
            return { stale: false };
          }
        }
        return { stale: true, readMtime: recorded.mtime, currentMtime };
      },

      invalidateRead(path: string): void {
        existingState.delete(path);
      },

      clone(): FileStateTracker {
        const clonedState = new Map<string, FileReadState>();
        for (const [key, value] of existingState) {
          clonedState.set(key, { ...value });
        }
        return createFromState(clonedState);
      },
    };

    return tracker;
  }

  return createFromState(state);
}
