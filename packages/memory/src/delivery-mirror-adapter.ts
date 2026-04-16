/**
 * SqliteDeliveryMirrorAdapter -- SQLite persistence for session mirroring.
 *
 * Factory function pattern: prepares fixed SQL statements once in closure,
 * returns a frozen DeliveryMirrorPort implementation. Maps between camelCase
 * domain fields and snake_case database columns.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { DeliveryMirrorPort, DeliveryMirrorEntry, DeliveryMirrorRecordInput } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

// ---------------------------------------------------------------------------
// Internal DB row type (snake_case -- what SQLite returns)
// ---------------------------------------------------------------------------

interface DeliveryMirrorDbRow {
  id: string;
  session_key: string;
  text: string;
  media_urls: string;
  channel_type: string;
  channel_id: string;
  origin: string;
  idempotency_key: string;
  status: string;
  created_at: number;
  acknowledged_at: number | null;
}

// ---------------------------------------------------------------------------
// Row mapper (snake_case -> camelCase with JSON parse)
// ---------------------------------------------------------------------------

function rowToEntry(row: DeliveryMirrorDbRow): DeliveryMirrorEntry {
  return {
    id: row.id,
    sessionKey: row.session_key,
    text: row.text,
    mediaUrls: JSON.parse(row.media_urls) as string[],
    channelType: row.channel_type,
    channelId: row.channel_id,
    origin: row.origin,
    idempotencyKey: row.idempotency_key,
    status: row.status as DeliveryMirrorEntry["status"],
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SQLite-backed DeliveryMirrorPort.
 *
 * Assumes `initSchema()` has already been called (delivery_mirror table exists).
 * Prepares fixed SQL statements once for performance.
 *
 * @param db - An open better-sqlite3 Database instance
 * @returns DeliveryMirrorPort implementation (frozen)
 */
export function createSqliteDeliveryMirror(db: Database.Database): DeliveryMirrorPort {
  // --- Prepared statements ---

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO delivery_mirror (
      id, session_key, text, media_urls, channel_type, channel_id,
      origin, idempotency_key, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);

  const pendingStmt = db.prepare(`
    SELECT * FROM delivery_mirror
    WHERE session_key = ? AND status = 'pending'
    ORDER BY created_at ASC
  `);

  const ackStmt = db.prepare(`
    UPDATE delivery_mirror
    SET status = 'acknowledged', acknowledged_at = ?
    WHERE id = ?
  `);

  const pruneStmt = db.prepare(`
    DELETE FROM delivery_mirror WHERE created_at < ?
  `);

  // --- Port implementation ---

  const mirror: DeliveryMirrorPort = {
    record(input: DeliveryMirrorRecordInput): Promise<Result<string, Error>> {
      try {
        const id = randomUUID();
        insertStmt.run(
          id,
          input.sessionKey,
          input.text,
          JSON.stringify(input.mediaUrls),
          input.channelType,
          input.channelId,
          input.origin,
          input.idempotencyKey,
          Date.now(),
        );
        return Promise.resolve(ok(id));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    pending(sessionKey: string): Promise<Result<DeliveryMirrorEntry[], Error>> {
      try {
        const rows = pendingStmt.all(sessionKey) as DeliveryMirrorDbRow[];
        return Promise.resolve(ok(rows.map(rowToEntry)));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    acknowledge(ids: string[]): Promise<Result<void, Error>> {
      try {
        const now = Date.now();
        const ackTx = db.transaction((entryIds: string[]) => {
          for (const id of entryIds) {
            ackStmt.run(now, id);
          }
        });
        ackTx(ids);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    pruneOld(maxAgeMs: number): Promise<Result<number, Error>> {
      try {
        const cutoff = Date.now() - maxAgeMs;
        const result = pruneStmt.run(cutoff);
        return Promise.resolve(ok(result.changes));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },
  };

  return Object.freeze(mirror);
}
