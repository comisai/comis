// SPDX-License-Identifier: Apache-2.0
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
import { z } from "zod";
import type { DeliveryQueuePort, DeliveryQueueEntry, DeliveryQueueEnqueueInput, DeliveryQueueStatusCounts, TypedEventBus } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { systemNowMs } from "@comis/core";
import { createRowMapper } from "./row-mapper.js";
import {
  DeliveryQueueDbRowSchema,
  CountProjectionRowSchema,
} from "./row-schemas.js";

// ---------------------------------------------------------------------------
// Internal DB row type (SSOT: DeliveryQueueDbRowSchema in row-schemas.ts).
// ---------------------------------------------------------------------------

type DeliveryQueueDbRow = z.infer<typeof DeliveryQueueDbRowSchema>;

// Row mappers (Phase 41 TS-HYG-03)
const deliveryQueueMapper = createRowMapper(DeliveryQueueDbRowSchema);
const countProjectionMapper = createRowMapper(CountProjectionRowSchema);
const statusCountMapper = createRowMapper(
  z.strictObject({ status: z.string(), count: z.number() }),
);

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
export function createSqliteDeliveryQueue(
  db: Database.Database,
  eventBus: Pick<TypedEventBus, "emit">,
): DeliveryQueuePort {
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

  const insertInFlightStmt = db.prepare(`
    INSERT INTO delivery_queue (
      id, text, channel_type, channel_id, tenant_id, options_json, origin,
      format_applied, chunking_applied, status, attempt_count, max_attempts,
      created_at, scheduled_at, expire_at, last_attempt_at, next_retry_at,
      last_error, markdown_fallback_applied, delivered_message_id, trace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_flight', 0, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?)
  `);

  const recoverInFlightStmt = db.prepare(`
    UPDATE delivery_queue
    SET status = 'pending', last_error = NULL
    WHERE status = 'in_flight'
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
        // Emit AFTER SQL success -- preserves invariant: one delivery:enqueued <=> one persisted row.
        eventBus.emit("delivery:enqueued", {
          entryId: id,
          channelId: entry.channelId,
          channelType: entry.channelType,
          origin: entry.origin,
          timestamp: systemNowMs(),
        });
        return Promise.resolve(ok(id));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    enqueueInFlight(entry: DeliveryQueueEnqueueInput): Promise<Result<string, Error>> {
      try {
        const id = randomUUID();
        insertInFlightStmt.run(
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
        // Same delivery:enqueued event as enqueue() -- universal observability (SPEC-R5).
        eventBus.emit("delivery:enqueued", {
          entryId: id,
          channelId: entry.channelId,
          channelType: entry.channelType,
          origin: entry.origin,
          timestamp: systemNowMs(),
        });
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
        nackStmt.run(systemNowMs(), nextRetryAt, error, id);
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
        const parsed = deliveryQueueMapper.parseRows(pendingStmt.all(systemNowMs()));
        if (!parsed.ok) {
          return Promise.resolve(
            err(new Error(`Row validation failed: ${parsed.error.message}`)),
          );
        }
        return Promise.resolve(ok(parsed.value.map(rowToEntry)));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    pruneExpired(): Promise<Result<number, Error>> {
      try {
        const result = pruneStmt.run(systemNowMs());
        return Promise.resolve(ok(result.changes));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    depth(): Promise<Result<number, Error>> {
      try {
        const parsed = countProjectionMapper.parseOptionalRow(depthStmt.get());
        if (!parsed.ok) {
          return Promise.resolve(
            err(new Error(`Row validation failed: ${parsed.error.message}`)),
          );
        }
        return Promise.resolve(ok(parsed.value?.count ?? 0));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    statusCounts(channelType?: string): Promise<Result<DeliveryQueueStatusCounts, Error>> {
      try {
        const parsed = statusCountMapper.parseRows(
          statusCountsStmt.all(channelType ?? null),
        );
        if (!parsed.ok) {
          return Promise.resolve(
            err(new Error(`Row validation failed: ${parsed.error.message}`)),
          );
        }
        const counts: DeliveryQueueStatusCounts = { pending: 0, inFlight: 0, failed: 0, delivered: 0, expired: 0 };
        for (const row of parsed.value) {
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

    recoverInFlight(): Promise<Result<number, Error>> {
      try {
        const result = recoverInFlightStmt.run();
        return Promise.resolve(ok(result.changes));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },
  };

  return Object.freeze(queue);
}
