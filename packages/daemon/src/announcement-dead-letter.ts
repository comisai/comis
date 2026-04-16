/**
 * Announcement Dead-Letter Queue: JSONL-backed persistence and retry mechanism
 * for failed sub-agent announcements.
 * When a sub-agent announcement fails to deliver (provider outage, channel
 * error), the entry is persisted to a JSONL file for later retry. The drain()
 * method retries delivery sequentially, respects retry intervals, drops expired
 * entries, and uses atomic file writes for crash safety.
 * Dead-Letter Queue
 * @module
 */

import { appendFile, writeFile, rename, readFile, unlink } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import type { TypedEventBus } from "@comis/core";
import type { SubAgentRunnerLogger } from "./sub-agent-runner.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single dead-letter queue entry representing a failed announcement. */
export interface DeadLetterEntry {
  id: string;
  announcementText: string;
  channelType: string;
  channelId: string;
  runId: string;
  /** Timestamp when the original delivery failed. */
  failedAt: number;
  /** Number of retry attempts (starts at 0, incremented on each retry). */
  attemptCount: number;
  /** Timestamp of the most recent retry attempt. */
  lastAttemptAt: number;
  /** Last error message for diagnostics. */
  lastError?: string;
  /** Thread ID for threaded delivery Persisted so retried deliveries land in the correct thread. */
  threadId?: string;
}

/** Dead-letter queue interface for announcement retry management. */
export interface AnnouncementDeadLetterQueue {
  /**
   * Persist a failed announcement to the dead-letter queue.
   * Synchronous return, fire-and-forget file write. Never throws.
   */
  enqueue(entry: Omit<DeadLetterEntry, "id" | "lastAttemptAt">): void;
  /**
   * Retry delivery of queued entries via the provided sendToChannel callback.
   * Processes entries sequentially, drops expired entries, uses atomic write.
   */
  drain(sendToChannel: (type: string, id: string, text: string, options?: { threadId?: string }) => Promise<boolean>): Promise<void>;
  /** Return the current number of entries in the queue. */
  size(): number;
}

