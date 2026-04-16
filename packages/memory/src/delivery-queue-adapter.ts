/**
 * SqliteDeliveryQueueAdapter -- SQLite persistence for the crash-safe delivery queue.
 *
 * Factory function pattern: prepares fixed SQL statements once in closure,
 * returns a frozen DeliveryQueuePort implementation. Maps between camelCase
 * domain fields and snake_case database columns.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { DeliveryQueuePort, DeliveryQueueEntry, DeliveryQueueEnqueueInput, DeliveryQueueStatusCounts } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

// ---------------------------------------------------------------------------
// Internal DB row type (snake_case -- what SQLite returns)
// ---------------------------------------------------------------------------

interface DeliveryQueueDbRow {
  id: string;
  text: string;
  channel_type: string;
  channel_id: string;
  tenant_id: string;
  options_json: string;
  origin: string;
  format_applied: number;
  chunking_applied: number;
  status: string;
  attempt_count: number;
  max_attempts: number;
  created_at: number;
  scheduled_at: number;
  expire_at: number;
  last_attempt_at: number | null;
  next_retry_at: number | null;
  last_error: string | null;
  markdown_fallback_applied: number;
  delivered_message_id: string | null;
  trace_id: string | null;
}

// ---------------------------------------------------------------------------
// Row mapper (snake_case -> camelCase with boolean casts)
// ---------------------------------------------------------------------------

function rowToEntry(row: DeliveryQueueDbRow): DeliveryQueueEntry {
  return {
    id: row.id,
    text: row.text,
    channelType: row.channel_type,
    channelId: row.channel_id,
    tenantId: row.tenant_id,
    optionsJson: row.options_json,
    origin: row.origin,
    formatApplied: row.format_applied !== 0,
    chunkingApplied: row.chunking_applied !== 0,
    status: row.status as DeliveryQueueEntry["status"],
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    scheduledAt: row.scheduled_at,
    expireAt: row.expire_at,
    lastAttemptAt: row.last_attempt_at,
    nextRetryAt: row.next_retry_at,
    lastError: row.last_error,
    markdownFallbackApplied: row.markdown_fallback_applied !== 0,
    deliveredMessageId: row.delivered_message_id,
    traceId: row.trace_id,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SQLite-backed DeliveryQueuePort.
 *
 * Assumes `initSchema()` has already been called (delivery_queue table exists).
 * Prepares fixed SQL statements once for performance.
 *
 * @param db - An open better-sqlite3 Database instance
 * @returns DeliveryQueuePort implementation (frozen)
 */
export function createSqliteDeliveryQueue(db: Database.Database): DeliveryQueuePort {
  // --- Prepared statements ---

  const insertStmt = db.prepare(`
    INSERT INTO delivery_queue (
      id, text, channel_type, channel_id, tenant_id, options_json, origin,
      format_applied, chunking_applied, status, attempt_count, max_attempts,
      created_at, scheduled_at, expire_at, last_attempt_at, next_retry_at,
      last_error, markdown_fallback_applied, delivered_message_id, trace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?)
  `);

  const ackStmt = db.prepare(`
    UPDATE delivery_queue
    SET status = 'delivered', delivered_message_id = ?
    WHERE id = ?
  `);

  const nackStmt = db.prepare(`
    UPDATE delivery_queue
    SET attempt_count = attempt_count + 1,
        last_attempt_at = ?,
        next_retry_at = ?,
        last_error = ?,
        status = 'pending'
    WHERE id = ?
  `);

  const failStmt = db.prepare(`
    UPDATE delivery_queue
    SET status = 'failed', last_error = ?
    WHERE id = ?
  `);

  const pendingStmt = db.prepare(`
    SELECT * FROM delivery_queue
    WHERE status = 'pending' AND scheduled_at <= ?
    ORDER BY created_at ASC
  `);

  const pruneStmt = db.prepare(`
    DELETE FROM delivery_queue
    WHERE expire_at < ? AND status NOT IN ('delivered')
  `);

  const depthStmt = db.prepare(`
    SELECT COUNT(*) as count FROM delivery_queue
    WHERE status IN ('pending', 'in_flight')
  `);

  const statusCountsStmt = db.prepare(`
    SELECT status, COUNT(*) as count FROM delivery_queue
    WHERE (?1 IS NULL OR channel_type = ?1)
    GROUP BY status
  `);

  // --- Port implementation ---

  const queue: DeliveryQueuePort = {
    enqueue(entry: DeliveryQueueEnqueueInput): Promise<Result<string, Error>> {
      try {
        const id = randomUUID();
        insertStmt.run(
          id,
          entry.text,
          entry.channelType,
          entry.channelId,
          entry.tenantId,
          entry.optionsJson,
          entry.origin,
          entry.formatApplied ? 1 : 0,
          entry.chunkingApplied ? 1 : 0,
          entry.maxAttempts,
          entry.createdAt,
          entry.scheduledAt,
          entry.expireAt,
          entry.traceId ?? null,
        );
        return Promise.resolve(ok(id));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    ack(id: string, messageId: string): Promise<Result<void, Error>> {
      try {
        ackStmt.run(messageId, id);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    nack(id: string, error: string, nextRetryAt: number): Promise<Result<void, Error>> {
      try {
        nackStmt.run(Date.now(), nextRetryAt, error, id);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    fail(id: string, error: string): Promise<Result<void, Error>> {
      try {
        failStmt.run(error, id);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    pendingEntries(): Promise<Result<DeliveryQueueEntry[], Error>> {
      try {
        const rows = pendingStmt.all(Date.now()) as DeliveryQueueDbRow[];
        return Promise.resolve(ok(rows.map(rowToEntry)));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    pruneExpired(): Promise<Result<number, Error>> {
      try {
        const result = pruneStmt.run(Date.now());
        return Promise.resolve(ok(result.changes));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    depth(): Promise<Result<number, Error>> {
      try {
        const row = depthStmt.get() as { count: number };
        return Promise.resolve(ok(row.count));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    statusCounts(channelType?: string): Promise<Result<DeliveryQueueStatusCounts, Error>> {
      try {
        const rows = statusCountsStmt.all(channelType ?? null) as Array<{ status: string; count: number }>;
        const counts: DeliveryQueueStatusCounts = { pending: 0, inFlight: 0, failed: 0, delivered: 0, expired: 0 };
        for (const row of rows) {
          switch (row.status) {
            case "pending": (counts as { pending: number }).pending = row.count; break;
            case "in_flight": (counts as { inFlight: number }).inFlight = row.count; break;
            case "failed": (counts as { failed: number }).failed = row.count; break;
            case "delivered": (counts as { delivered: number }).delivered = row.count; break;
            case "expired": (counts as { expired: number }).expired = row.count; break;
          }
        }
        return Promise.resolve(ok(counts));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },
  };

  return Object.freeze(queue);
}
