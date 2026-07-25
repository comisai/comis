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
import {
  AMBIGUOUS_SEND_OUTCOME_ERROR,
  ChannelEndpointSchema,
  ConversationRefSchema,
  systemNowMs,
} from "@comis/core";
import { createRowMapper } from "./row-mapper.js";
import {
  DeliveryQueueDbRowSchema,
} from "./row-schemas.js";

// ---------------------------------------------------------------------------
// Internal DB row type (SSOT: DeliveryQueueDbRowSchema in row-schemas.ts).
// ---------------------------------------------------------------------------

type DeliveryQueueDbRow = z.infer<typeof DeliveryQueueDbRowSchema>;

// Row mappers
const deliveryQueueMapper = createRowMapper(DeliveryQueueDbRowSchema);
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
    agentId: row.agent_id,
    conversationRef: ConversationRefSchema.parse(row.conversation_ref),
    destinationEndpoint: ChannelEndpointSchema.parse(JSON.parse(row.destination_endpoint)),
    optionsJson: row.options_json,
    origin: row.origin,
    status: row.status as DeliveryQueueEntry["status"],
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    scheduledAt: row.scheduled_at,
    expireAt: row.expire_at,
    lastAttemptAt: row.last_attempt_at,
    nextRetryAt: row.next_retry_at,
    lastError: row.last_error,
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
  eventBus: Pick<TypedEventBus, "emitSafely">,
): DeliveryQueuePort {
  // --- Prepared statements ---

  const insertStmt = db.prepare(`
    INSERT INTO delivery_queue (
      id, text, channel_type, channel_id, tenant_id, agent_id, conversation_ref,
      destination_endpoint, options_json, origin,
      status, attempt_count, max_attempts,
      created_at, scheduled_at, expire_at, last_attempt_at, next_retry_at,
      last_error, trace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, NULL, NULL, NULL, ?)
  `);

  const ackStmt = db.prepare(`
    UPDATE delivery_queue
    SET status = 'delivered'
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
    WHERE status = 'pending'
      AND scheduled_at <= ?
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY created_at ASC
  `);

  const claimStmt = db.prepare(`
    UPDATE delivery_queue
    SET status = 'in_flight', last_attempt_at = ?
    WHERE id = ?
      AND status = 'pending'
      AND scheduled_at <= ?
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
  `);

  // Every NOT-yet-delivered row (pending / in_flight / failed / expired),
  // regardless of scheduled_at. Inverse of pendingStmt's drainer scope; used by
  // the MCP resources/read CONFIRMED-only leak guard.
  const unconfirmedStmt = db.prepare(`
    SELECT * FROM delivery_queue
    WHERE status != 'delivered'
    ORDER BY created_at ASC
  `);

  const pruneStmt = db.prepare(`
    DELETE FROM delivery_queue
    WHERE expire_at < ? AND status NOT IN ('delivered')
  `);

  const insertInFlightStmt = db.prepare(`
    INSERT INTO delivery_queue (
      id, text, channel_type, channel_id, tenant_id, agent_id, conversation_ref,
      destination_endpoint, options_json, origin,
      status, attempt_count, max_attempts,
      created_at, scheduled_at, expire_at, last_attempt_at, next_retry_at,
      last_error, trace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_flight', 0, ?, ?, ?, ?, NULL, NULL, NULL, ?)
  `);

  const recoverInFlightStmt = db.prepare(`
    UPDATE delivery_queue
    SET status = 'failed', last_error = ?, next_retry_at = NULL
    WHERE status = 'in_flight'
  `);

  // Two distinct statements (no channelType filter vs. with filter) because
  // better-sqlite3 does not support SQLite's `?1` named-positional syntax
  // for repeated parameters in `.all(value)` calls — passing one value
  // raises "Too many parameter values were provided".
  const statusCountsAllStmt = db.prepare(`
    SELECT status, COUNT(*) as count FROM delivery_queue
    GROUP BY status
  `);
  const statusCountsByChannelStmt = db.prepare(`
    SELECT status, COUNT(*) as count FROM delivery_queue
    WHERE channel_type = ?
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
          entry.agentId,
          entry.conversationRef,
          JSON.stringify(entry.destinationEndpoint),
          entry.optionsJson,
          entry.origin,
          entry.maxAttempts,
          entry.createdAt,
          entry.scheduledAt,
          entry.expireAt,
          entry.traceId ?? null,
        );
        // Emit AFTER SQL success -- preserves invariant: one delivery:enqueued <=> one persisted row.
        eventBus.emitSafely("delivery:enqueued", {
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
          entry.agentId,
          entry.conversationRef,
          JSON.stringify(entry.destinationEndpoint),
          entry.optionsJson,
          entry.origin,
          entry.maxAttempts,
          entry.createdAt,
          entry.scheduledAt,
          entry.expireAt,
          entry.traceId ?? null,
        );
        // Same delivery:enqueued event as enqueue() -- universal observability.
        eventBus.emitSafely("delivery:enqueued", {
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

    claim(id: string): Promise<Result<boolean, Error>> {
      try {
        const now = systemNowMs();
        const result = claimStmt.run(now, id, now, now);
        return Promise.resolve(ok(result.changes === 1));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    ack(id: string, _messageId: string): Promise<Result<void, Error>> {
      try {
        ackStmt.run(id);
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
        const now = systemNowMs();
        const parsed = deliveryQueueMapper.parseRows(pendingStmt.all(now, now));
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

    unconfirmedEntries(): Promise<Result<DeliveryQueueEntry[], Error>> {
      try {
        const parsed = deliveryQueueMapper.parseRows(unconfirmedStmt.all());
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

    statusCounts(channelType?: string): Promise<Result<DeliveryQueueStatusCounts, Error>> {
      try {
        const rawRows = channelType === undefined
          ? statusCountsAllStmt.all()
          : statusCountsByChannelStmt.all(channelType);
        const parsed = statusCountMapper.parseRows(rawRows);
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
        const result = recoverInFlightStmt.run(AMBIGUOUS_SEND_OUTCOME_ERROR);
        return Promise.resolve(ok(result.changes));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },
  };

  return Object.freeze(queue);
}
