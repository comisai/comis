// SPDX-License-Identifier: Apache-2.0
/**
 * createSqliteMsTeamsConversationStore — SQLite persistence for the conversation-id
 * → routing-tuple map, implementing the `@comis/core`
 * {@link MsTeamsConversationStorePort}.
 *
 * Factory-function pattern (modeled on `createSqliteOutwardSendLedger`): prepares
 * fixed SQL statements once in the closure, returns a frozen
 * `MsTeamsConversationStorePort`. Reads go through
 * `createRowMapper(MsTeamsConversationRowSchema)` so a corrupt row degrades to a
 * `Result.err`, never a throw — a single bad row cannot abort a proactive send
 * resolve.
 *
 * WHY THIS STORE: a reply rides the inbound activity's own routing; a PROACTIVE
 * send (cron, heartbeat, an unsolicited notice) has no inbound activity, so it must
 * recover `{serviceUrl, tenantId, threadId}` from a durable map keyed by the
 * conversation id. This store is that map, refreshed on every inbound activity so
 * the freshest routing tuple is always on hand.
 *
 * KEY + BOUNDED GROWTH: `key = sha256(conversationId)` is the fixed-width PK.
 * `capture` is an upsert (`ON CONFLICT(key) DO UPDATE`) that refreshes the routing
 * tuple + `updated_at_ms`; it then runs a TTL prune (drop rows older than
 * {@link TTL_MS}) and a cap eviction (keep the {@link CAP} most-recently-updated),
 * so the table cannot grow unbounded no matter how many conversations are seen.
 *
 * SECURITY: the persisted columns carry ROUTING only (`service_url`, `tenant_id`,
 * `conversation_id`, `thread_id`) — there is no credential column and no
 * message-content column. A stored `service_url` stays untrusted at read: the send
 * path re-validates it against the host allowlist before use.
 *
 * @module
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import {
  systemNowMs,
  type MsTeamsConversationStorePort,
  type ConversationReference,
} from "@comis/core";
import { createRowMapper } from "./row-mapper.js";
import {
  MsTeamsConversationRowSchema,
  type MsTeamsConversationRow,
} from "./msteams-conversation-row-schema.js";

// ---------------------------------------------------------------------------
// Bounded-growth constants (internal — not config keys)
// ---------------------------------------------------------------------------

/**
 * The hard row cap. On every capture the store keeps the {@link CAP}
 * most-recently-updated rows and evicts the oldest, so the table is bounded
 * regardless of how many distinct conversations are seen.
 */
const CAP = 1000;

/**
 * The reference time-to-live (ms). On every capture the store prunes rows whose
 * `updated_at_ms` is older than now − {@link TTL_MS} (365 days), so a conversation
 * that has gone silent for a year is dropped rather than kept forever.
 */
const TTL_MS = 365 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Row mapper (snake_case -> camelCase)
// ---------------------------------------------------------------------------

const conversationRowMapper = createRowMapper(MsTeamsConversationRowSchema);

/**
 * Map a validated DB row to the domain {@link ConversationReference}. The nullable
 * `thread_id` maps `?? undefined` at the domain boundary (SQLite NULL ≠ undefined),
 * so an unthreaded chat surfaces as "field absent" on the optional `threadId`.
 */
function rowToRef(row: MsTeamsConversationRow): ConversationReference {
  return {
    conversationId: row.conversation_id,
    serviceUrl: row.service_url,
    tenantId: row.tenant_id,
    ...(row.thread_id !== null ? { threadId: row.thread_id } : {}),
    updatedAt: row.updated_at_ms,
  };
}

/** The fixed-width PK: sha256 hex of the conversation id. */
function conversationKey(conversationId: string): string {
  return createHash("sha256").update(conversationId).digest("hex");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SQLite-backed `MsTeamsConversationStorePort`.
 *
 * Assumes `initSchema()` (which calls `ensureMsTeamsConversationTable`) has already
 * been called — the `msteams_conversation_refs` table + its `updated_at_ms` index
 * exist. Prepares fixed SQL once.
 *
 * @param db - An open better-sqlite3 Database instance
 * @param nowMs - Optional injectable wall-clock (deterministic tests); defaults to systemNowMs. Used only for the TTL prune boundary.
 * @returns MsTeamsConversationStorePort implementation (frozen)
 */
export function createSqliteMsTeamsConversationStore(
  db: Database.Database,
  nowMs: () => number = systemNowMs,
): MsTeamsConversationStorePort {
  // --- Prepared statements ---

  // Upsert: refresh the routing tuple + updated_at_ms for an existing
  // conversation, insert it otherwise. The stored updated_at_ms is the reference's
  // own timestamp (round-tripped by get), NOT nowMs.
  const upsertStmt = db.prepare(`
    INSERT INTO msteams_conversation_refs (
      key, conversation_id, service_url, tenant_id, thread_id, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      service_url   = excluded.service_url,
      tenant_id     = excluded.tenant_id,
      thread_id     = excluded.thread_id,
      updated_at_ms = excluded.updated_at_ms
  `);

  // TTL prune — drop everything older than now − TTL_MS.
  const pruneStmt = db.prepare(
    `DELETE FROM msteams_conversation_refs WHERE updated_at_ms < ?`,
  );

  // Cap eviction — keep only the CAP most-recently-updated rows, delete the rest
  // (the oldest by updated_at_ms).
  const capEvictStmt = db.prepare(`
    DELETE FROM msteams_conversation_refs
    WHERE key NOT IN (
      SELECT key FROM msteams_conversation_refs ORDER BY updated_at_ms DESC LIMIT ?
    )
  `);

  const getStmt = db.prepare(`SELECT * FROM msteams_conversation_refs WHERE key = ?`);

  // --- Store implementation ---

  const store: MsTeamsConversationStorePort = {
    capture(reference: ConversationReference): Promise<Result<void, Error>> {
      try {
        upsertStmt.run(
          conversationKey(reference.conversationId),
          reference.conversationId,
          reference.serviceUrl,
          reference.tenantId,
          reference.threadId ?? null,
          reference.updatedAt,
        );
        // Bound the table on every capture: prune expired rows, then cap growth.
        pruneStmt.run(nowMs() - TTL_MS);
        capEvictStmt.run(CAP);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    get(conversationId: string): Promise<Result<ConversationReference | undefined, Error>> {
      try {
        const parsed = conversationRowMapper.parseOptionalRow(
          getStmt.get(conversationKey(conversationId)),
        );
        if (!parsed.ok) {
          return Promise.resolve(err(new Error(`Row validation failed: ${parsed.error.message}`)));
        }
        if (parsed.value === undefined) return Promise.resolve(ok(undefined));
        return Promise.resolve(ok(rowToRef(parsed.value)));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },
  };

  return Object.freeze(store);
}
