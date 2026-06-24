// SPDX-License-Identifier: Apache-2.0
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
import type { TypedEventBus, OutwardSendLedgerPort } from "@comis/core";
import { systemNowMs } from "@comis/core";

/** Minimal pino-compatible logger for dead-letter queue diagnostics.
 *  Structurally identical to packages/daemon/src/sub-agent-runner.ts
 *  `SubAgentRunnerLogger`; inlined to avoid an orchestrator->daemon
 *  back-edge that a relative import would have introduced after the
 *  cross-session move. Daemon consumers continue to pass their
 *  `SubAgentRunnerLogger`-shaped loggers unchanged; the structural
 *  compatibility guarantees no call-site change. */
export interface AnnouncementLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Canonical 9-channel set covering production platform adapters. Used as the
 * closed-union discriminator for sendToChannel(type, ...) instead of an open
 * `string`. Local definition (no @comis/core export currently aggregates the
 * platform-adapter channel types — the rest of the codebase carries this
 * set implicitly as adapter-specific channelType strings). "echo" is
 * included for development/testing parity with channels/echo-adapter.
 */
export type ChannelType =
  | "discord"
  | "telegram"
  | "slack"
  | "whatsapp"
  | "imessage"
  | "signal"
  | "irc"
  | "line"
  | "email"
  | "echo";

/** A single dead-letter queue entry representing a failed announcement. */
export interface DeadLetterEntry {
  id: string;
  announcementText: string;
  channelType: ChannelType;
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
  /** Idempotency key `${callerSessionKey}::${runId}` (DELIVERY-01). Optional/forward-additive — pre-existing JSONL rows have it undefined (no migration; parseEntries tolerates the missing field). */
  idempotencyKey?: string;
  /**
   * HIGH-2 (ONCE-03/04) — the announce origin's `rootRunId`, half of the durable
   * `(rootRunId, stepIndex)` ONCE-ledger idempotency key. Optional/forward-additive
   * (like {@link DeadLetterEntry.idempotencyKey}): pre-ledgering JSONL rows have it
   * undefined and `parseEntries` tolerates that — no migration. When present
   * alongside {@link DeadLetterEntry.stepIndex}, `drain` consults the ledger and
   * skips a committed announcement (no restart double-notify).
   */
  rootRunId?: string;
  /**
   * HIGH-2 (ONCE-03/04) — the stable per-announce `stepIndex` allocated ONCE at
   * first announce (`allocateOutwardStep`), the other half of the idempotency key.
   * Persisted so a retry after a restart re-uses the SAME key. Optional/forward-
   * additive (no migration).
   */
  stepIndex?: number;
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
   *
   * WR-01: `onDelivered` (optional) is invoked with the entry's
   * `idempotencyKey` after a SUCCESSFUL re-delivery, so the caller can record
   * the recovered key in the shared deliveredKeys set (deliveryDedup.mark /
   * batcher.markDelivered). Without it, a DLQ-recovered announcement is never
   * marked delivered and a later sweep double-notifies the same run. Only fired
   * for keyed entries on success; never on failure (the key must stay open).
   */
  drain(
    sendToChannel: (type: ChannelType, id: string, text: string, options?: { threadId?: string }) => Promise<boolean>,
    onDelivered?: (idempotencyKey: string) => void,
  ): Promise<void>;
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
  logger?: AnnouncementLogger;
  /**
   * HIGH-2 (ONCE-03/04) — the three-state outward-send ledger. When present,
   * `drain` consults it BEFORE re-delivering an entry that carries a persisted
   * `(rootRunId, stepIndex)`: a committed row → SKIP the send (the announcement
   * already landed; the in-memory deliveredKeys set could not know this across a
   * restart, the durable ledger does). `undefined` ⇒ the legacy at-least-once
   * behavior (unchanged). Wired by Plan 12 (the sole daemon.ts editor).
   */
  outwardLedger?: OutwardSendLedgerPort;
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
    // @allow-throw: boundary adapter wrapping node:fs/promises (writeFile + rename); callers wrap via try/catch (see drain() catch at line 325). Renaming would not change behavior.
    throw err;
  }
}

/**
 * Parse JSONL content into DeadLetterEntry array.
 * Skips empty lines and corrupt entries (logs warning for corrupt lines).
 */