/** Configuration options for the dead-letter queue factory. */
interface AnnouncementDeadLetterQueueOptions {
  /** JSONL file path (already safePath'd by caller). */
  filePath: string;
  /** Maximum retry attempts before dropping an entry (default: 5). */
  maxRetries?: number;
  /** Minimum interval between retry attempts in ms (default: 60_000). */
  retryIntervalMs?: number;
  /** Maximum age of an entry in ms before it is dropped (default: 3_600_000). */
  maxAgeMs?: number;
  /** Maximum number of entries in the queue (default: 100). */
  maxEntries?: number;
  /** Event bus for emitting dead-letter events. */
  eventBus: TypedEventBus;
  /** Optional logger for diagnostics. */
  logger?: SubAgentRunnerLogger;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Atomic write: write to temp file, then rename to target.
 * Cleans up temp file on failure.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + `.tmp.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup of temp file
    try {
      await unlink(tmpPath);
    } catch {
      // Ignore cleanup failure
    }
    throw err;
  }
}

/**
 * Parse JSONL content into DeadLetterEntry array.
 * Skips empty lines and corrupt entries (logs warning for corrupt lines).
 */
function parseEntries(content: string, logger?: SubAgentRunnerLogger): DeadLetterEntry[] {
  const result: DeadLetterEntry[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      result.push(JSON.parse(trimmed) as DeadLetterEntry);
    } catch {
      logger?.warn(
        { errorKind: "data", hint: "Corrupt DLQ entry skipped" },
        "Corrupt dead-letter entry skipped",
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an announcement dead-letter queue backed by a JSONL file.
 * Uses closure over mutable state (no classes) following the factory pattern
 * from provider-health-monitor.ts.
 */
export function createAnnouncementDeadLetterQueue(
  opts: AnnouncementDeadLetterQueueOptions,
): AnnouncementDeadLetterQueue {
  const maxRetries = opts.maxRetries ?? 5;
  const retryIntervalMs = opts.retryIntervalMs ?? 60_000;
  const maxAgeMs = opts.maxAgeMs ?? 3_600_000;
  const maxEntries = opts.maxEntries ?? 100;
  const { filePath, eventBus, logger } = opts;

  // Closure state
  let entries: DeadLetterEntry[] = [];
  let draining = false;
  let loaded = false;

  /** Lazy-load entries from disk on first drain. */
  async function loadFromDisk(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const content = await readFile(filePath, "utf-8");
      entries = parseEntries(content, logger);
      logger?.debug(
        { entryCount: entries.length },
        "Loaded dead-letter entries from disk",
      );
    } catch (err: unknown) {
      // ENOENT is expected (no file yet)
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      logger?.warn(
        { err, errorKind: "io", hint: "DLQ file read failed; starting with empty queue" },
        "Failed to read dead-letter file",
      );
    }
  }

  return {
    enqueue(entry: Omit<DeadLetterEntry, "id" | "lastAttemptAt">): void {
      try {
        const fullEntry: DeadLetterEntry = {
          ...entry,
          id: randomUUID(),
          lastAttemptAt: Date.now(),
        };

        // Enforce capacity cap
        if (entries.length >= maxEntries) {
          const dropped = entries.shift();
          logger?.error(
            {
              errorKind: "resource",
              hint: "Dead-letter queue at capacity; oldest entry dropped",
              droppedRunId: dropped?.runId,
            },
            "Dead-letter queue at capacity",
          );
        }

        entries.push(fullEntry);

        // Emit dead-lettered event
        eventBus.emit("announcement:dead_lettered", {
          runId: fullEntry.runId,
          channelType: fullEntry.channelType,
          reason: fullEntry.lastError ?? "delivery_failed",
          timestamp: Date.now(),
        });

        // Fire-and-forget file append
        appendFile(filePath, JSON.stringify(fullEntry) + "\n", "utf-8").catch(
          (err) =>
            logger?.warn(
              { err, errorKind: "io", hint: "DLQ append failed; entry exists in memory only" },
              "Dead-letter file append failed",
            ),
        );
      } catch (err) {
        // enqueue must NEVER throw
        logger?.warn(
          { err, errorKind: "io", hint: "DLQ enqueue failed entirely" },
          "Dead-letter enqueue failed",
        );
      }
    },

    async drain(
      sendToChannel: (type: string, id: string, text: string, options?: { threadId?: string }) => Promise<boolean>,
    ): Promise<void> {
      // Concurrent drain protection
      if (draining) return;
      draining = true;
      try {
        // Lazy load on first drain
        await loadFromDisk();

        if (entries.length === 0) return;

        const now = Date.now();

        // Filter out expired entries
        entries = entries.filter((entry) => {
          if (entry.attemptCount >= maxRetries) {
            logger?.debug(
              { runId: entry.runId, attemptCount: entry.attemptCount },
              "Dead-letter entry dropped: max retries exceeded",
            );
            return false;
          }
          if (now - entry.failedAt >= maxAgeMs) {
            logger?.debug(
              { runId: entry.runId, ageMs: now - entry.failedAt },
              "Dead-letter entry dropped: max age exceeded",
            );
            return false;
          }
          return true;
        });

        // Process remaining entries sequentially (no retry storm)
        const delivered: Set<string> = new Set();
        for (const entry of entries) {
          // Skip if not yet eligible for retry
          if (now - entry.lastAttemptAt < retryIntervalMs) continue;

          try {
            // Pass persisted threadId so retried deliveries land in the correct thread
            const success = await sendToChannel(
              entry.channelType,
              entry.channelId,
              entry.announcementText,
              entry.threadId ? { threadId: entry.threadId } : undefined,
            );
            if (success) {
              delivered.add(entry.id);
              eventBus.emit("announcement:dead_letter_delivered", {
                runId: entry.runId,
                channelType: entry.channelType,
                attemptCount: entry.attemptCount + 1,
                timestamp: Date.now(),
              });
              logger?.debug(
                { runId: entry.runId, attemptCount: entry.attemptCount + 1 },
                "Dead-letter entry delivered successfully",
              );
            } else {
              entry.attemptCount++;
              entry.lastAttemptAt = Date.now();
              entry.lastError = "sendToChannel returned false";
            }
          } catch (err: unknown) {
            entry.attemptCount++;
            entry.lastAttemptAt = Date.now();
            entry.lastError =
              err instanceof Error ? err.message : String(err);
          }
        }

        // Remove delivered entries
        entries = entries.filter((e) => !delivered.has(e.id));

        // Persist remaining entries atomically
        try {
          if (entries.length === 0) {
            // Clean up empty file
            try {
              await unlink(filePath);
            } catch (err: unknown) {
              // ENOENT is fine (file already gone)
              if (
                !(err instanceof Error && "code" in err &&
                  (err as NodeJS.ErrnoException).code === "ENOENT")
              ) {
                throw err;
              }
            }
          } else {
            const content =
              entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
            await atomicWrite(filePath, content);
          }
        } catch (err) {
          logger?.warn(
            { err, errorKind: "io", hint: "DLQ atomic write failed; in-memory state may diverge from disk" },
            "Dead-letter file write failed after drain",
          );
        }
      } finally {
        draining = false;
      }
    },

    size(): number {
      return entries.length;
    },
  };
}