function parseEntries(content: string, logger?: AnnouncementLogger): DeadLetterEntry[] {
  const result: DeadLetterEntry[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      result.push(JSON.parse(trimmed) as DeadLetterEntry);
    } catch {
      logger?.warn(
        { errorKind: "internal" as const, hint: "Corrupt DLQ entry skipped" },
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
  const { filePath, eventBus, logger, outwardLedger } = opts;

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
        { err, errorKind: "internal" as const, hint: "DLQ file read failed; starting with empty queue" },
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
          lastAttemptAt: systemNowMs(),
        };

        // Enforce capacity cap
        if (entries.length >= maxEntries) {
          const dropped = entries.shift();
          logger?.error(
            {
              errorKind: "resource" as const,
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
          timestamp: systemNowMs(),
        });

        // Fire-and-forget file append
        appendFile(filePath, JSON.stringify(fullEntry) + "\n", "utf-8").catch(
          (err) =>
            logger?.warn(
              { err, errorKind: "internal" as const, hint: "DLQ append failed; entry exists in memory only" },
              "Dead-letter file append failed",
            ),
        );
      } catch (err) {
        // enqueue must NEVER throw
        logger?.warn(
          { err, errorKind: "internal" as const, hint: "DLQ enqueue failed entirely" },
          "Dead-letter enqueue failed",
        );
      }
    },

    async drain(
      sendToChannel: (type: ChannelType, id: string, text: string, options?: { threadId?: string }) => Promise<boolean>,
      onDelivered?: (idempotencyKey: string) => void,
    ): Promise<void> {
      // Concurrent drain protection
      if (draining) return;
      draining = true;
      try {
        // Lazy load on first drain
        await loadFromDisk();

        if (entries.length === 0) return;

        const now = systemNowMs();

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

          // HIGH-2 (ONCE-03/04): before re-delivering, consult the durable ONCE
          // ledger for an entry that carries its (rootRunId, stepIndex). A
          // committed row means the announcement ALREADY landed — the in-memory
          // deliveredKeys set rebuilds empty on restart and cannot know this, so
          // without this check a restart would re-deliver a sent announcement (a
          // double-notify). Skip the send, treat the entry as delivered. An
          // old-format entry (no rootRunId/stepIndex) has no key to look up and
          // falls through to the legacy at-least-once path.
          if (outwardLedger && entry.rootRunId !== undefined && entry.stepIndex !== undefined) {
            const row = await outwardLedger.lookup(entry.rootRunId, entry.stepIndex);
            if (row.ok && row.value?.state === "committed") {
              delivered.add(entry.id);
              if (entry.idempotencyKey) onDelivered?.(entry.idempotencyKey);
              eventBus.emit("announcement:dead_letter_delivered", {
                runId: entry.runId,
                channelType: entry.channelType,
                attemptCount: entry.attemptCount,
                timestamp: systemNowMs(),
              });
              logger?.debug(
                { runId: entry.runId, rootRunId: entry.rootRunId, stepIndex: entry.stepIndex, step: "dlq-ledger-committed-skip" },
                "Dead-letter entry skipped: announcement already committed in the ONCE ledger (no double-notify)",
              );
              continue;
            }
          }

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
              // WR-01: record the recovered key as delivered so a later sweep
              // (deliverFailureNotification) does not double-notify the same
              // run. Fired ONLY on success and ONLY for keyed entries.
              if (entry.idempotencyKey) onDelivered?.(entry.idempotencyKey);
              eventBus.emit("announcement:dead_letter_delivered", {
                runId: entry.runId,
                channelType: entry.channelType,
                attemptCount: entry.attemptCount + 1,
                timestamp: systemNowMs(),
              });
              logger?.debug(
                { runId: entry.runId, attemptCount: entry.attemptCount + 1 },
                "Dead-letter entry delivered successfully",
              );
            } else {
              entry.attemptCount++;
              entry.lastAttemptAt = systemNowMs();
              entry.lastError = "sendToChannel returned false";
            }
          } catch (err: unknown) {
            entry.attemptCount++;
            entry.lastAttemptAt = systemNowMs();
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
                // @allow-throw: re-raise non-ENOENT unlink failure to the outer drain() catch (line 325) which logs + degrades; boundary adapter pattern.
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
            { err, errorKind: "internal" as const, hint: "DLQ atomic write failed; in-memory state may diverge from disk" },
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
